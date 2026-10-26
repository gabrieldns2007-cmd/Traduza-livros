/**
 * Pedido de tradução — o que o cliente compra.
 *
 *   oferta (preço por tipo de tradução)  →  pedido (preço travado)
 *   →  pagamento  →  tradução começa sozinha
 *
 * Tradução Grátis (R$ 0): confirmar o pedido não passa por pagamento nenhum —
 * nem com os pagamentos ligados. Ele fica registrado como “free” e a tradução
 * começa na hora, só com serviços gratuitos.
 *
 * Literária (paga): enquanto não há meio de pagamento (CHECKOUT_MODE=beta, o
 * padrão), confirmar o pedido não cobra nada: ele fica registrado como “beta”.
 * Com CHECKOUT_MODE=live, a confirmação abre o pagamento do meio escolhido no
 * painel (ou em PAYMENT_PROVIDER) e a tradução só começa quando ele avisa que
 * foi pago (webhook). O pagamento simulado testa tudo isso sem dinheiro.
 *
 * Trocar da Grátis para a Literária no meio do livro só acontece por escolha do
 * cliente: um pedido novo, que cobre só as palavras que faltam, confirmado e
 * pago como qualquer outro. Enquanto ele espera o pagamento, a Grátis fica
 * parada (nada avança, então o preço continua certo) — por no máximo 2 horas:
 * sem pagamento até lá, a troca é cancelada e a Grátis segue sozinha. Escolher a
 * Grátis de novo retoma do mesmo ponto na hora. Um pedido pago nunca vira grátis sozinho.
 *
 * Um pedido NOVO da Literária (livro que ainda não começou na Grátis) cobre o livro
 * todo: o trecho da amostra grátis sai do livro quando ele é pago (o livro pago é
 * todo traduzido pelo serviço pago) e por isso entra no preço.
 *
 * Pagamento que chega e não vale como venda (pedido da Grátis, pedido trocado ou
 * cancelado, valor menor que o preço): nunca vira venda; fica anotado no livro
 * para o dono reembolsar (painel → “Pagamento recebido para reembolsar”).
 */
import type { BookMeta, BookOrder } from "@/types/book";
import { store, readSettings, type Settings } from "@/lib/storage";
import { isFreeLevel, priceFor, SERVICE_LEVELS, serviceLevel } from "@/lib/billing/pricing";
import { paymentProvider } from "@/services/billing/payments";
import { discardFreeText, isLegacyBetaFree, jobRunner, UPGRADE_HOLD_MS, wordsForPaidOrder } from "@/services/processing/job-runner";
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

/**
 * Pedido da Grátis já confirmado (R$ 0) — inclusive um pedido Padrão antigo,
 * confirmado no beta com preço (nunca foi cobrado): o livro pode passar para a
 * Literária, se o cliente escolher.
 */
function isConfirmedFree(order: BookOrder | undefined): boolean {
  return Boolean(order && order.status === "paid" && isFreeLevel(order.level) && (order.priceBrl === 0 || isLegacyBetaFree(order)));
}

/** O livro já começou na Grátis (pedido grátis confirmado, ou a troca dele esperando o pagamento)? */
function startedFree(meta: BookMeta): boolean {
  const o = meta.order;
  return isConfirmedFree(o) || Boolean(o?.status === "awaiting_payment" && o.replaces);
}

/**
 * Palavras que um pedido deste tipo cobre: a Grátis e a troca do “restante” (livro
 * começado na Grátis), só as que faltam; um pedido novo da Literária, todas as que
 * não foram traduzidas por um serviço pago (a amostra grátis sai do livro).
 */
async function orderWords(meta: BookMeta, level: LevelId): Promise<number> {
  return isFreeLevel(level) || startedFree(meta) ? remainingWords(meta) : wordsForPaidOrder(meta);
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
  /** `words`: as palavras que o valor deste tipo cobre */
  levels: { id: LevelId; label: string; description: string; priceBrl: number; words: number; free: boolean; available: boolean }[];
  order: BookOrder | null;
  checkout: { mode: CheckoutMode; payments: boolean };
}

