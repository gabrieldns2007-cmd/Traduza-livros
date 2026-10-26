/**
 * Experiência de compra: o cliente vê o preço da tradução (em reais), confirma
 * e a tradução começa sozinha, com o serviço escolhido por dentro. A Grátis é
 * R$ 0 e nunca passa por pagamento; se a cota de um serviço gratuito acabar,
 * segue com o próximo; se todos acabarem, espera e continua sozinha quando a
 * cota voltar. A Literária é paga, e trocar da Grátis para ela só acontece com
 * um pedido que o cliente confirma e paga.
 */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { writeEpub } from "@/services/export/epub-writer";
import { importBook } from "@/services/parsing/import-book";
import { config } from "@/lib/config";
import { DEFAULT_SETTINGS, store, writeSettings } from "@/lib/storage";
import { jobRunner, UPGRADE_HOLD_MS } from "@/services/processing/job-runner";
import { confirmOrder, markPaid, offerFor, placeOrder } from "@/services/commerce/orders";
import { applyPaymentEvent, paymentProvider } from "@/services/billing/payments";
import { simulatedProvider } from "@/services/billing/providers/simulated";
import { POST as webhook } from "@/app/api/payments/webhook/[provider]/route";
import { POST as orderPost } from "@/app/api/books/[id]/order/route";
import { POST as confirmPost } from "@/app/api/books/[id]/order/confirm/route";
import { GET as adminOverview } from "@/app/api/admin/overview/route";
import { recordExhausted } from "@/services/quota/usage";
import { routeProvider } from "@/services/commerce/routing";
import { loadBook, viewOf } from "@/lib/api";
import { POST as translatePost } from "@/app/api/books/[id]/translate/route";
import { FAQ } from "@/components/commerce/faq";
import { ProviderError } from "@/services/translation/llm/types";
import type { BatchInput, BatchOutput, TranslationProvider } from "@/services/translation/translation-provider";

const MODELS: Record<string, string> = {
  gemini: "gemini-3.8-flash",
  github: "openai/gpt-4.1",
  // o Llama saiu do plano grátis do Groq (16/08/2026): o modelo do Groq agora é o GPT-OSS
  groq: "openai/gpt-oss-120b",
  anthropic: "claude-sonnet-5-5",
};

/** Uma “tradução” de verdade dos trechos do livro de teste (passa na conferência da revisão automática). */
function pt(src: string): string {
  const p = /Paragraph (\d+) of chapter (\d+)/.exec(src);
  if (p) return `Parágrafo ${p[1]} do capítulo ${p[2]}: o faroleiro acendeu a lâmpada outra vez esta noite.`;
  const c = /Chapter (\d+)/.exec(src);
  return c ? `Capítulo ${c[1]}` : "O faroleiro";
}

class Fake implements TranslationProvider {
  paid = false;
  limits = { batchChars: 800, concurrency: 1 };
  calls = 0;
  model: string;
  constructor(
    public id: string,
    private quotaAfter = Infinity,
  ) {
    this.model = MODELS[id] ?? "fake";
  }
  async analyzeBook() {
    return { profile: { genre: "", tone: "", narrativeVoice: "", styleNotes: "" }, glossary: [], tocTranslations: [] };
  }
  async analyzeChapter() {
    return { summary: "", newTerms: [] };
  }
  async translateBatch(input: BatchInput): Promise<BatchOutput> {
    if (this.calls >= this.quotaAfter) {
      // como o contador real faz: anota que a cota deste serviço acabou
      await recordExhausted(this.id as "gemini", this.model, Date.now() + 60 * 60_000);
      throw new ProviderError("Limite gratuito atingido.", { fatal: true, code: "quota" });
    }
    this.calls++;
    return {
      translations: new Map(input.segments.map((s) => [s.id, pt(s.text)])),
      truncated: false,
      refused: false,
      usage: { inputTokens: 10, outputTokens: 10 },
    };
  }
}

async function book(chapters = 6) {
  const epub = await writeEpub({
    title: "The Keeper",
    language: "en",
    chapters: Array.from({ length: chapters }, (_, i) => ({
      title: `Chapter ${i + 1}`,
      body: Array.from({ length: 8 }, (_, j) => `<p>Paragraph ${j + 1} of chapter ${i + 1}: the keeper lit the lamp again tonight.</p>`).join(""),
    })),
  });
  return (await importBook(epub, { fileName: "keeper.epub", targetLanguage: "pt-BR" })).id;
}

