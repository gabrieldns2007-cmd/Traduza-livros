/**
 * Estimativa de custo para provedores PAGOS (mostrada antes de pedir confirmação).
 * É uma faixa aproximada: tokens reais dependem do idioma, do modelo e do raciocínio.
 */
const PRICES: Record<string, { input: number; output: number }> = {
  // US$ por milhão de tokens (tabela de preços da Anthropic)
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export interface CostEstimate {
  low: number;
  high: number;
  known: boolean;
}

/** Estimativa para traduzir `words` palavras (ainda não traduzidas) com o modelo indicado. */
export function estimateCost(model: string, words: number, deepContext: boolean): CostEstimate {
  const price = PRICES[model];
  if (!price || words <= 0) return { low: 0, high: 0, known: Boolean(price) };
  const srcTokens = words * 1.4;
  // entrada: texto + instruções, glossário e contexto (+ releitura do capítulo na leitura atenta)
  const input = srcTokens * (deepContext ? 2.6 : 1.8);
  // saída: tradução (+ raciocínio do modelo, que também é cobrado)
  const outLow = srcTokens * 1.25;
  const outHigh = srcTokens * 2.4;
  const cost = (inp: number, out: number) => (inp * price.input + out * price.output) / 1_000_000;
  return { low: cost(input * 0.8, outLow), high: cost(input * 1.3, outHigh), known: true };
}

export function formatUsd(v: number): string {
  if (v < 0.01) return "menos de US$ 0,01";
  return `US$ ${v.toFixed(2).replace(".", ",")}`;
}
