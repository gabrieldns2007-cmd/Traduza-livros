/** Estimativa antes de traduzir: palavras → créditos (e custo, para o dono). */
import { CREDIT, qualityOfModel } from "./catalog";
import { estimateCostUsd, type CostEstimate } from "./cost-model";

export interface Quote {
  billing: "byok" | "hosted" | "none";
  quality: { id: string; label: string; per1k: number };
  words: number;
  /** créditos inteiros (arredondado para cima) */
  credits: number;
  milli: number;
  costUsd: CostEstimate;
}

/** Créditos em milésimos: 1 crédito = 1.000 palavras × taxa da qualidade. */
export function milliFor(words: number, per1k: number): number {
  return Math.ceil(words * per1k * (CREDIT.milli / CREDIT.wordsPerCredit));
}

export function wholeCredits(milli: number): number {
  return Math.ceil(milli / CREDIT.milli);
}

export function quoteWords(provider: { id: string; model: string; billing: Quote["billing"] }, words: number, deepContext = false): Quote {
  const q = qualityOfModel(provider.model);
  const milli = provider.billing === "hosted" ? milliFor(words, q.creditsPer1k) : 0;
  return {
    billing: provider.billing,
    quality: { id: q.id, label: q.label, per1k: q.creditsPer1k },
    words,
    credits: wholeCredits(milli),
    milli,
    costUsd: estimateCostUsd(provider.id, provider.model, words, deepContext),
  };
}
