/**
 * Cliente da API Gemini (Google AI Studio) — usado no nível GRATUITO.
 *
 * Regras de custo:
 *  - nunca liga billing nem troca de provedor;
 *  - limite por minuto: espera o tempo indicado pela API e tenta de novo (poucas vezes);
 *  - limite diário/gratuito esgotado: para com o código "quota", e a tradução fica pausada.
 *
 * Usa a API REST com streaming (SSE) para não estourar timeouts em respostas longas.
 */
import type { LLMClient, LLMRequest, LLMResponse } from "./types";
import { CREDIT_RE, ProviderError } from "./types";
import { sleep } from "@/utils/async";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Nível de raciocínio nos pedidos de TRADUÇÃO (opcional): GEMINI_THINKING_LEVEL=minimal|low|medium|high.
 * O raciocínio é cobrado como saída e conta na cota; sem a variável, vale o padrão do modelo
 * (nada muda). Teste a qualidade num trecho antes de baixar.
 */
export function geminiThinkingLevel(purpose: LLMRequest["purpose"], env = process.env.GEMINI_THINKING_LEVEL): string | undefined {
  if (purpose !== "translation") return undefined;
  const v = env?.trim().toLowerCase();
  return v === "minimal" || v === "low" || v === "medium" || v === "high" ? v : undefined;
}

interface GeminiErrorBody {
  error?: { code?: number; status?: string; message?: string; details?: Array<Record<string, unknown>> };
}

export interface QuotaInfo {
  /** limite diário (ou de cota gratuita) esgotado — esperar não resolve hoje */
  daily: boolean;
  /** espera sugerida pela API, em ms */
  retryMs?: number;
}

/** Lê os detalhes de um erro 429 do Google para saber se é limite por minuto ou por dia. */
export function parseQuota(body: GeminiErrorBody): QuotaInfo {
  const details = body.error?.details ?? [];
  let daily = false;
  let retryMs: number | undefined;
  for (const d of details) {
    const type = String(d["@type"] ?? "");
    if (type.endsWith("QuotaFailure")) {
      const violations = (d.violations as Array<{ quotaId?: string; quotaMetric?: string }> | undefined) ?? [];
      if (violations.some((v) => /PerDay|per_day|daily/i.test(`${v.quotaId ?? ""} ${v.quotaMetric ?? ""}`))) daily = true;
    }
    if (type.endsWith("RetryInfo")) {
      const m = /^(\d+(?:\.\d+)?)s$/.exec(String(d.retryDelay ?? ""));
      if (m) retryMs = Math.ceil(Number(m[1]) * 1000);
    }
  }
  if (/per day|daily|free_tier_requests.*day/i.test(body.error?.message ?? "")) daily = true;
  return { daily, retryMs };
}

/** A cota diária do Gemini volta à meia-noite do horário do Pacífico. */
export function nextPacificMidnight(now = Date.now()): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour12: false,
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  const elapsed = ((Number(parts.hour) % 24) * 3600 + Number(parts.minute) * 60 + Number(parts.second)) * 1000;
  return now - elapsed + 24 * 3600 * 1000;
}

export const FREE_LIMIT_MESSAGE = "Limite gratuito atingido. A tradução pode ser continuada quando a cota estiver disponível.";

