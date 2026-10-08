/**
 * Cliente para APIs compatíveis com o formato “chat completions” da OpenAI:
 * OpenAI, OpenRouter, DeepSeek, Groq, Together, Mistral, Ollama, LM Studio…
 * Usa streaming (SSE) para não estourar timeouts em respostas longas.
 */
import type { LLMClient, LLMRequest, LLMResponse } from "./types";
import { CREDIT_RE, ProviderError } from "./types";

export class OpenAICompatibleClient implements LLMClient {
  readonly providerId = "openai";
  private baseUrl: string;

  constructor(
    readonly model: string,
    private readonly analysisModel: string,
    private readonly apiKey: string,
    baseUrl?: string,
    private readonly jsonMode: "none" | "json_object" | "json_schema" = "none",
  ) {
    this.baseUrl = (baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  }

  private get isOpenAI() {
    return this.baseUrl.startsWith("https://api.openai.com");
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const model = req.purpose === "analysis" ? this.analysisModel : this.model;
    const body: Record<string, unknown> = {
      model,
      stream: true,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
    };
    body[this.isOpenAI ? "max_completion_tokens" : "max_tokens"] = req.maxTokens;
    if (this.isOpenAI) body.stream_options = { include_usage: true };
    if (req.json && this.jsonMode === "json_object") body.response_format = { type: "json_object" };
    if (req.json && this.jsonMode === "json_schema") {
      body.response_format = { type: "json_schema", json_schema: { name: req.json.name, schema: req.json.schema, strict: true } };
    }

    let res: Response | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: req.signal,
        });
      } catch (err) {
        if (req.signal?.aborted) throw err;
        if (attempt < 4) {
          await wait(2000 * 2 ** attempt, req.signal);
          continue;
        }
        throw new ProviderError("Falha de conexão com o provedor de IA.", { fatal: false, cause: err });
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt, req.signal);
        continue;
      }
      break;
    }

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError("A chave do provedor foi recusada. Verifique OPENAI_API_KEY.", { fatal: true });
      }
      if (res.status === 404) throw new ProviderError(`Modelo ou endereço não encontrado (${model}).`, { fatal: true });
      if (res.status === 402 || CREDIT_RE.test(detail)) {
        throw new ProviderError("O provedor informou falta de créditos. O progresso foi salvo — adicione créditos e toque em “Continuar tradução”.", {
          fatal: true,
          code: "credits",
        });
      }
      throw new ProviderError(`O provedor respondeu com erro ${res.status}: ${detail.slice(0, 300)}`, { fatal: res.status === 400 });
    }

    let text = "";
    let finish = "";
    let usage = { inputTokens: 0, outputTokens: 0 };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const json = JSON.parse(data);
          const choice = json.choices?.[0];
          if (choice?.delta?.content) text += choice.delta.content;
          if (choice?.finish_reason) finish = choice.finish_reason;
          if (json.usage) usage = { inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 };
          if (json.error) throw new ProviderError(`Erro do provedor: ${json.error.message ?? "desconhecido"}`, { fatal: false });
        } catch (err) {
          if (err instanceof ProviderError) throw err;
          /* linha incompleta: ignora */
        }
      }
    }

    // modelos de “raciocínio” às vezes incluem <think>…</think> no texto
    text = text.replace(/<think>[\s\S]*?<\/think>/g, "");
    return {
      text,
      stopReason: finish === "length" ? "max_tokens" : finish === "content_filter" ? "refusal" : finish === "stop" || !finish ? "end" : "other",
      usage,
    };
  }
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}
