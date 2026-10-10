/**
 * Modelo de custo: quantos tokens (e quanto dinheiro) uma tradução consome
 * ANTES de começar.
 *
 *   entrada  = palavras × tokens/palavra (origem) + pedidos × instruções e contexto
 *   saída    = palavras × tokens/palavra (destino) × (1 + raciocínio do modelo)
 *   total    × folga para novas tentativas
 *
 * Os parâmetros por serviço vêm do jeito como o Verso monta os pedidos
 * (tamanho do lote, contexto enviado). São estimativas: o custo REAL de cada
 * execução é medido e guardado em BookMeta.runs, e `npm run custos` compara
 * os dois para recalibrar estes números.
 */
import { MODEL_PRICES } from "./prices";

export interface CostProfile {
  /** palavras de origem por pedido (≈ caracteres do lote ÷ 6) */
  wordsPerRequest: number;
  /** instruções + perfil do livro + glossário + parágrafos anteriores, por pedido */
  overheadTokensPerRequest: number;
  /** tokens por palavra no texto de origem (inglês ≈ 1,35) */
  sourceTokensPerWord: number;
  /** tokens por palavra no texto traduzido (português ≈ 1,6) */
  targetTokensPerWord: number;
  /** raciocínio cobrado como saída, em fração da saída: [esperado, pior caso] */
  thinking: [number, number];
  /** pedidos refeitos (lotes cortados, tags perdidas): [esperado, pior caso] */
  retry: [number, number];
}

const BASE = { sourceTokensPerWord: 1.35, targetTokensPerWord: 1.6 };

export const COST_PROFILES: Record<string, CostProfile> = {
  // lotes grandes (~24 mil caracteres) — pouco contexto repetido
  gemini: { ...BASE, wordsPerRequest: 4000, overheadTokensPerRequest: 1800, thinking: [0.4, 1.2], retry: [0.08, 0.25] },
  // nível gratuito do GitHub: ~8 mil caracteres por pedido
  github: { ...BASE, wordsPerRequest: 1300, overheadTokensPerRequest: 1800, thinking: [0, 0.1], retry: [0.08, 0.25] },
  // Groq: ~5 mil caracteres por pedido
  groq: { ...BASE, wordsPerRequest: 830, overheadTokensPerRequest: 1800, thinking: [0.2, 0.8], retry: [0.08, 0.25] },
  // Anthropic/OpenAI: lotes de ~5 mil caracteres (TRANSLATION_BATCH_CHARS) e raciocínio sempre ligado no Opus 5.5
  anthropic: { ...BASE, wordsPerRequest: 830, overheadTokensPerRequest: 2200, thinking: [0.6, 1.8], retry: [0.08, 0.3] },
  openai: { ...BASE, wordsPerRequest: 830, overheadTokensPerRequest: 2200, thinking: [0.3, 1.2], retry: [0.08, 0.3] },
  demo: { ...BASE, wordsPerRequest: 1300, overheadTokensPerRequest: 0, thinking: [0, 0], retry: [0, 0] },
};

export interface UsageEstimate {
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

/** Tokens estimados para traduzir `words` palavras. `worst` usa o pior caso (raciocínio e refações altos). */
export function estimateUsage(providerId: string, words: number, opts: { deepContext?: boolean; worst?: boolean } = {}): UsageEstimate {
  const p = COST_PROFILES[providerId] ?? COST_PROFILES.anthropic;
  if (words <= 0) return { requests: 0, inputTokens: 0, outputTokens: 0 };
  const i = opts.worst ? 1 : 0;
  const requests = Math.ceil(words / p.wordsPerRequest);
  // leitura atenta: o capítulo é lido de novo numa chamada extra
  const deep = opts.deepContext ? words * p.sourceTokensPerWord + requests * p.overheadTokensPerRequest : 0;
  const input = words * p.sourceTokensPerWord + requests * p.overheadTokensPerRequest + deep;
  const output = words * p.targetTokensPerWord * (1 + p.thinking[i]) + (opts.deepContext ? words * 0.1 : 0);
  const k = 1 + p.retry[i];
  return { requests: Math.ceil(requests * k), inputTokens: Math.round(input * k), outputTokens: Math.round(output * k) };
}

export interface CostEstimate {
  /** custo provável, em US$ */
  expected: number;
  /** pior caso razoável (≈ percentil 90), em US$ — é o que os créditos precisam cobrir */
  worst: number;
  known: boolean;
}

export function estimateCostUsd(providerId: string, model: string, words: number, deepContext = false): CostEstimate {
  const price = MODEL_PRICES[model];
  if (!price || words <= 0) return { expected: 0, worst: 0, known: Boolean(price) };
  const cost = (u: UsageEstimate) => (u.inputTokens * price.input + u.outputTokens * price.output) / 1_000_000;
  return {
    expected: cost(estimateUsage(providerId, words, { deepContext })),
    worst: cost(estimateUsage(providerId, words, { deepContext, worst: true })),
    known: true,
  };
}

/**
 * Custo por mil palavras (US$) — a unidade usada para precificar créditos.
 * Calculado num livro de 100 mil palavras: as instruções de cada pedido se
 * dividem pelas palavras do pedido inteiro (um pedido do Gemini leva ~4 mil),
 * em vez de contar um pedido inteiro a cada mil palavras.
 */
export function costPer1kWords(providerId: string, model: string): CostEstimate {
  const c = estimateCostUsd(providerId, model, 100_000);
  return { expected: c.expected / 100, worst: c.worst / 100, known: c.known };
}
