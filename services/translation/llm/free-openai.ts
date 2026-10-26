/**
 * Cliente para serviços GRATUITOS no formato “chat completions” (Groq,
 * Cloudflare Workers AI, Mistral no modo Free).
 *
 * Regras de custo (iguais às do Gemini):
 *  - nunca troca de serviço nem usa nada pago;
 *  - limite por minuto: espera o tempo pedido pela API e tenta de novo (no máximo
 *    2 vezes; servidor fora do ar, 1 vez) — o rodízio passa a outro serviço gratuito
 *    em vez de ficar esperando aqui. Pedido de espera longa (Retry-After acima de
 *    2 min): não tenta de novo agora (o serviço descansa até a hora pedida);
 *  - a vaga na fila do serviço (limitador) vale só durante cada tentativa: nas
 *    esperas entre uma e outra, outro livro pode usar o serviço;
 *  - limite diário (ou do mês) esgotado: para com o código "quota" e a hora em que volta;
 *  - pedido grande demais para o limite gratuito: devolve "max_tokens" para o
 *    processador dividir o lote ao meio (sem erro para a pessoa);
 *  - JSON inválido no modo JSON (Groq, 400 json_validate_failed): repete uma vez sem
 *    o modo JSON (o próprio pedido já pede JSON no texto).
 *
 * Cada serviço tem o seu jeito de avisar os limites: `classifyError` lê os códigos
 * próprios dele (ex.: Cloudflare 3036 = cota do dia, 3040 = sem capacidade agora).
 */
import type { LLMClient, LLMRequest, LLMResponse } from "./types";
import { ProviderError } from "./types";
import { readChatStream } from "./openai-compatible";
import { sleep } from "@/utils/async";
import { nextMonthUtc, nextUtcMidnight } from "@/services/quota/usage";

/**
 * Vaga na fila de um serviço gratuito (services/providers/limiter.ts): pega antes de
 * cada tentativa e devolve ao terminar a tentativa, com os tokens usados.
 */
export type Gate = (signal: AbortSignal | undefined, tokens: number) => Promise<(usedTokens?: number) => void>;

/** O que deu errado, lido do corpo e dos cabeçalhos da resposta. */
export interface FreeErrorInfo {
  status: number;
  message: string;
  /** código interno do serviço, quando há (ex.: 3036 na Cloudflare) */
  code?: number | string;
  retryAfter?: string | null;
}

export type FreeErrorClass =
  /** cota do dia/mês: para até `retryAt` (outro serviço continua) */
  | { kind: "quota"; retryAt?: number; message?: string }
  /** limite passageiro (por minuto, sem capacidade agora): espera e tenta de novo */
  | { kind: "rate"; retryMs?: number }
  | { kind: "model"; message: string }
  | { kind: "auth"; message: string };

