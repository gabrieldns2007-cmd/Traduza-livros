/**
 * Pedido de tradução — o que o cliente compra.
 *
 *   oferta (preço por tipo de tradução)  →  pedido (preço travado)
 *   →  pagamento  →  tradução começa sozinha
 *
 * Enquanto não há meio de pagamento (CHECKOUT_MODE=beta, o padrão), confirmar
 * o pedido não cobra nada: ele fica registrado como “beta”. Com
 * CHECKOUT_MODE=live, a confirmação abre o pagamento do meio escolhido em
 * no painel (ou em PAYMENT_PROVIDER) e a tradução só começa quando ele avisa
 * que foi pago (webhook). O pagamento simulado testa tudo isso sem dinheiro.
 */
import type { BookMeta, BookOrder } from "@/types/book";
import { store, readSettings, type Settings } from "@/lib/storage";
import { priceFor, SERVICE_LEVELS, serviceLevel } from "@/lib/billing/pricing";
import { paymentProvider } from "@/services/billing/payments";
import { jobRunner } from "@/services/processing/job-runner";
import { levelOffered, type LevelId } from "./routing";
import { applySetup, type SetupBody } from "./setup";

export type CheckoutMode = "beta" | "live";

export interface CheckoutConfig {
  mode: CheckoutMode;
  /** meio de pagamento (com mode "live") */
  provider: string | null;
  /** definido no .env (tem prioridade sobre o painel) */
  fromEnv: boolean;
}

/** Como o cliente paga: escolhido no painel; CHECKOUT_MODE e PAYMENT_PROVIDER no .env têm prioridade. */
export async function checkoutConfig(settings?: Settings): Promise<CheckoutConfig> {
  const s = settings ?? (await readSettings());
  const env = process.env.CHECKOUT_MODE;
  return {
    mode: env === "live" || env === "beta" ? env : (s.checkout?.mode ?? "beta"),
    provider: process.env.PAYMENT_PROVIDER || s.checkout?.provider || null,
    fromEnv: Boolean(env || process.env.PAYMENT_PROVIDER),
  };
}

export class OrderError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function remainingWords(meta: BookMeta) {
  return Math.max(0, meta.totals.words - meta.progress.translatedWords);
}

export interface Offer {
  title: string;
  author?: string;
  sourceLanguage: string | null;
  detectedLanguage: string | null;
  targetLanguage: string;
  words: number;
  totalWords: number;
  chapters: number;
  levels: { id: LevelId; label: string; description: string; priceBrl: number; available: boolean }[];
  order: BookOrder | null;
  checkout: { mode: CheckoutMode; payments: boolean };
}

/** O que o cliente vê antes de pagar: palavras e o preço de cada tipo de tradução. */
export async function offerFor(meta: BookMeta): Promise<Offer> {
  const settings = await readSettings();
  const checkout = await checkoutConfig(settings);
  const words = remainingWords(meta);
  return {
    title: meta.translatedTitle && meta.status === "done" ? meta.translatedTitle : meta.title,
    author: meta.author,
    sourceLanguage: meta.sourceLanguage,
    detectedLanguage: meta.detectedLanguage ?? null,
    targetLanguage: meta.targetLanguage,
    words,
    totalWords: meta.totals.words,
    chapters: meta.chapters.length,
    levels: SERVICE_LEVELS.map((l) => ({
      id: l.id,
      label: l.label,
      description: l.description,
      priceBrl: priceFor(words, l.id),
      available: levelOffered(l.id, settings),
    })),
    order: meta.order ?? null,
    checkout: { mode: checkout.mode, payments: Boolean(paymentProvider(checkout.provider)) },
  };
}

