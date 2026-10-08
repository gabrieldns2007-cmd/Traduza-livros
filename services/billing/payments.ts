/**
 * Pagamentos — a arquitetura está pronta, mas NENHUM meio de pagamento real
 * está ligado (nada é cobrado).
 *
 * O Verso vende principalmente a TRADUÇÃO DE UM LIVRO (pagamento único,
 * produto “order:<livro>:<pedido>”). Pacotes de créditos e assinaturas
 * (“plan-…”) também estão previstos, para o futuro.
 *
 * Para ligar um meio de pagamento (Mercado Pago, Stripe…), implemente
 * `PaymentProvider` em services/billing/providers/ e registre em
 * `paymentProvider()`. O meio em uso vem do painel (ou de PAYMENT_PROVIDER). O resto do Verso só conhece eventos normalizados
 * (`PaymentEvent`), aplicados por `applyPaymentEvent`:
 *
 *   “Pagar e traduzir” → createCheckout → página do meio de pagamento
 *   meio de pagamento → POST /api/payments/webhook/<id> → parseWebhook
 *     → applyPaymentEvent → pedido pago → a tradução começa sozinha
 *
 * Regras:
 *  - o pedido só vira “pago” pelo aviso (webhook) validado — nunca pelo
 *    retorno do navegador;
 *  - cada aviso é aplicado uma única vez (idempotência por externalId);
 *  - um aviso com valor menor que o preço do pedido é ignorado.
 */
import { PACKS, PLANS } from "@/lib/billing/catalog";
import { wallet } from "./wallet";
import type { PaymentEvent, PaymentProvider } from "./payment-types";
import { simulatedProvider } from "./providers/simulated";

export type { CheckoutRequest, PaymentEvent, PaymentProvider, ProductId } from "./payment-types";
export { PaymentError } from "./payment-types";

/**
 * Meios de pagamento previstos. Só o simulado está implementado; os outros
 * entram quando houver conta no meio de pagamento (e sua autorização).
 */
export const PAYMENT_PROVIDERS = [
  { id: "simulado", label: "Pagamento simulado (teste, sem dinheiro)", implemented: true },
  { id: "mercadopago", label: "Mercado Pago (Pix, cartão, boleto)", implemented: false },
  { id: "stripe", label: "Stripe (cartão, Pix)", implemented: false },
] as const;

/** O meio de pagamento pelo nome (PAYMENT_PROVIDER ou painel) — null se nenhum ou não implementado. */
export function paymentProvider(id: string | null | undefined): PaymentProvider | null {
  switch (id) {
    case "simulado":
      return simulatedProvider;
    // a implementar quando houver conta (e sua autorização):
    // case "mercadopago": return mercadoPagoProvider;
    // case "stripe": return stripeProvider;
    default:
      return null;
  }
}

/** Situação dos pagamentos, para o painel administrativo. */
export function paymentSetup(wanted: string | null) {
  const info = PAYMENT_PROVIDERS.find((p) => p.id === wanted);
  return { wanted, label: info?.label ?? null, implemented: Boolean(info?.implemented), available: PAYMENT_PROVIDERS };
}

/**
 * Aplica um evento de pagamento à carteira. Devolve false quando o evento já
 * tinha sido aplicado (o meio de pagamento reenviou o aviso).
 */
export async function applyPaymentEvent(event: PaymentEvent): Promise<boolean> {
  // pedido de tradução de um livro: “order:<livro>:<pedido>”
  const order = /^order:([a-z0-9-]+):(ord_[\w-]+)$/.exec(event.productId);
  if (order && event.kind === "purchase.completed") {
    const { markPaid } = await import("@/services/commerce/orders");
    return markPaid(order[1], order[2], { payment: "provider", externalId: event.externalId, amountBrl: event.amountBrl, provider: event.provider });
  }
  if (order && event.kind === "refund") {
    const { markRefunded } = await import("@/services/commerce/orders");
    return markRefunded(order[1], order[2], event.externalId);
  }
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