export interface FreeServiceOptions {
  /** nome mostrado nas mensagens (“Groq”, “Cloudflare Workers AI”) */
  label: string;
  baseUrl: string;
  /** teto de tokens de saída por pedido no nível gratuito (sempre enviado: a Cloudflare usa 256 se faltar) */
  maxOutputTokens: number;
  headers?: Record<string, string>;
  /** novas tentativas depois de um limite por minuto (padrão 2) */
  maxRateRetries?: number;
  /** novas tentativas com o servidor fora do ar (padrão 1) */
  maxServerRetries?: number;
  /** vaga na fila do serviço, pega antes de cada tentativa (limitador) */
  gate?: Gate;
  /** os cabeçalhos x-ratelimit-*-requests contam pedidos por DIA (Groq) */
  dailyRequestHeaders?: boolean;
  /** campos extras no pedido (ex.: reasoning_effort: "low" no GPT-OSS) */
  extraBody?: Record<string, unknown>;
  /** temperatura (modelos sem raciocínio: 0.3, para não “inventar” estilo) */
  temperature?: number;
  /** pede JSON com response_format nas análises (padrão: sim) */
  jsonMode?: boolean;
  /** pede o uso de tokens no fim do streaming (stream_options.include_usage) */
  streamUsage?: boolean;
  /** códigos de erro próprios do serviço */
  classifyError?: (info: FreeErrorInfo, model: string) => FreeErrorClass | undefined;
  /**
   * Limite por minuto que não passou depois das esperas: "quota" (Groq: o serviço
   * descansa até a hora informada) ou "rate_limit" (erro passageiro: o processador tenta de novo).
   */
  rateFallback?: "quota" | "rate_limit";
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

/**
 * Tira o raciocínio que alguns modelos escrevem no texto: blocos <think>…</think>,
 * um <think> que nunca fechou (resposta cortada) e o que vem antes de um </think> solto.
 */
export function stripReasoning(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const open = out.indexOf("<think>");
  if (open >= 0) out = out.slice(0, open);
  const close = out.lastIndexOf("</think>");
  if (close >= 0) out = out.slice(close + "</think>".length);
  return out;
}

/** Retry-After em segundos (ms), quando o serviço manda. */
function retryAfterMs(header?: string | null): number | undefined {
  const v = Number(header);
  return Number.isFinite(v) && v > 0 ? Math.ceil(v * 1000) : undefined;
}

/**
 * Cloudflare Workers AI (página oficial de erros): 429 + 3036 = cota grátis do dia
 * (10.000 Neurons) usada, volta à meia-noite UTC; 429 + 3040 = sem capacidade
 * agora (passageiro); 403 + 5035 = o modelo exige o plano pago (nunca pagamos).
 */
export function cloudflareError(e: FreeErrorInfo, model: string): FreeErrorClass | undefined {
  const code = Number(e.code);
  if (e.status === 429 && (code === 3036 || /daily free allocation|10,000 neurons/i.test(e.message))) {
    return {
      kind: "quota",
      retryAt: nextUtcMidnight(),
      message: "A cota grátis de hoje da Cloudflare acabou. Ela volta à meia-noite UTC (21h em Brasília) — ou outro serviço gratuito continua.",
    };
  }
  if (e.status === 429 && (code === 3040 || /capacity temporarily exceeded/i.test(e.message)))
    return { kind: "rate", retryMs: retryAfterMs(e.retryAfter) };
  if (e.status === 403 && (code === 5035 || /requires a workers paid plan/i.test(e.message))) {
    return {
      kind: "model",
      message: `O modelo “${model}” exige o plano pago da Cloudflare. Escolha outro modelo em Ajustes (o Verso nunca liga planos pagos).`,
    };
  }
  // outro 429 (pedidos por minuto): passageiro
  if (e.status === 429) return { kind: "rate", retryMs: retryAfterMs(e.retryAfter) };
  return undefined;
}

/**
 * Mistral (glossário de erros oficial): 429 = limite da conta (por segundo, por
 * minuto ou pedidos simultâneos), com Retry-After; 402 = o uso incluído no mês
 * acabou (o modo Free nunca cobra), volta no dia 1º; 403 = modelo fora do plano.
 */
export function mistralError(e: FreeErrorInfo, model: string): FreeErrorClass | undefined {
  if (e.status === 402) {
    return {
      kind: "quota",
      retryAt: nextMonthUtc(),
      message: "A cota do mês do modo Free da Mistral acabou. Ela volta no dia 1º — ou outro serviço gratuito continua.",
    };
  }
  if (e.status === 429) return { kind: "rate", retryMs: retryAfterMs(e.retryAfter) };
  if (e.status === 403) return { kind: "model", message: `O modelo “${model}” não está liberado no modo Free da Mistral. Escolha outro em Ajustes.` };
  return undefined;
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
    const body: Record<string, unknown> = {
      model: this.model,
      stream: true,
      max_tokens: Math.min(req.maxTokens, this.opts.maxOutputTokens),
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      ...this.opts.extraBody,
    };
    if (this.opts.temperature !== undefined) body.temperature = this.opts.temperature;
    if (this.opts.streamUsage) body.stream_options = { include_usage: true };
    if (req.json && this.opts.jsonMode !== false) body.response_format = { type: "json_object" };

    // estimativa de tokens (entrada + uma saída do mesmo tamanho), só para o limite por minuto
    const estimate = Math.ceil((req.system.length + req.user.length) / 3.5) * 2;
    const tries = { rate: 0, server: 0 };
    for (;;) {
      // a vaga na fila do serviço vale só durante a tentativa (nunca durante a espera)
      const release = this.opts.gate ? await this.opts.gate(req.signal, estimate) : undefined;
      let used = 0;
      let step: Step;
      try {
        step = await this.attempt(req, body, tries);
        if ("response" in step) used = step.response.usage.inputTokens + step.response.usage.outputTokens || estimate;
        else if (step.spent) used = estimate;
      } finally {
        release?.(used);
      }
      if ("response" in step) return step.response;
      if (step.wait > 0) {
        req.onWait?.(step.wait);
        await sleep(step.wait, req.signal);
      }
    }
  }

  /** Uma tentativa: a resposta, ou quanto esperar antes da próxima (`spent`: o pedido gastou cota mesmo falhando). */
  private async attempt(req: LLMRequest, body: Record<string, unknown>, tries: { rate: number; server: number }): Promise<Step> {
    const { label } = this.opts;
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
      out.text = stripReasoning(out.text);
      const remaining = Number(res.headers.get("x-ratelimit-remaining-requests"));
      const limit = Number(res.headers.get("x-ratelimit-limit-requests"));
      if (this.opts.dailyRequestHeaders && Number.isFinite(remaining) && limit > 0) out.rateLimit = { remaining, limit };
      return { response: out };
    }