async function until(bookId: string, statuses: string[], ms = 10_000) {
  for (let t = 0; t < ms; t += 25) {
    const m = (await store.get(bookId))!;
    if (statuses.includes(m.status) && !jobRunner.isRunning(bookId)) return m;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timeout");
}

beforeEach(async () => {
  await fs.rm(path.join(config.dataDir, "usage.json"), { force: true });
  await writeSettings({ ...DEFAULT_SETTINGS, geminiApiKey: "chave-gemini", groqApiKey: "chave-groq" });
});

afterEach(() => {
  delete process.env.CHECKOUT_MODE;
  delete process.env.PAYMENT_PROVIDER;
  delete process.env.ADMIN_PASSWORD;
  vi.restoreAllMocks();
});

/** Liga a Literária (paga, Anthropic) só neste teste — a chave é de mentira e o serviço é falso. */
async function withLiteraria() {
  const before = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-teste";
  onTestFinished(() => {
    if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = before;
  });
  await writeSettings({ ...DEFAULT_SETTINGS, geminiApiKey: "chave-gemini", groqApiKey: "chave-groq", offerLiteraria: true });
}

/** Serviços falsos: os gratuitos com cota opcional, e a Anthropic paga. */
function fakes(opts: { geminiQuota?: number; groqQuota?: number } = {}) {
  const gemini = new Fake("gemini", opts.geminiQuota);
  const groq = new Fake("groq", opts.groqQuota);
  const anthropic = new Fake("anthropic");
  anthropic.paid = true;
  const all: Record<string, Fake> = { gemini, groq, anthropic };
  jobRunner.providerFactory = (id) => all[id] ?? new Fake(id);
  return { gemini, groq, anthropic };
}

describe("compra de uma tradução", () => {
  it("mostra o preço em reais, trava no pedido e traduz ao confirmar (Grátis: R$ 0, sem pagamento)", async () => {
    const providers = new Map<string, Fake>();
    jobRunner.providerFactory = (id) => providers.get(id) ?? providers.set(id, new Fake(id)).get(id)!;
    const id = await book();
    const meta = (await store.get(id))!;

    const offer = await offerFor(meta);
    expect(offer.words).toBe(meta.totals.words);
    const free = offer.levels.find((l) => l.id === "padrao")!;
    expect(offer.levels[0].id).toBe("padrao"); // a Grátis vem primeiro
    expect(free).toMatchObject({ label: "Grátis", priceBrl: 0, free: true, available: true });
    // a Literária só aparece quando o administrador liga (usa um serviço pago)
    expect(offer.levels.find((l) => l.id === "literaria")!).toMatchObject({ free: false, available: false });
    // nada técnico na oferta
    expect(JSON.stringify(offer)).not.toMatch(/gemini|anthropic|token|modelo|model/i);

    const order = await placeOrder(meta, "padrao", { targetLanguage: "pt-BR" });
    expect(order.status).toBe("awaiting_payment");
    expect(order.priceBrl).toBe(0);

    const res = await confirmOrder((await store.get(id))!, "http://localhost");
    expect(res).toEqual({ started: true });
    const done = await until(id, ["done", "paused", "error"]);
    expect(done.status).toBe("done");
    expect(done.order!.status).toBe("paid");
    expect(done.order!.payment).toBe("free");
    expect(done.order!.priceBrl).toBe(0);
    expect(done.level).toBe("padrao");
    expect(done.runs!.at(-1)!.provider).toBe("gemini");

    // o que o navegador do cliente recebe não diz qual IA traduziu nem quanto custou
    const view = JSON.stringify(viewOf(done));
    expect(view).not.toMatch(/gemini|anthropic|costUsd|inputTokens":[1-9]/i);
    expect(view).not.toContain(MODELS.gemini);
  });

  it("a tradução Grátis nunca usa um serviço pago, mesmo se estiver na lista", async () => {
    await writeSettings({
      ...DEFAULT_SETTINGS,
      geminiApiKey: "chave-gemini",
      routing: { padrao: ["anthropic", "gemini"] },
    });
    const before = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-teste";
    onTestFinished(() => {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = before;
    });
    const route = await routeProvider("padrao", { ...DEFAULT_SETTINGS, geminiApiKey: "chave-gemini", routing: { padrao: ["anthropic", "gemini"] } });
    expect(route.ok && route.provider.id).toBe("gemini");
    // e, sem gratuitos com cota, espera — não troca para o pago
    await recordExhausted("gemini", MODELS.gemini, Date.now() + 60_000);
    const later = await routeProvider("padrao", { ...DEFAULT_SETTINGS, geminiApiKey: "chave-gemini", routing: { padrao: ["anthropic", "gemini"] } });
    expect(later.ok).toBe(false);
    // a Literária (paga) só existe quando o administrador liga
    expect((await routeProvider("literaria", DEFAULT_SETTINGS)).ok).toBe(false);
  });

  it("revisão automática: refaz os trechos que voltaram sem tradução", async () => {
    class EchoFirst extends Fake {
      async translateBatch(input: BatchInput): Promise<BatchOutput> {
        const out = await super.translateBatch(input);
        // os 2 primeiros pedidos “esquecem” de traduzir (devolvem o original)
        if (this.calls <= 2) for (const sg of input.segments) out.translations.set(sg.id, sg.text);
        return out;
      }
    }
    const provider = new EchoFirst("gemini");
    jobRunner.providerFactory = () => provider;
    const id = await book(4);
    await placeOrder((await store.get(id))!, "padrao", {});
    await confirmOrder((await store.get(id))!, "http://localhost");
    const m = await until(id, ["done", "paused", "error"]);
    expect(m.status).toBe("done");
    expect(m.review!.segments).toBeGreaterThan(0);
    expect(m.review!.finishedAt).toBeTruthy();
    for (const d of m.docs) {
      const doc = await store.readDoc(id, d.id);
      for (const sg of doc.segments) if (sg.src.includes("keeper")) expect(sg.out).toBe(pt(sg.src));
    }
  });

  it("cota de um serviço gratuito acaba: segue sozinho com o próximo, sem perder nada", async () => {
    const gemini = new Fake("gemini", 2);
    const groq = new Fake("groq");
    jobRunner.providerFactory = (id) => (id === "gemini" ? gemini : id === "groq" ? groq : new Fake(id));
    const id = await book(8);
    await placeOrder((await store.get(id))!, "padrao", {});
    await confirmOrder((await store.get(id))!, "http://localhost");
    const m = await until(id, ["done", "paused", "error"]);
    expect(m.status).toBe("done");
    expect(gemini.calls).toBe(2);
    expect(groq.calls).toBeGreaterThan(0);
    expect(new Set(m.runs!.map((r) => r.provider))).toEqual(new Set(["gemini", "groq"]));
    expect(m.progress.translatedSegments).toBe(m.totals.segments);
  });

  it("todos sem cota: espera e continua sozinho quando a cota volta", async () => {
    jobRunner.providerFactory = (id) => new Fake(id);
    await recordExhausted("gemini", MODELS.gemini, Date.now() + 1200);
    await recordExhausted("groq", MODELS.groq, Date.now() + 1200);
    const id = await book(2);
    await placeOrder((await store.get(id))!, "padrao", {});
    await confirmOrder((await store.get(id))!, "http://localhost");
    const waiting = await until(id, ["paused", "done", "error"]);
    expect(waiting.status).toBe("paused");
    expect(waiting.stopCode).toBe("waiting");
    expect(waiting.resumeAt).toBeTruthy();
    expect(waiting.error).toMatch(/continua sozinha/);
    // a retomada é agendada para logo depois que a cota volta (+5 s de folga)
    const done = await until(id, ["done"], 12_000);
    expect(done.status).toBe("done");
  }, 20_000);

  it("com pagamentos de verdade ligados e sem meio de pagamento, a Literária não começa sem pagar", async () => {
    await withLiteraria();
    const { anthropic } = fakes();
    process.env.CHECKOUT_MODE = "live";
    const id = await book(1);
    const order = await placeOrder((await store.get(id))!, "literaria", {});
    expect(order.priceBrl).toBe(9.9); // livro pequeno: preço mínimo da Literária
    await expect(confirmOrder((await store.get(id))!, "http://localhost")).rejects.toThrow(/pagamentos ainda não estão disponíveis/);
    expect((await store.get(id))!.status).toBe("ready");
    expect(anthropic.calls).toBe(0);
  });

  it("Grátis com pagamentos de verdade ligados: confirma na hora, sem abrir pagamento nenhum", async () => {
    process.env.CHECKOUT_MODE = "live";
    process.env.PAYMENT_PROVIDER = "simulado";
    const checkout = vi.spyOn(simulatedProvider, "createCheckout");
    const { gemini, anthropic } = fakes();
    const id = await book(1);
    const order = await placeOrder((await store.get(id))!, "padrao", {});
    expect(order.priceBrl).toBe(0);
    const res = await confirmOrder((await store.get(id))!, "https://verso.exemplo");
    expect(res).toEqual({ started: true });
    expect(res.checkoutUrl).toBeUndefined();
    expect(checkout).not.toHaveBeenCalled();
    const m = await until(id, ["done", "paused", "error"]);
    expect(m.status).toBe("done");
    expect(m.order).toMatchObject({ status: "paid", payment: "free", priceBrl: 0 });
    expect(gemini.calls).toBeGreaterThan(0);
    expect(anthropic.calls).toBe(0);
    // e nem um meio de pagamento é preciso: sem nenhum ligado, a Grátis confirma igual
    delete process.env.PAYMENT_PROVIDER;
    const other = await book(1);
    await placeOrder((await store.get(other))!, "padrao", {});
    expect(await confirmOrder((await store.get(other))!, "https://verso.exemplo")).toEqual({ started: true });
    expect((await until(other, ["done", "paused", "error"])).order!.payment).toBe("free");
    expect(checkout).not.toHaveBeenCalled();
  });

  it("painel: a Grátis aparece como R$ 0, sem custo de IA, fora do lucro e da margem", async () => {
    fakes();
    const id = await book(1);
    await placeOrder((await store.get(id))!, "padrao", {});
    await confirmOrder((await store.get(id))!, "http://localhost");
    await until(id, ["done", "paused", "error"]);
    const data = (await (await adminOverview()).json()) as {
      books: {
        id: string;
        order: { payment: string; priceBrl: number } | null;
        profitBrl: number;
        margin: number | null;
        estimatedCostBrl: number | null;
      }[];
      totals: { paidFree: number };
      pricing: { levels: { id: string; label: string; free: boolean; examples: unknown[] }[] };
    };
    const row = data.books.find((b) => b.id === id)!;
    expect(row.order).toMatchObject({ payment: "free", priceBrl: 0 });
    expect(row.profitBrl).toBe(0);
    expect(row.margin).toBeNull();
    expect(row.estimatedCostBrl).toBe(0);
    expect(data.totals.paidFree).toBeGreaterThanOrEqual(1);
    const [free, literaria] = data.pricing.levels;
    expect(free).toMatchObject({ id: "padrao", label: "Grátis", free: true, examples: [] });
    expect(literaria).toMatchObject({ id: "literaria", label: "Literária", free: false });
    expect(literaria.examples.length).toBeGreaterThan(0);
  });

  it("pedido Padrão antigo (com preço, de antes da Grátis) sai grátis e sem pagamento", async () => {
    process.env.CHECKOUT_MODE = "live";
    process.env.PAYMENT_PROVIDER = "simulado";
    const checkout = vi.spyOn(simulatedProvider, "createCheckout");
    fakes();
    const id = await book(1);
    await store.update(id, (m) => {
      m.level = "padrao";
      m.order = {
        id: "ord_antigo",
        level: "padrao",
        words: m.totals.words,
        priceBrl: 9.9,
        status: "awaiting_payment",
        payment: null,
        createdAt: m.createdAt,
      };
    });
    expect(await confirmOrder((await store.get(id))!, "https://verso.exemplo")).toEqual({ started: true });
    expect(checkout).not.toHaveBeenCalled();
    const m = await until(id, ["done", "paused", "error"]);
    expect(m.order).toMatchObject({ id: "ord_antigo", status: "paid", payment: "free", priceBrl: 0 });
  });

  it("um pedido pago nunca é confirmado como grátis", async () => {
    await withLiteraria();
    const { anthropic } = fakes();
    process.env.CHECKOUT_MODE = "live";
    const id = await book(1);
    const order = await placeOrder((await store.get(id))!, "literaria", {});
    expect(await markPaid(id, order.id, { payment: "free" })).toBe(false);
    const m = (await store.get(id))!;
    expect(m.order).toMatchObject({ status: "awaiting_payment", payment: null, priceBrl: order.priceBrl });
    expect(m.status).toBe("ready");
    expect(anthropic.calls).toBe(0);
  });

  it("aviso de pagamento do pedido inicia a tradução uma única vez", async () => {
    await withLiteraria();
    const { anthropic } = fakes();
    process.env.CHECKOUT_MODE = "live";
    const id = await book(1);
    const order = await placeOrder((await store.get(id))!, "literaria", {});
    const event = {
      kind: "purchase.completed" as const,
      accountId: "local",
      productId: `order:${id}:${order.id}`,
      externalId: "pay_1",
      amountBrl: order.priceBrl,
    };
    // dois avisos ao mesmo tempo: só um confirma
    expect(await Promise.all([applyPaymentEvent(event), applyPaymentEvent(event)])).toEqual(expect.arrayContaining([true, false]));
    expect(await applyPaymentEvent(event)).toBe(false);
    const m = await until(id, ["done", "paused", "error"]);
    expect(m.status).toBe("done");
    expect(m.order!.payment).toBe("provider");
    expect(m.order!.externalId).toBe("pay_1");
    expect(m.level).toBe("literaria");
    expect(anthropic.calls).toBeGreaterThan(0);
    expect(new Set(m.runs!.map((r) => r.provider))).toEqual(new Set(["anthropic"]));
  });

  it("pagamento simulado: página de pagamento → aviso assinado → tradução começa (sem dinheiro)", async () => {
    await withLiteraria();
    fakes();
    process.env.CHECKOUT_MODE = "live";
    process.env.PAYMENT_PROVIDER = "simulado";
    const id = await book(1);
    const order = await placeOrder((await store.get(id))!, "literaria", {});
    const res = await confirmOrder((await store.get(id))!, "https://verso.exemplo");
    expect(res.started).toBe(false);
    expect(res.checkoutUrl).toMatch(/^\/pagamento\/simulado\?s=/);
    const token = decodeURIComponent(res.checkoutUrl!.split("s=")[1]);
    const call = (body: unknown, headers: Record<string, string> = {}) =>
      webhook(new Request("http://x/api/payments/webhook/simulado", { method: "POST", headers, body: JSON.stringify(body) }), {
        params: Promise.resolve({ provider: "simulado" }),
      });

    // sessão alterada: recusada
    expect((await call({ s: token.replace(/^./, "x"), result: "approved" })).status).toBe(400);
    // com senha de administrador, só o administrador aprova
    process.env.ADMIN_PASSWORD = "segredo";
    expect((await call({ s: token, result: "approved" })).status).toBe(403);
    delete process.env.ADMIN_PASSWORD;
    // ainda não pago: a tradução não começou
    expect((await store.get(id))!.order!.status).toBe("awaiting_payment");

    const ok = await call({ s: token, result: "approved" });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { applied: boolean }).applied).toBe(true);
    // reenvio do mesmo aviso: ignorado
    expect(((await (await call({ s: token, result: "approved" })).json()) as { applied: boolean }).applied).toBe(false);
    const m = await until(id, ["done", "paused", "error"]);
    expect(m.status).toBe("done");
    expect(m.order!.payment).toBe("provider");
    expect(m.order!.paymentProvider).toBe("simulado");
    expect(m.order!.priceBrl).toBe(order.priceBrl);
  });

  it("aviso de pagamento com valor menor que o preço não libera a tradução", async () => {
    await withLiteraria();
    process.env.CHECKOUT_MODE = "live";
    const id = await book(1);
    const order = await placeOrder((await store.get(id))!, "literaria", {});
    const applied = await applyPaymentEvent({
      kind: "purchase.completed",
      accountId: "local",
      productId: `order:${id}:${order.id}`,
      externalId: "pay_baixo",
      amountBrl: order.priceBrl - 5,
    });
    expect(applied).toBe(false);
    expect((await store.get(id))!.order!.status).toBe("awaiting_payment");
    // o que foi pago fica anotado para devolver
    expect((await store.get(id))!.paymentsToRefund).toEqual([
      expect.objectContaining({ orderId: order.id, externalId: "pay_baixo", amountBrl: order.priceBrl - 5, reason: "valor menor que o preço" }),
    ]);
    expect(paymentProvider(null)).toBeNull();
  });
});

