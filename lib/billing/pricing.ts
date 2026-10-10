/**
 * Preço da TRADUÇÃO de um livro, em reais — é o que o cliente vê.
 *
 * O cliente escolhe só o tipo de tradução (Padrão ou Literária). Por dentro:
 *
 *   preço = taxa do tipo de tradução  +  palavras × preço por mil palavras
 *           arredondado para cima em “,90”, nunca abaixo do preço mínimo
 *
 *   Padrão:    R$ 8,90 + R$ 0,10 por mil palavras  (210 mil palavras = R$ 29,90)
 *   Literária: R$ 1,90 + R$ 1,49 por mil palavras
 *
 * e `assertPricingProtectsMargin` garante, para livros de qualquer tamanho:
 *
 *   preço × (1 − taxa do pagamento − impostos)
 *     − pior custo de processamento − custo fixo por pedido   ≥   margem mínima do tipo
 *
 * O pior custo vem da tabela de preços dos modelos (lib/billing/prices.ts) e
 * do modelo de consumo (lib/billing/cost-model.ts), como se os modelos de
 * `qualities` fossem PAGOS. Na Padrão isso é uma hipótese de segurança: hoje
 * ela só roda em serviços gratuitos (services/commerce/routing.ts), e o custo
 * real de IA é zero; a conta garante que, mesmo no nível pago do modelo mais
 * barato (Gemini Flash-Lite), nenhum livro dá prejuízo.
 */
import { costPer1kWords } from "./cost-model";
import { brlPerUsd, ECONOMICS, netFactor, QUALITIES, type QualityId } from "./catalog";

export type ServiceLevelId = "padrao" | "literaria";

export interface ServiceLevel {
  id: ServiceLevelId;
  label: string;
  description: string;
  /** R$ por mil palavras */
  per1kBrl: number;
  /** R$ fixo por pedido (pagamento, armazenamento, suporte e margem) */
  feeBrl: number;
  /** faixas de modelos usadas na conta do pior custo (como se fossem pagos) */
  qualities: QualityId[];
  /** margem mínima no pior custo (fração do líquido) */
  minWorstMargin: number;
}

export const SERVICE_LEVELS: ServiceLevel[] = [
  {
    id: "padrao",
    label: "Padrão",
    description: "Fluente e fiel ao original. Ideal para a maioria dos livros.",
    per1kBrl: 0.1,
    feeBrl: 8.9,
    // hoje: só serviços gratuitos (custo zero). Se um dia for paga, usa a faixa mais barata
    // (Gemini Flash-Lite, Haiku, Groq) — e ainda assim não dá prejuízo em nenhum tamanho
    qualities: ["padrao"],
    minWorstMargin: 0.15,
  },
  {
    id: "literaria",
    label: "Literária",
    description: "Mais cuidado com a voz do autor, o ritmo e as imagens. Ideal para ficção e poesia.",
    per1kBrl: 1.49,
    feeBrl: 1.9,
    qualities: ["literario"],
    minWorstMargin: ECONOMICS.minWorstCaseMargin,
  },
];

export const OPERATIONS = {
  /** custo fixo de verdade por pedido (tarifa fixa do pagamento, armazenamento, e-mail, suporte) */
  fixedCostPerOrderBrl: 1.0,
  /** nenhuma tradução sai por menos que isto */
  minimumBrl: 9.9,
  /** amostra grátis e análise do livro: folga sobre o custo de processamento */
  processingOverhead: 0.05,
} as const;

export function serviceLevel(id: string | undefined): ServiceLevel {
  return SERVICE_LEVELS.find((l) => l.id === id) ?? SERVICE_LEVELS[0];
}

/** Arredonda para cima terminando em ,90 (19,12 → 19,90; 19,95 → 20,90). */
export function roundTo90(v: number): number {
  return Math.round((Math.ceil(v + 0.1) - 0.1) * 100) / 100;
}

/** Pior custo de processamento (R$) por mil palavras, entre todos os modelos deste tipo de tradução. */
export function worstProcessingPer1kBrl(level: ServiceLevel): number {
  const models = QUALITIES.filter((q) => level.qualities.includes(q.id)).flatMap((q) => q.models);
  const worst = Math.max(
    0,
    ...models
      .map(([p, m]) => costPer1kWords(p, m))
      .filter((c) => c.known)
      .map((c) => c.worst),
  );
  return worst * brlPerUsd();
}

export function expectedProcessingPer1kBrl(level: ServiceLevel): number {
  const models = QUALITIES.filter((q) => level.qualities.includes(q.id)).flatMap((q) => q.models);
  const costs = models
    .map(([p, m]) => costPer1kWords(p, m))
    .filter((c) => c.known)
    .map((c) => c.expected);
  return (costs.length ? Math.max(...costs) : 0) * brlPerUsd();
}

/** Preço da tradução (R$) para `words` palavras. */
export function priceFor(words: number, levelId: string | undefined): number {
  const level = serviceLevel(levelId);
  const raw = level.feeBrl + (Math.max(0, words) / 1000) * level.per1kBrl;
  return Math.max(OPERATIONS.minimumBrl, roundTo90(raw));
}

export interface PriceBreakdown {
  priceBrl: number;
  /** o que sobra depois de taxa do pagamento e impostos */
  netBrl: number;
  processingExpectedBrl: number;
  processingWorstBrl: number;
  fixedCostBrl: number;
  marginExpected: number;
  marginWorst: number;
}

/** Conta interna (painel administrativo): de onde vem o preço e quanto sobra. */
export function breakdown(words: number, levelId: string | undefined, priceBrl = priceFor(words, levelId)): PriceBreakdown {
  const level = serviceLevel(levelId);
  const k = (words / 1000) * (1 + OPERATIONS.processingOverhead);
  const netBrl = priceBrl * netFactor();
  const processingWorstBrl = k * worstProcessingPer1kBrl(level);
  const processingExpectedBrl = k * expectedProcessingPer1kBrl(level);
  const fixedCostBrl = OPERATIONS.fixedCostPerOrderBrl;
  const margin = (cost: number) => (netBrl > 0 ? (netBrl - cost - fixedCostBrl) / netBrl : 0);
  return {
    priceBrl,
    netBrl,
    processingExpectedBrl,
    processingWorstBrl,
    fixedCostBrl,
    marginExpected: margin(processingExpectedBrl),
    marginWorst: margin(processingWorstBrl),
  };
}

export const GUARD_SIZES = [300, 2_000, 10_000, 44_152, 80_000, 100_000, 150_000, 210_000, 300_000, 1_000_000];

/** Lança erro se algum tamanho de livro, em algum tipo de tradução, ficar abaixo da margem mínima do tipo. */
export function assertPricingProtectsMargin(sizes = GUARD_SIZES) {
  for (const level of SERVICE_LEVELS) {
    for (const words of sizes) {
      const b = breakdown(words, level.id);
      if (b.marginWorst < level.minWorstMargin) {
        throw new Error(
          `${level.label}, ${words} palavras: preço R$ ${b.priceBrl.toFixed(2)} deixa margem de ${(b.marginWorst * 100).toFixed(0)}% no pior caso (mínimo ${level.minWorstMargin * 100}%).`,
        );
      }
    }
  }
}
