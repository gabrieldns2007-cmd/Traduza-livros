/**
 * Preços de tabela dos modelos (US$ por milhão de tokens).
 *
 * É a única fonte de preço do produto: estimativas antes de traduzir, custo
 * real de cada execução (BookMeta.runs) e o relatório `npm run custos` usam
 * esta tabela. Ao mudar um preço, atualize `checkedAt`.
 */
export interface ModelPrice {
  input: number;
  output: number;
  /** de onde veio o número */
  source: string;
  checkedAt: string;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  // Anthropic — preços da API (primeira parte)
  "claude-fable-5-1": { input: 10, output: 50, source: "anthropic", checkedAt: "2026-10-06" },
  "claude-opus-5-5": { input: 4, output: 20, source: "anthropic", checkedAt: "2026-10-06" },
  "claude-opus-5": { input: 5, output: 25, source: "anthropic", checkedAt: "2026-10-06" },
  "claude-opus-4-8": { input: 5, output: 25, source: "anthropic", checkedAt: "2026-10-06" },
  "claude-sonnet-5-5": { input: 2, output: 10, source: "anthropic", checkedAt: "2026-10-06" },
  "claude-sonnet-5": { input: 2, output: 10, source: "anthropic", checkedAt: "2026-10-06" },
  "claude-sonnet-4-6": { input: 3, output: 15, source: "anthropic", checkedAt: "2026-10-06" },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, source: "anthropic (prompts até 100 mil tokens)", checkedAt: "2026-10-06" },
  "claude-haiku-4-5": { input: 1, output: 5, source: "anthropic", checkedAt: "2026-10-06" },
  // Google Gemini — nível PAGO (no nível gratuito o custo é zero, mas a cota é pequena)
  "gemini-3.8-flash": { input: 0.75, output: 3.75, source: "rastreador de preços (confirmar em ai.google.dev/pricing)", checkedAt: "2026-10-04" },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5, source: "rastreador de preços (confirmar em ai.google.dev/pricing)", checkedAt: "2026-08-25" },
  // Groq
  "llama-3.3-70b-versatile": { input: 0.59, output: 0.79, source: "rastreador de preços (confirmar em groq.com/pricing)", checkedAt: "2026-06-01" },
  "openai/gpt-oss-120b": { input: 0.15, output: 0.6, source: "rastreador de preços (confirmar em groq.com/pricing)", checkedAt: "2026-08-01" },
};

/** Custo em US$ de um uso real (tokens medidos). null quando o modelo não está na tabela. */
export function usageCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = MODEL_PRICES[model];
  if (!p) return null;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}
