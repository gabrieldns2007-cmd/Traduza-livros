/**
 * Catálogo comercial do Verso: créditos, qualidades, planos e pacotes.
 *
 *   1 crédito = 1.000 palavras traduzidas na qualidade Padrão.
 *
 * Qualidades melhores usam modelos mais caros e consomem mais créditos por
 * mil palavras. O preço de cada crédito precisa cobrir o PIOR caso de custo
 * com folga — `assertCatalogProtectsMargin` verifica isso (e um teste falha
 * se alguém baixar um preço ou trocar um modelo e a margem deixar de existir).
 *
 * Nada aqui cobra dinheiro: é a definição do produto. Os pagamentos entram
 * depois, sem mudar esta estrutura (ver services/billing/payments.ts).
 */
import { costPer1kWords } from "./cost-model";

export const CREDIT = {
  wordsPerCredit: 1000,
  /** créditos são guardados em milésimos para cobrar por palavra, sem arredondar a cada lote */
  milli: 1000,
} as const;

/* ---------------- economia ---------------- */

export const ECONOMICS = {
  /** câmbio usado nas contas e folga para variação do dólar */
  usdToBrl: 5.6,
  fxBuffer: 0.1,
  /** taxa média do meio de pagamento (Pix ≈ 1%, cartão ≈ 4–5%) */
  paymentFee: 0.05,
  /** impostos sobre a receita (Simples Nacional, ordem de grandeza — confirmar com contador) */
  taxRate: 0.1,
  /** margem mínima mesmo no PIOR caso de custo (percentil 90) */
  minWorstCaseMargin: 0.5,
  /** se o custo REAL de uma execução passar desta fração do que ela cobrou, a tradução pausa */
  runCostCeiling: 0.8,
} as const;

/** R$ por US$ já com a folga do câmbio. */
export function brlPerUsd() {
  return ECONOMICS.usdToBrl * (1 + ECONOMICS.fxBuffer);
}

/** O que sobra de cada R$ 1 recebido, depois de taxa e impostos. */
export function netFactor() {
  return 1 - ECONOMICS.paymentFee - ECONOMICS.taxRate;
}

/* ---------------- qualidades ---------------- */

export type QualityId = "padrao" | "refinado" | "literario" | "premium";

export interface Quality {
  id: QualityId;
  label: string;
  description: string;
  /** créditos por 1.000 palavras */
  creditsPer1k: number;
  /** modelos que entregam esta qualidade: [serviço, modelo] */
  models: [string, string][];
}

export const QUALITIES: Quality[] = [
  {
    id: "padrao",
    label: "Padrão",
    description: "Fiel e fluente. Ótima para a maior parte dos livros.",
    creditsPer1k: 1,
    models: [
      ["gemini", "gemini-3.5-flash-lite"],
      ["anthropic", "claude-haiku-5-5"],
      ["groq", "openai/gpt-oss-120b"],
      ["groq", "llama-3.3-70b-versatile"],
      ["github", "openai/gpt-4.1-mini"],
    ],
  },
  {
    id: "refinado",
    label: "Refinada",
    description: "Mais natural no ritmo e nos diálogos.",
    creditsPer1k: 2,
    models: [
      ["gemini", "gemini-3.8-flash"],
      ["github", "openai/gpt-4.1"],
    ],
  },
  {
    id: "literario",
    label: "Literária",
    description: "Voz do autor, ironia e poesia preservadas com mais cuidado.",
    creditsPer1k: 6,
    models: [["anthropic", "claude-sonnet-5-5"]],
  },
  {
    id: "premium",
    label: "Premium",
    description: "O modelo mais capaz, para obras difíceis.",
    creditsPer1k: 12,
    models: [["anthropic", "claude-opus-5-5"]],
  },
];

export function qualityById(id: QualityId): Quality {
  return QUALITIES.find((q) => q.id === id)!;
}

/** Qualidade de um modelo (modelos desconhecidos são tratados como Premium, o mais caro). */
export function qualityOfModel(model: string): Quality {
  return QUALITIES.find((q) => q.models.some(([, m]) => m === model)) ?? qualityById("premium");
}

/* ---------------- planos e pacotes ---------------- */

export type PlanId = "free" | "plus" | "pro";

export interface Plan {
  id: PlanId;
  name: string;
  tagline: string;
  /** R$ por mês (0 = gratuito) */
  priceBrl: number;
  /** créditos que entram todo mês */
  monthlyCredits: number;
  /** créditos de boas-vindas (uma vez por conta) */
  welcomeCredits: number;
  /** meses que créditos mensais não usados acumulam (0 = não acumulam) */
  rolloverMonths: number;
  qualities: QualityId[];
  /** prévias grátis por dia */
  previewsPerDay: number;
  /** traduções ao mesmo tempo */
  concurrentBooks: number;
  priority: "normal" | "alta";
  features: string[];
}