export class GeminiClient implements LLMClient {
  readonly providerId = "gemini";

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly maxRateRetries = 4,
  ) {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const thinkingLevel = geminiThinkingLevel(req.purpose);
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.user }] }],
      generationConfig: {
        maxOutputTokens: Math.min(req.maxTokens, 65536),
        ...(req.json ? { responseMimeType: "application/json" } : {}),
        ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
      },
    };

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${BASE}/models/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
          body: JSON.stringify(body),
          signal: req.signal,
        });
      } catch (err) {
        if (req.signal?.aborted) throw err;
        throw new ProviderError("Falha de conexão com o Google (Gemini).", { fatal: false, cause: err, code: "network" });
      }

      if (res.ok && res.body) return this.readStream(res.body);

      const text = await res.text().catch(() => "");
      let parsed: GeminiErrorBody = {};
      try {
        parsed = JSON.parse(text) as GeminiErrorBody;
      } catch {
        /* corpo não-JSON */
      }
      const message = parsed.error?.message ?? text.slice(0, 300);

      if (res.status === 429) {
        const q = parseQuota(parsed);
        // limite por minuto: espera o que a API pede e tenta de novo
        if (!q.daily && attempt < this.maxRateRetries) {
          const wait = Math.min(q.retryMs ?? 20_000 * (attempt + 1), 120_000) + 500;
          console.info(`[gemini] limite por minuto atingido; aguardando ${Math.round(wait / 1000)}s (tentativa ${attempt + 1})`);
          req.onWait?.(wait);
          await sleep(wait, req.signal);
          continue;
        }
        throw new ProviderError(FREE_LIMIT_MESSAGE, {
          fatal: true,
          code: "quota",
          retryAt: q.daily ? nextPacificMidnight() : Date.now() + (q.retryMs ?? 60_000),
        });
      }
      if (res.status === 400 && /api key not valid|API_KEY_INVALID/i.test(message)) {
        throw new ProviderError("A chave do Gemini foi recusada. Confira a chave em Ajustes.", { fatal: true, code: "auth" });
      }
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError("A chave do Gemini não tem permissão para este modelo. Confira a chave em Ajustes.", { fatal: true, code: "auth" });
      }
      if (res.status === 404) {
        throw new ProviderError(`O modelo “${this.model}” não está disponível para a sua chave.`, { fatal: true, code: "model" });
      }
      if (res.status === 402 || CREDIT_RE.test(message)) {
        throw new ProviderError(FREE_LIMIT_MESSAGE, { fatal: true, code: "quota", retryAt: nextPacificMidnight() });
      }
      if (res.status >= 500 && attempt < 3) {
        const wait = 15_000 * (attempt + 1);
        console.info(`[gemini] serviço sobrecarregado (${res.status}); aguardando ${wait / 1000}s`);
        req.onWait?.(wait);
        await sleep(wait, req.signal);
        continue;
      }
      throw new ProviderError(`O Gemini respondeu com erro ${res.status}: ${message}`, {
        fatal: res.status === 400,
        code: res.status >= 500 ? "server" : "bad_request",
      });
    }
  }

  private async readStream(stream: ReadableStream<Uint8Array>): Promise<LLMResponse> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let finish = "";
    let blocked = false;
    let usage = { inputTokens: 0, outputTokens: 0 };

    const handle = (data: string) => {
      let json: {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
        promptFeedback?: { blockReason?: string };
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
        error?: { message?: string };
      };
      try {
        json = JSON.parse(data);
      } catch {
        return;
      }
      if (json.error) throw new ProviderError(`Erro do Gemini: ${json.error.message ?? "desconhecido"}`, { fatal: false, code: "server" });
      if (json.promptFeedback?.blockReason) blocked = true;
      const cand = json.candidates?.[0];
      for (const part of cand?.content?.parts ?? []) if (part.text && !part.thought) text += part.text;
      if (cand?.finishReason) finish = cand.finishReason;
      if (json.usageMetadata) {
        usage = {
          inputTokens: json.usageMetadata.promptTokenCount ?? 0,
          outputTokens: (json.usageMetadata.candidatesTokenCount ?? 0) + (json.usageMetadata.thoughtsTokenCount ?? 0),
        };
      }
    };

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line.startsWith("data:")) handle(line.slice(5).trim());
      }
    }
    if (buffer.startsWith("data:")) handle(buffer.slice(5).trim());

    const refused = blocked || /SAFETY|PROHIBITED|BLOCKLIST|RECITATION|SPII/i.test(finish);
    return {
      text,
      stopReason: refused ? "refusal" : finish === "MAX_TOKENS" ? "max_tokens" : "end",
      usage,
    };
  }
}