describe("da Grátis para a Literária (só por escolha do cliente)", () => {
  /** Livro na Grátis, parado à espera dos serviços gratuitos (todos sem cota por 1 hora). */
  async function waitingFreeBook() {
    const providers = fakes({ geminiQuota: 2, groqQuota: 0 });
    const id = await book(8);
    await placeOrder((await store.get(id))!, "padrao", {});
    await confirmOrder((await store.get(id))!, "http://localhost");
    const m = await until(id, ["paused", "done", "error"]);
    expect(m.status).toBe("paused");
    expect(m.stopCode).toBe("waiting");
    expect(m.order).toMatchObject({ status: "paid", payment: "free", priceBrl: 0 });
    expect(m.progress.translatedWords).toBeGreaterThan(0);
    expect(m.progress.translatedWords).toBeLessThan(m.totals.words);
    return { id, ...providers };
  }

  it("pedido novo só das palavras que faltam, pago pelo caminho normal; a Grátis fica parada até o pagamento", async () => {
    await withLiteraria();
    process.env.CHECKOUT_MODE = "live";
    process.env.PAYMENT_PROVIDER = "simulado";
    const { id, gemini, anthropic } = await waitingFreeBook();
    const before = (await store.get(id))!;
    const remaining = before.totals.words - before.progress.translatedWords;
    const freeOrder = before.order!;

    // nada muda sozinho: continua na Grátis, esperando, sem chamar o serviço pago
    expect(before.level).toBe("padrao");
    expect(anthropic.calls).toBe(0);
    // a oferta mostra o valor da Literária só para o que falta
    const offer = await offerFor(before);
    expect(offer.words).toBe(remaining);
    const literaria = offer.levels.find((l) => l.id === "literaria")!;
    expect(literaria).toMatchObject({ available: true, free: false });
    expect(literaria.priceBrl).toBeGreaterThan(0);
    // pedir a Grátis de novo não faz sentido (já está confirmada)
    await expect(placeOrder(before, "padrao", {})).rejects.toThrow(/já foi confirmada/);

    // o cliente escolhe a Literária: pedido novo, preço só do que falta, esperando o pagamento
    const order = await placeOrder(before, "literaria", {});
    expect(order).toMatchObject({ level: "literaria", status: "awaiting_payment", words: remaining, replaces: freeOrder.id });
    // a Grátis espera parada por no máximo 2 horas
    expect(Math.abs(Date.parse(order.expiresAt!) - (Date.now() + UPGRADE_HOLD_MS))).toBeLessThan(5_000);
    expect(order.priceBrl).toBe(literaria.priceBrl);
    let m = (await store.get(id))!;
    // o tipo do livro só muda quando o pagamento chega; a Grátis fica parada (não volta sozinha)
    expect(m.level).toBe("padrao");
    expect(m.status).toBe("paused");
    expect(m.stopCode).toBeUndefined();
    expect(m.resumeAt).toBeUndefined();

    // confirmar abre o pagamento normal; nada é traduzido antes de pagar
    const res = await confirmOrder(m, "https://verso.exemplo");
    expect(res.started).toBe(false);
    expect(res.checkoutUrl).toMatch(/^\/pagamento\/simulado\?s=/);
    m = (await store.get(id))!;
    expect(m.status).toBe("paused");
    expect(m.progress.translatedWords).toBe(before.progress.translatedWords);
    expect(anthropic.calls).toBe(0);

    // pagamento menor que o preço: ignorado
    const event = { kind: "purchase.completed" as const, accountId: "local", productId: `order:${id}:${order.id}`, externalId: "pay_up" };
    expect(await applyPaymentEvent({ ...event, amountBrl: order.priceBrl - 1 })).toBe(false);
    expect((await store.get(id))!.level).toBe("padrao");

    // pago: o restante sai na Literária, do mesmo ponto, sem refazer o que a Grátis traduziu
    const geminiCalls = gemini.calls;
    expect(await applyPaymentEvent({ ...event, amountBrl: order.priceBrl })).toBe(true);
    m = await until(id, ["done", "paused", "error"]);
    expect(m.status).toBe("done");
    expect(m.level).toBe("literaria");
    expect(m.order).toMatchObject({ id: order.id, status: "paid", payment: "provider", priceBrl: order.priceBrl, replaces: freeOrder.id });
    expect(anthropic.calls).toBeGreaterThan(0);
    expect(gemini.calls).toBe(geminiCalls);
    expect(m.progress.translatedSegments).toBe(m.totals.segments);
    expect(m.runs!.at(-1)!.provider).toBe("anthropic");
    expect(m.order!.expiresAt).toBeUndefined();
    // o que a Grátis já tinha traduzido fica como está (o pedido cobriu só o restante)
    const engines = new Set<string>();
    for (const d of m.docs) for (const sg of (await store.readDoc(id, d.id)).segments) if (sg.by) engines.add(sg.by.split("/")[0]);
    expect(engines).toEqual(new Set(["gemini", "anthropic"]));

    // um pedido pago nunca volta para a Grátis
    await expect(placeOrder(m, "padrao", {})).rejects.toThrow(/já foi traduzido|tradução paga/);
  });

  it("desistir antes de pagar: a Grátis segue do mesmo ponto, e o pagamento antigo não troca nada", async () => {
    await withLiteraria();
    process.env.CHECKOUT_MODE = "live";
    process.env.PAYMENT_PROVIDER = "simulado";
    const { id, anthropic } = await waitingFreeBook();
    const before = (await store.get(id))!;
    const upgrade = await placeOrder(before, "literaria", {});
    await confirmOrder((await store.get(id))!, "https://verso.exemplo");

    // o cliente volta e escolhe a Grátis de novo: pedido grátis (R$ 0), sem pagamento
    const back = await placeOrder((await store.get(id))!, "padrao", {});
    expect(back).toMatchObject({ level: "padrao", priceBrl: 0 });
    expect(back.replaces).toBeUndefined();
    expect(await confirmOrder((await store.get(id))!, "https://verso.exemplo")).toEqual({ started: true });
    // os gratuitos ainda estão sem cota: volta a esperar, e continua sozinha depois
    let m = await until(id, ["paused", "done", "error"]);
    expect(m).toMatchObject({ status: "paused", stopCode: "waiting", level: "padrao" });
    expect(m.resumeAt).toBeTruthy();
    expect(m.order).toMatchObject({ id: back.id, status: "paid", payment: "free", priceBrl: 0 });

    // o aviso de pagamento do pedido abandonado chega depois: ignorado, nada muda para pago
    const late = await applyPaymentEvent({
      kind: "purchase.completed",
      accountId: "local",
      productId: `order:${id}:${upgrade.id}`,
      externalId: "pay_tarde",
      amountBrl: upgrade.priceBrl,
    });
    expect(late).toBe(false);
    m = (await store.get(id))!;
    expect(m.level).toBe("padrao");
    expect(m.order!.id).toBe(back.id);
    expect(anthropic.calls).toBe(0);
    // nunca vira venda: fica anotado para reembolso (uma vez só, mesmo com o aviso repetido)
    expect(m.paymentsToRefund).toEqual([expect.objectContaining({ orderId: upgrade.id, externalId: "pay_tarde", amountBrl: upgrade.priceBrl })]);
    await applyPaymentEvent({
      kind: "purchase.completed",
      accountId: "local",
      productId: `order:${id}:${upgrade.id}`,
      externalId: "pay_tarde",
      amountBrl: upgrade.priceBrl,
    });
    expect((await store.get(id))!.paymentsToRefund).toHaveLength(1);
    expect(m.orderHistory!.find((o) => o.id === upgrade.id)).toMatchObject({ status: "canceled" });
  });

  it("pela tela (rotas do pedido), no beta: a troca confirma e o restante sai na Literária", async () => {
    await withLiteraria();
    const { id, anthropic } = await waitingFreeBook();
    const ctx = { params: Promise.resolve({ id }) };
    const placed = await orderPost(
      new Request(`http://x/api/books/${id}/order`, { method: "POST", body: JSON.stringify({ level: "literaria" }) }),
      ctx,
    );
    expect(placed.status).toBe(200);
    const { order, offer } = (await placed.json()) as { order: { priceBrl: number; replaces?: string }; offer: { words: number } };
    expect(order.replaces).toBeTruthy();
    expect(order.priceBrl).toBeGreaterThan(0);
    // a resposta não diz qual IA vai traduzir
    expect(JSON.stringify(offer)).not.toMatch(/anthropic|gemini|claude/i);
    const confirmed = await confirmPost(new Request(`http://x/api/books/${id}/order/confirm`, { method: "POST" }), ctx);
    expect(((await confirmed.json()) as { started: boolean }).started).toBe(true);
    const m = await until(id, ["done", "paused", "error"]);
    expect(m.status).toBe("done");
    expect(m.order).toMatchObject({ level: "literaria", status: "paid", payment: "beta" });
    expect(anthropic.calls).toBeGreaterThan(0);
  });

  it("a Literária paga em andamento nunca vira Grátis", async () => {
    await withLiteraria();
    const { anthropic } = fakes();
    // no beta, a Literária confirma sem cobrança (mas continua sendo a Literária)
    const id = await book(2);
    await placeOrder((await store.get(id))!, "literaria", {});
    expect(await confirmOrder((await store.get(id))!, "http://localhost")).toEqual({ started: true });
    await until(id, ["done", "paused", "error"]);
    expect(anthropic.calls).toBeGreaterThan(0);
    await store.update(id, (m) => {
      m.status = "paused";
    });
    const paused = (await store.get(id))!;
    expect(paused.order).toMatchObject({ level: "literaria", status: "paid", payment: "beta" });
    await expect(placeOrder(paused, "padrao", {})).rejects.toThrow(/tradução paga/);
    await expect(placeOrder(paused, "literaria", {})).rejects.toThrow(/tradução paga/);
    expect((await store.get(id))!.order!.level).toBe("literaria");
  });
});

