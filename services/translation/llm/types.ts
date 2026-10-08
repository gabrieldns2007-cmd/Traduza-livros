/**
 * Camada de baixo nível: um cliente de modelo de linguagem (LLM) genérico.
 * Os prompts ficam em ../prompts.ts; aqui só existe “mandar texto, receber texto”.
 */

export type Effort = "low" | "medium" | "high";

export interface LLMRequest {
  system: string;
  user: string;
  maxTokens: number;
  /** "analysis" usa o modelo de análise (pode ser mais barato) */
  purpose: "translation" | "analysis";
  /** pede saída em JSON seguindo este schema */
  json?: { name: string; schema: Record<string, unknown> };
  effort?: Effort;
  signal?: AbortSignal;
}

export interface LLMResponse {
  text: string;
  stopReason: "end" | "max_tokens" | "refusal" | "other";
  usage: { inputTokens: number; outputTokens: number };
}

export interface LLMClient {
  readonly providerId: string;
  readonly model: string;
  complete(req: LLMRequest): Promise<LLMResponse>;
}

/**
 * Erro do provedor. `fatal` = não adianta tentar de novo (chave inválida,
 * modelo inexistente, sem créditos). A mensagem é mostrada ao usuário.
 */
export class ProviderError extends Error {
  readonly fatal: boolean;
  constructor(message: string, opts: { fatal: boolean; cause?: unknown }) {
    super(message, { cause: opts.cause });
    this.fatal = opts.fatal;
  }
}

export function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error) || err instanceof ProviderError) return false;
  return err.name === "AbortError" || err.name === "APIUserAbortError" || /\babort/i.test(err.message);
}