    const text = await res.text().catch(() => "");
    let message = text.slice(0, 500);
    let code: number | string | undefined;
    try {
      // { error: { message, code } } (OpenAI, Groq, Mistral) ou { errors: [{ code, message }] } (Cloudflare)
      const parsed = JSON.parse(text) as {
        error?: { message?: string; code?: number | string } | string;
        errors?: { code?: number | string; message?: string }[];
        message?: string;
        code?: number | string;
      };
      const first = parsed.errors?.[0];
      message = (typeof parsed.error === "string" ? parsed.error : parsed.error?.message) ?? first?.message ?? parsed.message ?? message;
      code = (typeof parsed.error === "object" ? parsed.error?.code : undefined) ?? first?.code ?? parsed.code;
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
      return { response: { text: "", stopReason: "max_tokens", usage: { inputTokens: 0, outputTokens: 0 } } };
    }

    // o modelo não conseguiu escrever um JSON válido no modo JSON (Groq): uma vez de novo, sem o modo
    // JSON — o pedido já pede JSON no texto, e a resposta é conferida do mesmo jeito
    if (
      res.status === 400 &&
      body.response_format &&
      (code === "json_validate_failed" || /json_validate_failed|failed to generate json/i.test(message))
    ) {
      console.info(`[${this.providerId}] JSON inválido no modo JSON; repetindo sem o modo JSON`);
      delete body.response_format;
      return { wait: 0, spent: true };
    }

    // códigos próprios do serviço (cota do dia ou do mês, sem capacidade agora, modelo pago)
    const special = this.opts.classifyError?.({ status: res.status, message, code, retryAfter: res.headers.get("retry-after") }, this.model);
    if (special?.kind === "quota") {
      throw new ProviderError(special.message ?? freeLimitMessage(label), { fatal: true, code: "quota", retryAt: special.retryAt });
    }
    if (special?.kind === "model" || special?.kind === "auth") throw new ProviderError(special.message, { fatal: true, code: special.kind });

    if (res.status === 429 || special?.kind === "rate") {
      const q = special?.kind === "rate" ? { daily: false, retryMs: special.retryMs } : parseLimit(message, res.headers.get("retry-after"));
      // espera longa pedida pelo serviço: não adianta esperar aqui (outro serviço gratuito continua)
      const long = (q.retryMs ?? 0) > MAX_CLIENT_WAIT_MS;
      if (!q.daily && !long && tries.rate < (this.opts.maxRateRetries ?? 2)) {
        tries.rate++;
        const wait = Math.min(q.retryMs ?? 20_000 * tries.rate, MAX_CLIENT_WAIT_MS) + 500;
        console.info(`[${this.providerId}] limite por minuto atingido; aguardando ${Math.round(wait / 1000)}s (tentativa ${tries.rate})`);
        return { wait };
      }
      if (!q.daily && this.opts.rateFallback === "rate_limit") {
        // passageiro: o processador espera e tenta de novo; se não passar, outro serviço continua.
        // Com uma espera longa pedida (Retry-After), não tenta de novo agora: o serviço descansa até a hora
        throw new ProviderError(`O ${label} está recebendo pedidos demais agora. Tentando de novo em instantes.`, {
          fatal: long,
          code: "rate_limit",
          retryAt: retryAtOf(q),
        });
      }
      throw new ProviderError(freeLimitMessage(label), { fatal: true, code: "quota", retryAt: retryAtOf(q) });
    }
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError(`A chave do ${label} foi recusada ou não tem acesso a este modelo. Confira em Ajustes.`, {
        fatal: true,
        code: "auth",
      });
    }
    if (res.status === 402) {
      // pedido de pagamento: a conta (ou o modelo) exige um plano pago — o Verso nunca liga planos pagos
      throw new ProviderError(`O ${label} pediu um plano pago para continuar (o Verso nunca liga planos pagos). Confira a conta em Ajustes.`, {
        fatal: true,
        code: "model",
      });
    }
    if (res.status === 404) {
      throw new ProviderError(`O modelo “${this.model}” não está disponível no ${label}. Escolha outro em Ajustes.`, {
        fatal: true,
        code: "model",
      });
    }
    if (res.status >= 500 && tries.server < (this.opts.maxServerRetries ?? 1)) {
      tries.server++;
      const wait = 15_000 * tries.server;
      console.info(`[${this.providerId}] serviço instável (${res.status}); aguardando ${wait / 1000}s`);
      return { wait };
    }
    // 400: recusado só este pedido (não é da conta: o serviço continua valendo para os outros livros)
    throw new ProviderError(`O ${label} respondeu com erro ${res.status}: ${message}`, {
      fatal: res.status === 400,
      code: res.status >= 500 ? "server" : "bad_request",
    });
  }
}

/** Resultado de uma tentativa. */
type Step = { response: LLMResponse } | { wait: number; spent?: boolean };

/** Espera mais longa que um cliente faz antes de tentar de novo (acima disso, o serviço descansa e outro continua). */
const MAX_CLIENT_WAIT_MS = 120_000;

function retryAtOf(q: LimitInfo): number | undefined {
  return q.retryMs ? Date.now() + q.retryMs : undefined;
}