/* ---------------------------------------------------------------- amostra, prazo da troca e pagamentos a devolver */

const previewReq = (id: string) => new Request(`http://x/api/books/${id}/translate`, { method: "POST", body: JSON.stringify({ action: "preview" }) });

/** Serviços (“provedor/modelo”) que gravaram algum trecho do livro. */
async function enginesOf(id: string): Promise<Set<string>> {
  const m = (await store.get(id))!;
  const out = new Set<string>();
  for (const d of m.docs) for (const sg of (await store.readDoc(id, d.id)).segments) if (sg.by) out.add(sg.by.split("/")[0]);
  return out;
}

/** Diretório de dados só deste teste (um processo novo lê tudo dele, como depois de reiniciar o servidor). */
function isolatedData() {
  const before = process.env.DATA_DIR;
  process.env.DATA_DIR = fsSync.mkdtempSync(path.join(os.tmpdir(), "verso-pedidos-"));
  onTestFinished(() => {
    process.env.DATA_DIR = before;
  });
}

describe("a amostra grátis e a Literária nunca se misturam", () => {
  it("Literária nova depois da amostra: o trecho da amostra entra no preço e sai do livro — o livro pago é todo do serviço pago", async () => {
    await withLiteraria();
    const { gemini, anthropic } = fakes();
    const id = await book(3);
    const ctx = { params: Promise.resolve({ id }) };
    expect((await translatePost(previewReq(id), ctx)).status).toBe(200);
    for (let i = 0; i < 200 && (await store.get(id))!.preview?.status !== "done"; i++) await new Promise((r) => setTimeout(r, 25));
    const before = (await store.get(id))!;
    expect(before.preview?.status).toBe("done");
    expect(before.progress.translatedWords).toBeGreaterThan(0);

    // a oferta e o pedido usam a mesma conta: a Literária cobre o livro todo (a amostra foi feita pela Grátis)
    const offer = await offerFor(before);
    const lit = offer.levels.find((l) => l.id === "literaria")!;
    expect(lit.words).toBe(before.totals.words);
    expect(offer.levels.find((l) => l.free)!.words).toBe(before.totals.words - before.progress.translatedWords);
    const order = await placeOrder(before, "literaria", {});
    expect(order).toMatchObject({ words: before.totals.words, priceBrl: lit.priceBrl });
    expect(order.replaces).toBeUndefined();

    // com a Literária escolhida, a amostra grátis não é mais feita (nem pela rota, nem pelo motor)
    expect((await translatePost(previewReq(id), ctx)).status).toBe(409);
    await expect(jobRunner.preview(id, "gemini")).rejects.toThrow(/Literária/);

    const geminiCalls = gemini.calls;
    expect(await confirmOrder((await store.get(id))!, "http://localhost")).toEqual({ started: true });
    const m = await until(id, ["done", "paused", "error"]);
    expect(m.status).toBe("done");
    expect(m.level).toBe("literaria");
    expect(m.preview).toBeUndefined();
    expect(gemini.calls).toBe(geminiCalls);
    expect(anthropic.calls).toBeGreaterThan(0);
    expect(await enginesOf(id)).toEqual(new Set(["anthropic"]));
    expect(m.chapters.some((c) => c.provider === "gemini")).toBe(false);
  });

  it("pedido pago com a amostra ainda em andamento: a amostra para antes, e nada dela fica no livro pago", async () => {
    await withLiteraria();
    const { anthropic } = fakes();
    /** Serviço gratuito que só responde quando é cancelado (a amostra fica “em andamento”). */
    class Stuck extends Fake {
      started = false;
      async translateBatch(input: BatchInput): Promise<BatchOutput> {
        this.started = true;
        await new Promise((_, reject) => {
          const stop = () => reject(input.signal?.reason ?? new Error("aborted"));
          if (input.signal?.aborted) stop();
          input.signal?.addEventListener("abort", stop, { once: true });
        });
        return super.translateBatch(input);
      }
    }
    const stuck = new Stuck("gemini");
    jobRunner.providerFactory = (id) => (id === "gemini" ? stuck : id === "anthropic" ? anthropic : new Fake(id));
    const id = await book(2);
    await jobRunner.preview(id, "gemini");
    for (let i = 0; i < 200 && !stuck.started; i++) await new Promise((r) => setTimeout(r, 10));
    expect(jobRunner.isPreviewing(id)).toBe(true);
    await placeOrder((await store.get(id))!, "literaria", {});
    expect(await confirmOrder((await store.get(id))!, "http://localhost")).toEqual({ started: true });
    // a amostra já tinha terminado (cancelada) quando a tradução paga começou
    expect(jobRunner.isPreviewing(id)).toBe(false);
    const m = await until(id, ["done", "paused", "error"]);
    expect(m.status).toBe("done");
    expect(m.preview).toBeUndefined();
    expect(await enginesOf(id)).toEqual(new Set(["anthropic"]));
  });
});

