/**
 * Pedido de tradução — o que o cliente compra.
 *
 *   oferta (preço por tipo de tradução)  →  pedido (preço travado)
 *   →  pagamento  →  tradução começa sozinha
 *
 * Enquanto não há meio de pagamento (CHECKOUT_MODE=beta, o padrão), confirmar
 * o pedido não cobra nada: ele fica registrado como “beta”. Com
 * CHECKOUT_MODE=live, a confirmação abre o pagamento e a tradução só começa
 * quando o meio de pagamento avisa que foi pago (webhook).
 */
import type { BookMeta, BookOrder } from "@/types/book";
import { store, readSettings } from "@/lib/storage";
import { priceFor, SERVICE_LEVELS, serviceLevel } from "@/lib/billing/pricing";
import { paymentProvider } from "@/services/billing/payments";
import { jobRunner } from "@/services/processing/job-runner";
import { levelOffered, type LevelId } from "./routing";
import { applySetup, type SetupBody } from "./setup";

export type CheckoutMode = "beta" | "live";

export function checkoutMode(): CheckoutMode {
  return process.env.CHECKOUT_MODE === "live" ? "live" : "beta";
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
    checkout: { mode: checkoutMode(), payments: Boolean(paymentProvider()) },
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
  if (checkoutMode() === "beta") {
    await markPaid(meta.id, order.id, { payment: "beta" });
    return { started: true };
  }
  const provider = paymentProvider();
  if (!provider) throw new OrderError("Os pagamentos ainda não estão disponíveis.", 503);
  const { url } = await provider.createCheckout({
    accountId: "local",
    productId: `order:${meta.id}:${order.id}`,
    successUrl: `${origin}/livros/${meta.id}?pago=1`,
    cancelUrl: `${origin}/livros/${meta.id}/pagamento`,
  });
  return { started: false, checkoutUrl: url };
}

/** Pedido pago (beta ou aviso do meio de pagamento): começa a tradução. Idempotente. */
export async function markPaid(bookId: string, orderId: string, opts: { payment: "beta" | "provider"; externalId?: string }): Promise<boolean> {
  const meta = await store.get(bookId);
  if (!meta?.order || meta.order.id !== orderId) return false;
  if (meta.order.status === "paid") return false;
  await store.update(bookId, (m) => {
    if (!m.order) return;
    m.order.status = "paid";
    m.order.payment = opts.payment;
    m.order.paidAt = new Date().toISOString();
    if (opts.externalId) m.order.externalId = opts.externalId;
    // o serviço é escolhido por dentro, conforme o tipo de tradução
    m.provider = undefined;
  });
  await jobRunner.start(bookId);
  return true;
}