/** O que o cliente vê antes de pagar: palavras (as que faltam) e o preço de cada tipo de tradução. */
export async function offerFor(meta: BookMeta): Promise<Offer> {
  const settings = await readSettings();
  const checkout = await checkoutConfig(settings);
  const words = remainingWords(meta);
  const levels = await Promise.all(
    SERVICE_LEVELS.map(async (l) => {
      const covered = await orderWords(meta, l.id);
      return {
        id: l.id,
        label: l.label,
        description: l.description,
        priceBrl: priceFor(covered, l.id),
        words: covered,
        free: Boolean(l.free),
        available: levelOffered(l.id, settings),
      };
    }),
  );
  return {
    title: meta.translatedTitle && meta.status === "done" ? meta.translatedTitle : meta.title,
    author: meta.author,
    sourceLanguage: meta.sourceLanguage,
    detectedLanguage: meta.detectedLanguage ?? null,
    targetLanguage: meta.targetLanguage,
    words,
    totalWords: meta.totals.words,
    chapters: meta.chapters.length,
    levels,
    order: meta.order ?? null,
    checkout: { mode: checkout.mode, payments: Boolean(paymentProvider(checkout.provider)) },
  };
}

/**
 * Cria (ou refaz, se ainda não pago) o pedido com o preço travado. Também é a
 * troca da Grátis para a Literária, por escolha do cliente: o pedido novo cobre
 * só as palavras que faltam e a Grátis fica parada até o pagamento (ou até o
 * cliente escolher a Grátis de novo, ou até o prazo de 2 horas acabar).
 */
export async function placeOrder(meta: BookMeta, level: LevelId, setup: SetupBody): Promise<BookOrder> {
  const previous = meta.order;
  const upgrade = !isFreeLevel(level) && isConfirmedFree(previous);
  if (previous?.status === "paid" && !upgrade) {
    // um pedido pago (ou a Grátis já confirmada) não é trocado por outro — e nunca vira grátis
    throw new OrderError(
      isConfirmedFree(previous) ? "A tradução grátis deste livro já foi confirmada." : "Este livro já tem uma tradução paga.",
      409,
    );
  }
  if (meta.status === "done") throw new OrderError("Este livro já foi traduzido.", 409);
  if (meta.status !== "ready" && meta.status !== "paused" && meta.status !== "error") {
    throw new OrderError("Este livro já está sendo traduzido.", 409);
  }
  const settings = await readSettings();
  if (!levelOffered(level, settings)) throw new OrderError(`A tradução ${serviceLevel(level).label} não está disponível no momento.`, 409);
  // livro já começado: idiomas e preferências ficam como estão (mesma voz e mesmos nomes até o fim)
  const started = meta.status !== "ready";
  if (!started) await applySetup(meta, setup);
  // troca para a Literária (nova ou refeita): de que pedido grátis ela vem
  const replaces = upgrade ? previous!.id : !isFreeLevel(level) && previous?.status === "awaiting_payment" ? previous.replaces : undefined;
  // a Grátis para enquanto o pagamento não chega: nada avança, e o preço do que falta continua certo
  if (replaces) await jobRunner.pause(meta.id);
  const fresh = (await store.get(meta.id))!;
  // a mesma conta da oferta: troca do “restante”, só o que falta; pedido novo da Literária, tudo o que não é de um serviço pago
  const words = replaces || isFreeLevel(level) ? remainingWords(fresh) : await wordsForPaidOrder(fresh);
  const now = Date.now();
  const order: BookOrder = {
    id: `ord_${globalThis.crypto.randomUUID().slice(0, 12)}`,
    level,
    words,
    priceBrl: priceFor(words, level),
    status: "awaiting_payment",
    payment: null,
    createdAt: new Date(now).toISOString(),
    // a Grátis espera parada pelo pagamento da troca por no máximo 2 horas
    ...(replaces ? { replaces, expiresAt: new Date(now + UPGRADE_HOLD_MS).toISOString() } : {}),
  };
  await store.update(meta.id, (m) => {
    // o pedido de antes fica no histórico (o grátis confirmado volta a valer se a troca não for paga)
    if (m.order && m.order.id !== order.id) {
      const old = m.order.status === "awaiting_payment" ? { ...m.order, status: "canceled" as const, canceledAt: order.createdAt } : m.order;
      m.orderHistory = [...(m.orderHistory ?? []), old].slice(-20);
    }
    m.order = order;
    // livro novo: o tipo vale desde já. Livro começado: o tipo só muda quando o pedido é confirmado (markPaid)
    if (!started) m.level = level;
    if (replaces) {
      // parada por escolha do cliente: não volta sozinha antes do prazo da troca (nem depois de reiniciar o servidor)
      m.stopCode = undefined;
      m.resumeAt = undefined;
      m.error = undefined;
    }
  });
  if (replaces) jobRunner.scheduleUpgradeExpiry(meta.id, Date.parse(order.expiresAt!));
  else jobRunner.clearUpgradeHold(meta.id);
  return order;
}