export const PLANS: Plan[] = [
  {
    id: "free",
    name: "Grátis",
    tagline: "Para conhecer o Verso.",
    priceBrl: 0,
    monthlyCredits: 5,
    welcomeCredits: 15,
    rolloverMonths: 0,
    qualities: ["padrao"],
    previewsPerDay: 3,
    concurrentBooks: 1,
    priority: "normal",
    features: ["Prévia grátis de qualquer livro", "15 mil palavras de boas-vindas + 5 mil por mês", "Revisão e edição", "EPUB e PDF"],
  },
  {
    id: "plus",
    name: "Plus",
    tagline: "Para quem lê um livro por mês.",
    priceBrl: 24.9,
    monthlyCredits: 100,
    welcomeCredits: 0,
    rolloverMonths: 1,
    qualities: ["padrao", "refinado", "literario"],
    previewsPerDay: 20,
    concurrentBooks: 1,
    priority: "normal",
    features: [
      "100 créditos por mês (≈ 1 romance)",
      "Qualidades Refinada e Literária",
      "Créditos não usados valem por mais 1 mês",
      "Glossário editável e leitura atenta",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    tagline: "Para tradutores, estudantes e pequenas editoras.",
    priceBrl: 59.9,
    monthlyCredits: 300,
    welcomeCredits: 0,
    rolloverMonths: 2,
    qualities: ["padrao", "refinado", "literario", "premium"],
    previewsPerDay: 50,
    concurrentBooks: 3,
    priority: "alta",
    features: [
      "300 créditos por mês (≈ 3 romances)",
      "Todas as qualidades, inclusive Premium",
      "Até 3 livros traduzindo ao mesmo tempo",
      "Fila prioritária",
    ],
  },
];

export interface CreditPack {
  id: string;
  credits: number;
  priceBrl: number;
  validityMonths: number;
  label: string;
}

/** Créditos avulsos: para quem traduz de vez em quando (sem assinatura). */
export const PACKS: CreditPack[] = [
  { id: "pack-50", credits: 50, priceBrl: 14.9, validityMonths: 12, label: "Um livro curto" },
  { id: "pack-120", credits: 120, priceBrl: 29.9, validityMonths: 12, label: "Um romance longo" },
  { id: "pack-300", credits: 300, priceBrl: 64.9, validityMonths: 12, label: "Uma série" },
];

export function planById(id: string | undefined): Plan {
  return PLANS.find((p) => p.id === id) ?? PLANS[0];
}

/* ---------------- proteção da margem ---------------- */

/**
 * Pior custo (R$) de 1 crédito em cada qualidade — o maior entre os modelos dela
 * com preço conhecido (modelos sem preço só aparecem com a chave da própria pessoa).
 */
export function worstCostPerCreditBrl(q: Quality): number {
  const worst = Math.max(
    0,
    ...q.models
      .map(([provider, model]) => costPer1kWords(provider, model))
      .filter((c) => c.known)
      .map((c) => c.worst),
  );
  return (worst * brlPerUsd()) / q.creditsPer1k;
}

/**
 * Menor preço (R$) que um crédito pode ter:
 *   preço × (1 − taxa − imposto) × (1 − margem mínima) ≥ pior custo do crédito
 */
export function minCreditPriceBrl(): number {
  const worst = Math.max(...QUALITIES.map(worstCostPerCreditBrl));
  return worst / (netFactor() * (1 - ECONOMICS.minWorstCaseMargin));
}

/** Preço efetivo por crédito (R$) de um plano pago ou pacote. */
export function pricePerCredit(item: { priceBrl: number; monthlyCredits?: number; credits?: number }): number {
  const credits = item.monthlyCredits ?? item.credits ?? 0;
  return credits ? item.priceBrl / credits : Infinity;
}

/** Lança erro se algum plano pago ou pacote vender crédito abaixo do custo com margem. */
export function assertCatalogProtectsMargin() {
  const floor = minCreditPriceBrl();
  const items = [...PLANS.filter((p) => p.priceBrl > 0), ...PACKS];
  for (const item of items) {
    const price = pricePerCredit(item);
    if (price < floor) {
      const name = "name" in item ? item.name : item.id;
      throw new Error(`${name}: R$ ${price.toFixed(3)} por crédito está abaixo do mínimo seguro de R$ ${floor.toFixed(3)}.`);
    }
  }
  return floor;
}
