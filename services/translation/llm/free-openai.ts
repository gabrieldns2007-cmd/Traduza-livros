/**
 * Cliente para serviços GRATUITOS no formato “chat completions” (GitHub Models, Groq).
 *
 * Regras de custo (iguais às do Gemini):
 *  - nunca troca de serviço nem usa nada pago;
 *  - limite por minuto: espera o tempo pedido pela API e tenta de novo (poucas vezes);
 *  - limite diário esgotado: para com o código "quota" e a tradução fica pausada;
 *  - pedido grande demais para o limite gratuito: devolve "max_tokens" para o
 *    processador dividir o lote ao meio (sem erro para a pessoa).
 */
import type { LLMClient, LLMRequest, LLMResponse } from "./types";
import { ProviderError } from "./types";
import { readChatStream } from "./openai-compatible";
import { sleep } from "@/utils/async";

export interface FreeServiceOptions {
  /** nome mostrado nas mensagens (“GitHub Models”, “Groq”) */
  label: string;
  baseUrl: string;
  /** teto de tokens de saída por pedido no nível gratuito */
  maxOutputTokens: number;
  headers?: Record<string, string>;
  maxRateRetries?: number;
  /** os cabeçalhos x-ratelimit-*-requests contam pedidos por DIA (Groq) */
  dailyRequestHeaders?: boolean;
}

export interface LimitInfo {
  /** limite diário (ou de janela longa) — esperar alguns segundos não resolve */
  daily: boolean;
  /** espera sugerida pela API, em ms */
  retryMs?: number;
}

/** Lê uma mensagem de limite (429/413) para saber se é por minuto ou por dia, e quanto esperar. */
export function parseLimit(message: string, retryAfterHeader?: string | null): LimitInfo {
  const daily = /per day|\bTPD\b|\bRPD\b|ByDay|86400\s*s|daily/i.test(message);
  let retryMs: number | undefined;
  const header = Number(retryAfterHeader);
  if (Number.isFinite(header) && header > 0) retryMs = header * 1000;
  // Groq: “Please try again in 1h2m3.5s” / “in 14m24s” / “in 7.66s”
  const groq = /try again in\s+((?:\d+h)?(?:\d+m)?(?:[\d.]+s)?|[\d.]+ms)/i.exec(message);
  if (groq && groq[1]) {
    const t = groq[1];
    if (/ms$/.test(t)) retryMs = Number.parseFloat(t);
    else {
      const h = /(\d+)h/.exec(t)?.[1];
      const m = /(\d+)m(?!s)/.exec(t)?.[1];
      const s = /([\d.]+)s/.exec(t)?.[1];
      retryMs = ((Number(h) || 0) * 3600 + (Number(m) || 0) * 60 + (Number(s) || 0)) * 1000;
    }
  }
  // GitHub Models: “Please wait 39 seconds before retrying.”
  const gh = /wait\s+(\d+)\s*seconds/i.exec(message);
  if (gh) retryMs = Number(gh[1]) * 1000;
  return { daily, retryMs: retryMs ? Math.ceil(retryMs) : undefined };
}

export function freeLimitMessage(label: string) {
  return `Limite gratuito do ${label} atingido. A tradução pode ser continuada quando a cota estiver disponível — ou com outro serviço gratuito.`;
}

export class FreeOpenAIClient implements LLMClient {
  private readonly baseUrl: string;

  constructor(
    readonly providerId: string,
    readonly model: string,
    private readonly apiKey: string,
    private readonly opts: FreeServiceOptions,
  ) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const { label } = this.opts;
    const body: Record<string, unknown> = {
      model: this.model,
      stream: true,
      max_tokens: Math.min(req.maxTokens, this.opts.maxOutputTokens),
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
    };
    if (req.json) body.response_format = { type: "json_object" };

    const maxRateRetries = this.opts.maxRateRetries ?? 4;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}`, ...this.opts.headers },
          body: JSON.stringify(body),
          signal: req.signal,
        });
      } catch (err) {
        if (req.signal?.aborted) throw err;
        throw new ProviderError(`Falha de conexão com o ${label}.`, { fatal: false, cause: err, code: "network" });
      }

      if (res.ok && res.body) {
        const out = await readChatStream(res.body);
        const remaining = Number(res.headers.get("x-ratelimit-remaining-requests"));
        const limit = Number(res.headers.get("x-ratelimit-limit-requests"));
        if (this.opts.dailyRequestHeaders && Number.isFinite(remaining) && limit > 0) out.rateLimit = { remaining, limit };
        return out;
      }

      const text = await res.text().catch(() => "");
      let message = text.slice(0, 500);
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
        message = (typeof parsed.error === "string" ? parsed.error : parsed.error?.message) ?? parsed.message ?? message;
      } catch {
        /* corpo não-JSON */
      }

      // pedido maior que o permitido no nível gratuito: o processador divide o lote
      if (
        res.status === 413 ||
        (res.status === 400 && /too large|max size|maximum context|context length|tokens? limit|reduce the length/i.test(message))
      ) {
        if (/per day|\bTPD\b|ByDay/i.test(message)) {
          throw new ProviderError(freeLimitMessage(label), { fatal: true, code: "quota", retryAt: retryAtOf(parseLimit(message)) });
        }
        console.info(`[${this.providerId}] pedido grande demais para o nível gratuito; dividindo o lote`);
        return { text: "", stopReason: "max_tokens", usage: { inputTokens: 0, outputTokens: 0 } };
      }

      if (res.status === 429) {
        const q = parseLimit(message, res.headers.get("retry-after"));
        if (!q.daily && attempt < maxRateRetries && (q.retryMs ?? 0) <= 120_000) {
          const wait = Math.min(q.retryMs ?? 20_000 * (attempt + 1), 120_000) + 500;
          console.info(`[${this.providerId}] limite por minuto atingido; aguardando ${Math.round(wait / 1000)}s (tentativa ${attempt + 1})`);
          req.onWait?.(wait);
          await sleep(wait, req.signal);
          continue;
        }
        throw new ProviderError(freeLimitMessage(label), { fatal: true, code: "quota", retryAt: retryAtOf(q) });
      }
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError(`A chave do ${label} foi recusada ou não tem acesso a este modelo. Confira em Ajustes.`, {
          fatal: true,
          code: "auth",
        });
      }
      if (res.status === 404) {
        throw new ProviderError(`O modelo “${this.model}” não está disponível no ${label}. Escolha outro em Ajustes.`, {
          fatal: true,
          code: "model",
        });
      }
      if (res.status >= 500 && attempt < 3) {
        const wait = 15_000 * (attempt + 1);
        console.info(`[${this.providerId}] serviço instável (${res.status}); aguardando ${wait / 1000}s`);
        req.onWait?.(wait);
        await sleep(wait, req.signal);
        continue;
      }
      throw new ProviderError(`O ${label} respondeu com erro ${res.status}: ${message}`, {
        fatal: res.status === 400 || res.status === 402,
        code: res.status >= 500 ? "server" : "bad_request",
      });
    }
  }
}

function retryAtOf(q: LimitInfo): number | undefined {
  return q.retryMs ? Date.now() + q.retryMs : undefined;
}
