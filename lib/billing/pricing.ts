/**
 * Preço da TRADUÇÃO de um livro, em reais — é o que o cliente vê.
 *
 * O cliente escolhe só o tipo de tradução. São duas modalidades que nunca se
 * misturam (services/commerce/routing.ts):
 *
 *   Grátis (id "padrao"): R$ 0, em qualquer tamanho. Só serviços de IA
 *              gratuitos, em rodízio; sem prazo garantido. Não tem preço
 *              mínimo nem margem: não há receita (o site se paga com anúncios).
 *   Literária: R$ 1,90 + R$ 1,49 por mil palavras, arredondado para cima em
 *              “,90”, nunca abaixo do preço mínimo (R$ 9,90). Serviço pago.
 *
 * e `assertPricingProtectsMargin` garante, para livros de qualquer tamanho:
 *
 *   Grátis:    preço = R$ 0 (nunca cobra nada, nem por engano)
 *   pagos:     preço × (1 − taxa do pagamento − impostos)
 *                − pior custo de processamento − custo fixo por pedido   ≥   margem mínima do tipo
 *
 * O pior custo vem da tabela de preços dos modelos (lib/billing/prices.ts) e
 * do modelo de consumo (lib/billing/cost-model.ts), para os modelos de
 * `qualities`. A Grátis não tem `qualities`: o custo de IA dela é zero.
 *
 * Este arquivo também vai para o navegador (Preços, página inicial): nada aqui
 * pode depender do Node.
 */
import { brl } from "@/lib/money";
import { costPer1kWords } from "./cost-model";
import { brlPerUsd, ECONOMICS, netFactor, QUALITIES, type QualityId } from "./catalog";

export type ServiceLevelId = "padrao" | "literaria";

export interface ServiceLevel {
  id: ServiceLevelId;
  label: string;
  description: string;
  /** modalidade grátis: preço sempre R$ 0 (sem mínimo), só serviços gratuitos, sem margem a proteger */
  free?: boolean;
  /** R$ por mil palavras */
  per1kBrl: number;
  /** R$ fixo por pedido (pagamento, armazenamento, suporte e margem) */
  feeBrl: number;
  /** faixas de modelos usadas na conta do pior custo (vazio na Grátis: custo de IA zero) */
  qualities: QualityId[];
  /** margem mínima no pior caso (fração do líquido); não se aplica à Grátis */
  minWorstMargin: number;
}

export const SERVICE_LEVELS: ServiceLevel[] = [
  {
    // o id continua "padrao" para os livros e pedidos já gravados
    id: "padrao",
    label: "Grátis",
    description: "Tradução completa por IA gratuita. Pode levar mais tempo: depende da disponibilidade dos serviços gratuitos.",
    free: true,
    per1kBrl: 0,
    feeBrl: 0,
    qualities: [],
    minWorstMargin: 0,
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
  /** custo fixo de verdade por pedido pago (tarifa fixa do pagamento, armazenamento, e-mail, suporte) */
  fixedCostPerOrderBrl: 1.0,
  /** nenhuma tradução paga sai por menos que isto (a Grátis é R$ 0) */
  minimumBrl: 9.9,
  /** amostra grátis e análise do livro: folga sobre o custo de processamento */
  processingOverhead: 0.05,
} as const;

/**
 * O tipo de tradução pelo id. Id desconhecido (ou ausente) nunca vira a Grátis
 * sem querer: vale o tipo pago (um pedido nunca sai de graça por engano).
 */
export function serviceLevel(id: string | undefined): ServiceLevel {
  return SERVICE_LEVELS.find((l) => l.id === id) ?? SERVICE_LEVELS.find((l) => !l.free)!;
}

/** É a modalidade grátis (R$ 0, só serviços gratuitos)? */
export function isFreeLevel(id: string | undefined): boolean {
  return Boolean(serviceLevel(id).free);
}

/** Valor para mostrar ao cliente: “R$ 0” na Grátis (sem centavos, para não parecer cobrança), com o mesmo espaço sem quebra de brl(). */
export function priceLabel(v: number): string {
  return v === 0 ? "R$\u00a00" : brl(v);
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

/** Preço da tradução (R$) para `words` palavras. A Grátis é sempre R$ 0. */
export function priceFor(words: number, levelId: string | undefined): number {
  const level = serviceLevel(levelId);
  if (level.free) return 0;
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

/** Conta interna (painel administrativo): de onde vem o preço e quanto sobra. Na Grátis: tudo zero. */
export function breakdown(words: number, levelId: string | undefined, priceBrl = priceFor(words, levelId)): PriceBreakdown {
  const level = serviceLevel(levelId);
  const k = (words / 1000) * (1 + OPERATIONS.processingOverhead);
  const netBrl = priceBrl * netFactor();
  const processingWorstBrl = k * worstProcessingPer1kBrl(level);
  const processingExpectedBrl = k * expectedProcessingPer1kBrl(level);
  // a Grátis não passa pelo pagamento: sem tarifa fixa por pedido
  const fixedCostBrl = level.free ? 0 : OPERATIONS.fixedCostPerOrderBrl;
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

/**
 * Lança erro se a Grátis cobrar qualquer valor, ou se algum tamanho de livro, num
 * tipo pago, ficar abaixo da margem mínima do tipo.
 */
export function assertPricingProtectsMargin(sizes = GUARD_SIZES) {
  for (const level of SERVICE_LEVELS) {
    for (const words of sizes) {
      if (level.free) {
        // sem receita, não há margem a proteger — mas a Grátis nunca pode cobrar nada
        const price = priceFor(words, level.id);
        if (price !== 0) throw new Error(`${level.label}, ${words} palavras: a tradução grátis custaria R$ ${price.toFixed(2)} (precisa ser R$ 0).`);
        continue;
      }
      const b = breakdown(words, level.id);
      if (b.marginWorst < level.minWorstMargin) {
        throw new Error(
          `${level.label}, ${words} palavras: preço R$ ${b.priceBrl.toFixed(2)} deixa margem de ${(b.marginWorst * 100).toFixed(0)}% no pior caso (mínimo ${level.minWorstMargin * 100}%).`,
        );
      }
    }
  }
}
