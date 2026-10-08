/**
 * Preparação para pagamentos — NENHUM meio de pagamento está ligado.
 *
 * Quando for a hora (Stripe, Mercado Pago, Pix…), basta implementar
 * `PaymentProvider` para o meio escolhido. O resto do Verso só conhece
 * eventos normalizados (`PaymentEvent`), aplicados por `applyPaymentEvent`:
 *
 *   tela “Comprar” → createCheckout → página do meio de pagamento
 *   meio de pagamento → webhook → parseWebhook → applyPaymentEvent → carteira
 *
 * Créditos só entram pelo webhook confirmado (nunca pelo retorno do navegador),
 * e cada evento é aplicado uma única vez (idempotência por externalId).
 */
import { PACKS, PLANS, type PlanId } from "@/lib/billing/catalog";
import { wallet } from "./wallet";

/** O que pode ser vendido: um pacote de créditos ou um plano mensal. */
export type ProductId = (typeof PACKS)[number]["id"] | `plan-${Exclude<PlanId, "free">}`;

export interface PaymentEvent {
  kind: "purchase.completed" | "subscription.started" | "subscription.renewed" | "subscription.canceled" | "refund";
  /** conta no Verso (no servidor próprio: "local"; na versão pública: o id da conta Google) */
  accountId: string;
  productId: string;
  /** id do pagamento no meio de pagamento — chave de idempotência */
  externalId: string;
  amountBrl: number;
}

export interface CheckoutRequest {
  accountId: string;
  productId: ProductId;
  successUrl: string;
  cancelUrl: string;
}

export interface PaymentProvider {
  id: string;
  /** cria a sessão de pagamento e devolve o endereço para onde mandar a pessoa */
  createCheckout(req: CheckoutRequest): Promise<{ url: string }>;
  /** valida a assinatura do webhook e traduz para um evento do Verso (null = ignorar) */
  parseWebhook(request: Request): Promise<PaymentEvent | null>;
}

/** Nenhum meio de pagamento configurado: a loja mostra “em breve”. */
export function paymentProvider(): PaymentProvider | null {
  return null;
}

/**
 * Aplica um evento de pagamento à carteira. Devolve false quando o evento já
 * tinha sido aplicado (o meio de pagamento reenviou o aviso).
 */
export async function applyPaymentEvent(event: PaymentEvent): Promise<boolean> {
  const pack = PACKS.find((p) => p.id === event.productId);
  if (pack && event.kind === "purchase.completed") {
    return wallet.grant("pack", pack.credits, {
      externalId: event.externalId,
      validityMonths: pack.validityMonths,
      note: `Pacote de ${pack.credits} créditos`,
    });
  }
  const plan = PLANS.find((p) => `plan-${p.id}` === event.productId);
  if (plan && (event.kind === "subscription.started" || event.kind === "subscription.renewed")) {
    // os créditos mensais entram pela própria carteira ao virar o mês; aqui só muda o plano
    const before = await wallet.read();
    if (before.ledger.some((e) => e.externalId === event.externalId)) return false;
    await wallet.setPlan(plan.id);
    return wallet.grant("subscription", 0, { externalId: event.externalId, note: `Assinatura ${plan.name}` });
  }
  if (event.kind === "subscription.canceled") {
    await wallet.setPlan("free");
    return true;
  }
  // reembolso: tratado manualmente por enquanto (créditos já usados não voltam)
  return false;
}