describe("troca para a Literária sem pagamento: prazo de 2 horas", () => {
  it("vencido o prazo, a troca é cancelada, o pedido grátis volta a valer e a Grátis segue sozinha", async () => {
    await withLiteraria();
    process.env.CHECKOUT_MODE = "live";
    process.env.PAYMENT_PROVIDER = "simulado";
    const providers = fakes({ geminiQuota: 2, groqQuota: 0 });
    const id = await book(8);
    await placeOrder((await store.get(id))!, "padrao", {});
    await confirmOrder((await store.get(id))!, "http://localhost");
    const waiting = await until(id, ["paused", "done", "error"]);
    expect(waiting.stopCode).toBe("waiting");
    const freeOrder = waiting.order!;

    const upgrade = await placeOrder(waiting, "literaria", {});
    await confirmOrder((await store.get(id))!, "https://verso.exemplo"); // abre o pagamento, e o cliente sai sem pagar
    // ainda no prazo: nada muda
    expect(await jobRunner.expireUpgrade(id)).toBe(false);
    expect((await store.get(id))!.order!.id).toBe(upgrade.id);

    // o prazo acaba (sem esperar 2 h de verdade): ao abrir o livro, a troca é encerrada na hora
    await store.update(id, (m) => {
      m.order!.expiresAt = new Date(Date.now() - 1_000).toISOString();
    });
    const opened = (await loadBook(id))!;
    expect(opened.order).toMatchObject({ id: freeOrder.id, status: "paid", payment: "free", priceBrl: 0 });
    const m = await until(id, ["paused", "done", "error"]);
    // os gratuitos ainda estão sem cota: a Grátis volta a esperar, com a volta agendada
    expect(m).toMatchObject({ status: "paused", stopCode: "waiting", level: "padrao" });
    expect(m.resumeAt).toBeTruthy();
    expect(m.orderHistory!.at(-1)).toMatchObject({ id: upgrade.id, status: "canceled" });
    expect(m.orderHistory!.some((o) => o.id === freeOrder.id)).toBe(false);

    // pagamento atrasado da troca cancelada: nunca vira venda, fica para reembolsar
    const late = await applyPaymentEvent({
      kind: "purchase.completed",
      accountId: "local",
      productId: `order:${id}:${upgrade.id}`,
      externalId: "pay_atrasado",
      amountBrl: upgrade.priceBrl,
      provider: "simulado",
    });
    expect(late).toBe(false);
    const after = (await store.get(id))!;
    expect(after.order!.id).toBe(freeOrder.id);
    expect(after.paymentsToRefund).toEqual([expect.objectContaining({ orderId: upgrade.id, externalId: "pay_atrasado", provider: "simulado" })]);
    expect(providers.anthropic.calls).toBe(0);
    // e o cliente pode pedir a troca de novo (a Grátis confirmada continua valendo)
    expect((await placeOrder(after, "literaria", {})).replaces).toBe(freeOrder.id);
  });

  it("depois de reiniciar: o prazo volta a ser agendado (um pedido antigo, sem prazo, ganha um) e o pedido Padrão do beta vira grátis", async () => {
    isolatedData();
    await withLiteraria();
    fakes();
    const createdAt = new Date().toISOString();
    const pending = await book(1);
    await store.update(pending, (m) => {
      m.status = "paused";
      m.level = "padrao";
      m.orderHistory = [
        { id: "ord_gratis", level: "padrao", words: m.totals.words, priceBrl: 0, status: "paid", payment: "free", createdAt, paidAt: createdAt },
      ];
      m.order = {
        id: "ord_troca",
        level: "literaria",
        words: m.totals.words,
        priceBrl: 9.9,
        status: "awaiting_payment",
        payment: null,
        createdAt,
        replaces: "ord_gratis",
      };
    });
    const legacy = await book(1);
    await store.update(legacy, (m) => {
      m.status = "done";
      m.level = "padrao";
      m.order = {
        id: "ord_beta",
        level: "padrao",
        words: m.totals.words,
        priceBrl: 13.9,
        status: "paid",
        payment: "beta",
        createdAt,
        paidAt: createdAt,
      };
    });

    const Runner = jobRunner.constructor as new () => typeof jobRunner;
    const fresh = new Runner();
    fresh.providerFactory = jobRunner.providerFactory;
    await fresh.init();
    const holds = (fresh as unknown as { holds: Map<string, ReturnType<typeof setTimeout>> }).holds;
    expect(holds.has(pending)).toBe(true);
    const m = (await store.get(pending))!;
    expect(Math.abs(Date.parse(m.order!.expiresAt!) - (Date.now() + UPGRADE_HOLD_MS))).toBeLessThan(5_000);
    // pedido Padrão confirmado no beta, com preço: é a tradução grátis — R$ 0, nunca cobrado
    expect((await store.get(legacy))!.order).toMatchObject({ id: "ord_beta", status: "paid", payment: "free", priceBrl: 0 });

    // vencido: o próprio motor encerra a troca e a Grátis segue do mesmo ponto
    fresh.clearUpgradeHold(pending);
    expect(await fresh.expireUpgrade(pending, Date.now() + UPGRADE_HOLD_MS + 1_000)).toBe(true);
    for (let i = 0; i < 400 && ((await store.get(pending))!.status !== "done" || fresh.isRunning(pending)); i++)
      await new Promise((r) => setTimeout(r, 25));
    const done = (await store.get(pending))!;
    expect(done.status).toBe("done");
    expect(done.order).toMatchObject({ id: "ord_gratis", payment: "free" });
    expect(await enginesOf(pending)).toEqual(new Set(["gemini"]));
  });

  it("antes de pagar, o painel diz o que acontece se a pessoa não pagar (e é o que o código faz: 2 horas)", async () => {
    const panel = await fs.readFile(path.join(process.cwd(), "components/commerce/order-panel.tsx"), "utf8");
    expect(panel).toContain("Se você não concluir o pagamento, a tradução grátis volta a seguir sozinha em até 2 horas.");
    expect(UPGRADE_HOLD_MS).toBe(2 * 3600_000);
  });
});