/**
 * Confirma o pedido. Grátis: na hora, sem pagamento (mesmo com os pagamentos
 * ligados). Pago: no beta, sem cobrança; com pagamentos, devolve o endereço do pagamento.
 */
export async function confirmOrder(meta: BookMeta, origin: string): Promise<{ started: boolean; checkoutUrl?: string }> {
  const order = meta.order;
  if (!order || order.status === "canceled") throw new OrderError("Escolha o tipo de tradução antes de confirmar.", 409);
  if (order.status === "paid") return { started: false };
  if (isFreeLevel(order.level)) {
    await markPaid(meta.id, order.id, { payment: "free" });
    return { started: true };
  }
  // nunca abre um pagamento de R$ 0
  if (!(order.priceBrl > 0)) throw new OrderError("Escolha o tipo de tradução de novo.", 409);
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
    description: order.replaces ? `Tradução Literária do restante do livro “${meta.title}”` : `Tradução do livro “${meta.title}”`,
    // a volta do pagamento só mostra “confirmando…”: o pedido vira pago pelo aviso (webhook)
    successUrl: `${origin}/livros/${meta.id}/pagamento?retorno=1`,
    cancelUrl: `${origin}/livros/${meta.id}`,
  });
  return { started: false, checkoutUrl: url };
}

type PaidOpts = { payment: "beta" | "provider" | "free"; externalId?: string; amountBrl?: number; provider?: string };

/**
 * Pagamento que chegou e não vale como venda: fica anotado no livro para o dono
 * devolver o dinheiro (uma vez por pagamento, mesmo com o aviso repetido).
 */
async function notePaymentToRefund(bookId: string, orderId: string, opts: PaidOpts, reason: string) {
  console.warn(`[pedido] ${bookId}/${orderId}: pagamento recebido para reembolsar (${reason})`);
  await store.update(bookId, (m) => {
    const list = m.paymentsToRefund ?? [];
    if (opts.externalId && list.some((p) => p.externalId === opts.externalId)) return;
    m.paymentsToRefund = [
      ...list,
      {
        orderId,
        ...(opts.externalId ? { externalId: opts.externalId } : {}),
        ...(opts.amountBrl !== undefined ? { amountBrl: opts.amountBrl } : {}),
        ...(opts.provider ? { provider: opts.provider } : {}),
        reason,
        at: new Date().toISOString(),
      },
    ];
  });
}

/**
 * Pedido confirmado (Grátis, beta ou aviso do meio de pagamento): começa a tradução. Idempotente.
 * Um aviso de pagamento que não vale como venda fica anotado para reembolso (notePaymentToRefund).
 */
