import Anthropic from "@anthropic-ai/sdk";
import type { LLMClient, LLMRequest, LLMResponse, Effort } from "./types";
import { CREDIT_RE, ProviderError } from "./types";

/** Modelos que aceitam `output_config.effort` e saída estruturada. */
function isModernModel(model: string): boolean {
  return /claude-(opus-4-[5-9]|opus-5|sonnet-4-6|sonnet-5|fable|mythos|haiku-5)/.test(model);
}

export class AnthropicClient implements LLMClient {
  readonly providerId = "anthropic";
  private client: Anthropic;

  constructor(
    readonly model: string,
    private readonly analysisModel: string,
    private readonly effort: Effort,
  ) {
    // O SDK já repete automaticamente erros 408/409/429/5xx com backoff.
    this.client = new Anthropic({ maxRetries: 3, timeout: 20 * 60 * 1000 });
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const model = req.purpose === "analysis" ? this.analysisModel : this.model;
    const modern = isModernModel(model);
    const outputConfig: Anthropic.Beta.Messages.BetaOutputConfig = {};
    if (modern) outputConfig.effort = req.effort ?? this.effort;
    if (modern && req.json) outputConfig.format = { type: "json_schema", schema: req.json.schema };

    try {
      const stream = this.client.beta.messages.stream(
        {
          model,
          max_tokens: req.maxTokens,
          // o prompt de sistema é estável durante todo o livro: vale a pena cachear
          system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: req.user }],
          ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
        },
        { signal: req.signal },
      );
      const message = await stream.finalMessage();
      const text = message.content
        .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      const u = message.usage;
      return {
        text,
        stopReason:
          message.stop_reason === "end_turn" || message.stop_reason === "stop_sequence"
            ? "end"
            : message.stop_reason === "max_tokens"
              ? "max_tokens"
              : message.stop_reason === "refusal"
                ? "refusal"
                : "other",
        usage: {
          inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          outputTokens: u.output_tokens ?? 0,
        },
      };
    } catch (err) {
      throw mapAnthropicError(err, model);
    }
  }
}

function mapAnthropicError(err: unknown, model: string): unknown {
  if (err instanceof Anthropic.APIUserAbortError) return err;
  const message = err instanceof Error ? err.message : String(err);
  // falta de créditos pode vir como 400, 402 ou como evento de erro no meio do streaming
  if (CREDIT_RE.test(message) || (err instanceof Anthropic.APIError && err.status === 402)) {
    return new ProviderError(
      "Sua conta da Anthropic ficou sem créditos. O progresso foi salvo — adicione créditos em console.anthropic.com e toque em “Continuar tradução”.",
      { fatal: true, cause: err, code: "credits" },
    );
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError("A chave da Anthropic foi recusada. Verifique ANTHROPIC_API_KEY no arquivo .env.local.", {
      fatal: true,
      cause: err,
      code: "auth",
    });
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new ProviderError(`O modelo “${model}” não foi encontrado. Verifique ANTHROPIC_MODEL.`, { fatal: true, cause: err, code: "model" });
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new ProviderError(`O provedor recusou o pedido: ${message}`, { fatal: false, cause: err, code: "bad_request" });
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new ProviderError("Limite de uso do provedor atingido.", { fatal: false, cause: err, code: "rate_limit" });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError("Falha de conexão com a Anthropic.", { fatal: false, cause: err, code: "network" });
  }
  if (err instanceof Anthropic.APIError) {
    return new ProviderError(`Erro temporário do provedor (${err.status ?? "?"}).`, { fatal: false, cause: err, code: "server" });
  }
  return err;
}