describe("pagamento que não vale como venda", () => {
  it("pagamento de um pedido da Grátis (pedido Padrão antigo): a tradução é confirmada grátis e o valor fica para reembolsar", async () => {
    process.env.CHECKOUT_MODE = "live";
    process.env.PAYMENT_PROVIDER = "simulado";
    const { gemini } = fakes();
    const id = await book(1);
    await store.update(id, (m) => {
      m.level = "padrao";
      m.order = {
        id: "ord_antigo",
        level: "padrao",
        words: m.totals.words,
        priceBrl: 29.9,
        status: "awaiting_payment",
        payment: null,
        createdAt: m.createdAt,
      };
    });
    const event = {
      kind: "purchase.completed" as const,
      accountId: "local",
      productId: `order:${id}:ord_antigo`,
      externalId: "pay_antigo",
      amountBrl: 29.9,
      provider: "simulado",
    };
    expect(await applyPaymentEvent(event)).toBe(true);
    expect(await applyPaymentEvent(event)).toBe(false); // reenvio do mesmo aviso
    const m = await until(id, ["done", "paused", "error"]);
    expect(m.status).toBe("done");
    expect(gemini.calls).toBeGreaterThan(0);
    expect(m.order).toMatchObject({ status: "paid", payment: "free", priceBrl: 0 });
    expect(m.paymentsToRefund).toEqual([
      expect.objectContaining({ orderId: "ord_antigo", externalId: "pay_antigo", amountBrl: 29.9, provider: "simulado" }),
    ]);

    // painel: não é receita, e aparece como pagamento para reembolsar
    const data = (await (await adminOverview()).json()) as {
      books: { id: string; revenueBrl: number; toRefund: unknown[] }[];
      totals: { toRefund: number; toRefundBrl: number; revenueBrl: number };
    };
    const row = data.books.find((b) => b.id === id)!;
    expect(row.revenueBrl).toBe(0);
    expect(row.toRefund).toHaveLength(1);
    expect(data.totals.toRefund).toBeGreaterThanOrEqual(1);
    expect(data.totals.toRefundBrl).toBeGreaterThanOrEqual(29.9);
    const dashboard = await fs.readFile(path.join(process.cwd(), "components/admin/admin-dashboard.tsx"), "utf8");
    expect(dashboard).toContain("Pagamento recebido para reembolsar");
    // o cliente não vê nada disso
    expect(JSON.stringify(viewOf(m))).not.toContain("pay_antigo");
  });

  it("pedido Padrão confirmado no beta com preço conta como grátis: troca para a Literária aceita e nada vira receita", async () => {
    await withLiteraria();
    const { id } = await (async () => {
      fakes({ geminiQuota: 2, groqQuota: 0 });
      const bookId = await book(8);
      await placeOrder((await store.get(bookId))!, "padrao", {});
      await confirmOrder((await store.get(bookId))!, "http://localhost");
      await until(bookId, ["paused", "done", "error"]);
      return { id: bookId };
    })();
    // simula o pedido antigo: Padrão confirmado no beta, com preço
    await store.update(id, (m) => {
      m.order!.payment = "beta";
      m.order!.priceBrl = 13.9;
    });
    const data = (await (await adminOverview()).json()) as {
      books: { id: string; revenueBrl: number; profitBrl: number; margin: number | null }[];
    };
    expect(data.books.find((b) => b.id === id)).toMatchObject({ revenueBrl: 0, profitBrl: 0, margin: null });
    const m = (await store.get(id))!;
    const up = await placeOrder(m, "literaria", {});
    expect(up).toMatchObject({ replaces: m.order!.id, words: m.totals.words - m.progress.translatedWords });
  });
});