export async function markPaid(bookId: string, orderId: string, opts: PaidOpts): Promise<boolean> {
  const meta = await store.get(bookId);
  if (!meta?.order) {
    if (opts.payment === "provider")
      console.warn(`[pedido] ${bookId}/${orderId}: aviso de pagamento de um livro sem pedido; ignorado (veja se precisa reembolsar)`);
    return false;
  }
  if (meta.order.id !== orderId) {
    // ex.: o cliente refez o pedido, voltou para a Grátis ou a troca venceu, e depois concluiu o pagamento antigo
    if (opts.payment === "provider") await notePaymentToRefund(bookId, orderId, opts, "pedido trocado ou cancelado");
    return false;
  }
  if (meta.order.status !== "awaiting_payment") {
    // o mesmo aviso de novo (mesmo pagamento): nada a fazer; outro pagamento do mesmo pedido: devolver
    const repeated = Boolean(opts.externalId && meta.order.externalId === opts.externalId);
    if (opts.payment === "provider" && !repeated) await notePaymentToRefund(bookId, orderId, opts, "pedido já confirmado");
    return false;
  }
  // só a Grátis se confirma como “free”: um pedido pago nunca vira grátis
  if (opts.payment === "free" && !isFreeLevel(meta.order.level)) return false;
  if (opts.payment === "provider" && isFreeLevel(meta.order.level)) {
    // pagamento de um pedido da Grátis (ex.: um pedido Padrão antigo, aberto antes da Grátis): nunca é
    // uma venda — a tradução é confirmada grátis e o valor fica anotado para reembolso
    await notePaymentToRefund(bookId, orderId, opts, "pagamento de um pedido da tradução grátis");
    opts = { payment: "free" };
  }
  // aviso com valor menor que o preço: não libera a tradução (e o que foi pago volta)
  if (opts.payment === "provider" && (opts.amountBrl ?? 0) + 0.005 < meta.order.priceBrl) {
    console.warn(`[pedido] ${bookId}/${orderId}: pagamento de R$ ${opts.amountBrl} menor que o preço R$ ${meta.order.priceBrl}; ignorado`);
    await notePaymentToRefund(bookId, orderId, opts, "valor menor que o preço");
    return false;
  }
  // pedido NOVO da Literária: o texto dos serviços gratuitos (a amostra) sai do livro antes de começar.
  // Uma amostra ainda em andamento para antes (nunca roda junto com a tradução paga)
  const freshPaid = !isFreeLevel(meta.order.level) && !meta.order.replaces;
  await jobRunner.cancelPreview(bookId);
  let applied = false;
  let levelChanged = false;
  await store.update(bookId, (m) => {
    // conferido de novo dentro da trava: dois avisos ao mesmo tempo confirmam uma vez só
    if (!m.order || m.order.id !== orderId || m.order.status !== "awaiting_payment") return;
    m.order.status = "paid";
    m.order.payment = opts.payment;
    // a Grátis não custa nada (vale também para um pedido Padrão antigo, de antes da Grátis)
    if (opts.payment === "free") m.order.priceBrl = 0;
    m.order.paidAt = new Date().toISOString();
    delete m.order.expiresAt;
    if (opts.provider) m.order.paymentProvider = opts.provider;
    if (opts.externalId) m.order.externalId = opts.externalId;
    levelChanged = Boolean(m.level && m.level !== m.order.level);
    m.level = m.order.level;
    // o serviço é escolhido por dentro, conforme o tipo de tradução
    m.provider = undefined;
    applied = true;
  });
  if (!applied) return false;
  jobRunner.clearUpgradeHold(bookId);
  if (freshPaid) await discardFreeText(bookId);
  // troca da Grátis para a Literária com a Grátis ainda rodando: para antes, para o restante sair na Literária
  if (levelChanged && jobRunner.isRunning(bookId)) await jobRunner.pause(bookId);
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