/** Cria (ou refaz, se ainda não pago) o pedido com o preço travado. */
export async function placeOrder(meta: BookMeta, level: LevelId, setup: SetupBody): Promise<BookOrder> {
  if (meta.order?.status === "paid") throw new OrderError("Este livro já tem uma tradução paga.", 409);
  if (meta.status !== "ready" && meta.status !== "paused" && meta.status !== "error") {
    throw new OrderError("Este livro já está sendo traduzido.", 409);
  }
  const settings = await readSettings();
  if (!levelOffered(level, settings)) throw new OrderError(`A tradução ${serviceLevel(level).label} não está disponível no momento.`, 409);
  await applySetup(meta, setup);
  const fresh = (await store.get(meta.id))!;
  const words = remainingWords(fresh);
  const order: BookOrder = {
    id: `ord_${globalThis.crypto.randomUUID().slice(0, 12)}`,
    level,
    words,
    priceBrl: priceFor(words, level),
    status: "awaiting_payment",
    payment: null,
    createdAt: new Date().toISOString(),
  };
  await store.update(meta.id, (m) => {
    m.order = order;
    m.level = level;
  });
  return order;
}

/** Confirma o pedido: no beta, sem cobrança; com pagamentos, devolve o endereço do pagamento. */
export async function confirmOrder(meta: BookMeta, origin: string): Promise<{ started: boolean; checkoutUrl?: string }> {
  const order = meta.order;
  if (!order || order.status === "canceled") throw new OrderError("Escolha o tipo de tradução antes de confirmar.", 409);
  if (order.status === "paid") return { started: false };
  const checkout = await checkoutConfig();
  if (checkout.mode === "beta") {
    await markPaid(meta.id, order.id, { payment: "beta" });
    return { started: true };
  }
  const provider = paymentProvider(checkout.provider);
  if (!provider) throw new OrderError("Os pagamentos ainda não estão disponíveis.", 503);
  const { url } = await provider.createCheckout({
    accountId: "local",
    productId: `order:${meta.id}:${order.id}`,
    kind: "payment",
    amountBrl: order.priceBrl,
    description: `Tradução do livro “${meta.title}”`,
    // a volta do pagamento só mostra “confirmando…”: o pedido vira pago pelo aviso (webhook)
    successUrl: `${origin}/livros/${meta.id}/pagamento?retorno=1`,
    cancelUrl: `${origin}/livros/${meta.id}`,
  });
  return { started: false, checkoutUrl: url };
}

/** Pedido pago (beta ou aviso do meio de pagamento): começa a tradução. Idempotente. */
export async function markPaid(
  bookId: string,
  orderId: string,
  opts: { payment: "beta" | "provider"; externalId?: string; amountBrl?: number; provider?: string },
): Promise<boolean> {
  const meta = await store.get(bookId);
  if (!meta?.order || meta.order.id !== orderId) return false;
  if (meta.order.status !== "awaiting_payment") return false;
  // aviso com valor menor que o preço do pedido: não libera a tradução
  if (opts.payment === "provider" && (opts.amountBrl ?? 0) + 0.005 < meta.order.priceBrl) {
    console.warn(`[pedido] ${bookId}/${orderId}: pagamento de R$ ${opts.amountBrl} menor que o preço R$ ${meta.order.priceBrl}; ignorado`);
    return false;
  }
  await store.update(bookId, (m) => {
    if (!m.order) return;
    m.order.status = "paid";
    m.order.payment = opts.payment;
    m.order.paidAt = new Date().toISOString();
    if (opts.provider) m.order.paymentProvider = opts.provider;
    if (opts.externalId) m.order.externalId = opts.externalId;
    // o serviço é escolhido por dentro, conforme o tipo de tradução
    m.provider = undefined;
  });
  await jobRunner.start(bookId);
  return true;
}

/** Reembolso avisado pelo meio de pagamento: registra no pedido (a tradução já feita fica com o cliente). */
export async function markRefunded(bookId: string, orderId: string, externalId: string): Promise<boolean> {
  const meta = await store.get(bookId);
  if (!meta?.order || meta.order.id !== orderId || meta.order.status === "refunded") return false;
  await store.update(bookId, (m) => {
    if (!m.order) return;
    m.order.status = "refunded";
    m.order.refundedAt = new Date().toISOString();
    m.order.externalId ??= externalId;
  });
  return true;
}
