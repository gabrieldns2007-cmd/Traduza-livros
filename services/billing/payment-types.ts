/** Tipos dos pagamentos (separados para os meios de pagamento importarem sem ciclo). */
import type { PACKS, PlanId } from "@/lib/billing/catalog";

/** O que pode ser vendido: a tradução de um livro, um pacote de créditos ou um plano mensal. */
export type ProductId = `order:${string}:${string}` | (typeof PACKS)[number]["id"] | `plan-${Exclude<PlanId, "free">}`;

export interface PaymentEvent {
  kind: "purchase.completed" | "subscription.started" | "subscription.renewed" | "subscription.canceled" | "refund";
  /** conta no Verso (no servidor próprio: "local"; na versão pública: o id da conta Google) */
  accountId: string;
  productId: string;
  /** id do pagamento no meio de pagamento — chave de idempotência */
  externalId: string;
  amountBrl: number;
  /** meio de pagamento que avisou (ex.: "simulado", "mercadopago") */
  provider?: string;
}

export interface CheckoutRequest {
  accountId: string;
  productId: ProductId;
  /** pagamento único (tradução, pacote) ou recorrente (plano) */
  kind: "payment" | "subscription";
  amountBrl: number;
  /** o que aparece na página de pagamento (ex.: “Tradução do livro …”) */
  description: string;
  successUrl: string;
  cancelUrl: string;
}

export interface PaymentProvider {
  id: string;
  label: string;
  /** cria a sessão de pagamento e devolve o endereço para onde mandar a pessoa */
  createCheckout(req: CheckoutRequest): Promise<{ url: string }>;
  /** valida a assinatura do webhook e traduz para um evento do Verso (null = ignorar) */
  parseWebhook(request: Request): Promise<PaymentEvent | null>;
}

export class PaymentError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