describe("textos para o cliente", () => {
  // o texto como aparece na tela: as quebras de linha do código viram um espaço
  const read = async (f: string) => (await fs.readFile(path.join(process.cwd(), f), "utf8")).replace(/\s+/g, " ");

  it("termos: 18 anos ou mais e a Grátis fora do EEE, da Suíça e do Reino Unido; o pedido diz o mesmo", async () => {
    const terms = await read("app/termos/page.tsx");
    expect(terms).toContain("É preciso ter 18 anos ou mais para usar o Verso.");
    expect(terms).toMatch(/não é oferecida a quem está no Espaço Econômico Europeu, na Suíça ou no Reino Unido/);
    const panel = await read("components/commerce/order-panel.tsx");
    expect(panel).toMatch(/18 anos ou mais/);
    expect(panel).toMatch(/Espaço Econômico Europeu, na Suíça ou no Reino Unido/);
  });

  it("páginas legais: sem “API”, com todos os serviços gratuitos pelo nome (e a Mistral, que treina por padrão) e a amostra", async () => {
    for (const f of ["app/termos/page.tsx", "app/privacidade/page.tsx"]) {
      const text = await read(f);
      expect(text).not.toMatch(/\bAPI\b/);
      expect(text).toContain("o serviço gratuito de IA do Google (Gemini)");
      for (const name of ["Groq", "Cloudflare", "Mistral"]) expect(text).toContain(name);
      expect(text).toMatch(/Mistral, no modo gratuito[,:] usa o texto para treinar/);
    }
    expect(await read("app/privacidade/page.tsx")).toMatch(/Amostra grátis:.*é feita pela tradução grátis/s);
  });

  it("aviso de privacidade forte na hora da escolha, na amostra e nas perguntas frequentes", async () => {
    const strong = "podem guardar o texto, usá-lo para treinar IA e permitir que pessoas o leiam. Não use para textos confidenciais.";
    const panel = await read("components/commerce/order-panel.tsx");
    expect(panel).toContain(strong);
    expect(panel).toMatch(/Quer ler antes de decidir\?[\s\S]{0,600}FREE_PRIVACY/);
    expect(FAQ.some(([, a]) => a.includes(strong))).toBe(true);
  });

  it("os botões longos quebram a linha numa tela de 320 px (o Button não quebra por padrão)", async () => {
    const panel = await read("components/commerce/order-panel.tsx");
    expect(panel).toMatch(/className="mt-5 min-h-14 w-full !h-auto py-3 text-center !whitespace-normal"/);
    expect(panel).not.toContain("Começar tradução — grátis no beta");
    const progress = await read("components/commerce/order-progress.tsx");
    expect(progress).toMatch(/!whitespace-normal[^"]*"\s*>\s*Traduzir o restante na Literária/);
    // no beta, a troca não diz “paga”; a hora de volta é uma tentativa, não uma promessa
    expect(progress).toContain("sem custo durante o beta");
    expect(progress).toContain("Vamos tentar de novo");
  });
});
