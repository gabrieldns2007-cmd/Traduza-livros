/**
 * Experiência de compra: o cliente vê o preço da tradução (em reais), confirma
 * e a tradução começa sozinha, com o serviço escolhido por dentro. Se a cota de
 * um serviço gratuito acabar, segue com o próximo; se todos acabarem, espera e
 * continua sozinha quando a cota voltar.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { writeEpub } from "@/services/export/epub-writer";
import { importBook } from "@/services/parsing/import-book";
import { config } from "@/lib/config";
import { DEFAULT_SETTINGS, store, writeSettings } from "@/lib/storage";
import { jobRunner } from "@/services/processing/job-runner";
import { confirmOrder, offerFor, placeOrder } from "@/services/commerce/orders";
import { applyPaymentEvent, paymentProvider } from "@/services/billing/payments";
import { POST as webhook } from "@/app/api/payments/webhook/[provider]/route";
import { recordExhausted } from "@/services/quota/usage";
import { routeProvider } from "@/services/commerce/routing";
import { viewOf } from "@/lib/api";
import { ProviderError } from "@/services/translation/llm/types";
import type { BatchInput, BatchOutput, TranslationProvider } from "@/services/translation/translation-provider";

const MODELS: Record<string, string> = {
  gemini: "gemini-3.8-flash",
  github: "openai/gpt-4.1",
  groq: "llama-3.3-70b-versatile",
  anthropic: "claude-sonnet-5-5",
};

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
      translations: new Map(input.segments.map((s) => [s.id, `PT ${s.text}`])),
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
  await writeSettings({ ...DEFAULT_SETTINGS, geminiApiKey: "chave-gemini", githubToken: "token-github" });
});

afterEach(() => {
  delete process.env.CHECKOUT_MODE;
  delete process.env.PAYMENT_PROVIDER;
  delete process.env.ADMIN_PASSWORD;
});

describe("compra de uma tradução", () => {
  it("mostra o preço em reais, trava no pedido e traduz ao confirmar (beta: sem cobrança)", async () => {
    const providers = new Map<string, Fake>();
    jobRunner.providerFactory = (id) => providers.get(id) ?? providers.set(id, new Fake(id)).get(id)!;
    const id = await book();
    const meta = (await store.get(id))!;

    const offer = await offerFor(meta);
    expect(offer.words).toBe(meta.totals.words);
    const padrao = offer.levels.find((l) => l.id === "padrao")!;
    expect(padrao.priceBrl).toBe(9.9); // livro pequeno: preço mínimo
    expect(padrao.available).toBe(true);
    // a Literária só aparece quando o administrador liga (usa um serviço pago)
    expect(offer.levels.find((l) => l.id === "literaria")!.available).toBe(false);
    // nada técnico na oferta
    expect(JSON.stringify(offer)).not.toMatch(/gemini|anthropic|token|modelo|model/i);

    const order = await placeOrder(meta, "padrao", { targetLanguage: "pt-BR" });
    expect(order.status).toBe("awaiting_payment");
    expect(order.priceBrl).toBe(9.9);

    const res = await confirmOrder((await store.get(id))!, "http://localhost");
    expect(res.started).toBe(true);
    const done = await until(id, ["done", "paused", "error"]);
    expect(done.status).toBe("done");
    expect(done.order!.status).toBe("paid");
    expect(done.order!.payment).toBe("beta");
    expect(done.runs!.at(-1)!.provider).toBe("gemini");

    // o que o navegador do cliente recebe não diz qual IA traduziu nem quanto custou
    const view = JSON.stringify(viewOf(done));
    expect(view).not.toMatch(/gemini|anthropic|costUsd|inputTokens":[1-9]/i);
    expect(view).not.toContain(MODELS.gemini);
  });

  it("a tradução Padrão nunca usa um serviço pago, mesmo se estiver na lista", async () => {
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
      for (const sg of doc.segments) if (sg.src.includes("keeper")) expect(sg.out).toMatch(/^PT /);
    }
  });

  it("cota de um serviço gratuito acaba: segue sozinho com o próximo, sem perder nada", async () => {
    const gemini = new Fake("gemini", 2);
    const github = new Fake("github");
    jobRunner.providerFactory = (id) => (id === "gemini" ? gemini : id === "github" ? github : new Fake(id));
    const id = await book(8);
    await placeOrder((await store.get(id))!, "padrao", {});
    await confirmOrder((await store.get(id))!, "http://localhost");
    const m = await until(id, ["done", "paused", "error"]);
    expect(m.status).toBe("done");
    expect(gemini.calls).toBe(2);
    expect(github.calls).toBeGreaterThan(0);
    expect(new Set(m.runs!.map((r) => r.provider))).toEqual(new Set(["gemini", "github"]));
    expect(m.progress.translatedSegments).toBe(m.totals.segments);
  });

  it("todos sem cota: espera e continua sozinho quando a cota volta", async () => {
    jobRunner.providerFactory = (id) => new Fake(id);
    await recordExhausted("gemini", MODELS.gemini, Date.now() + 1200);
    await recordExhausted("github", MODELS.github, Date.now() + 1200);
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

  it("com pagamentos de verdade ligados e sem meio de pagamento, não começa sem pagar", async () => {
    process.env.CHECKOUT_MODE = "live";
    const id = await book(1);
    await placeOrder((await store.get(id))!, "padrao", {});
    await expect(confirmOrder((await store.get(id))!, "http://localhost")).rejects.toThrow(/pagamentos ainda não estão disponíveis/);
    expect((await store.get(id))!.status).toBe("ready");
  });

  it("aviso de pagamento do pedido inicia a tradução uma única vez", async () => {
    process.env.CHECKOUT_MODE = "live";
    jobRunner.providerFactory = (id) => new Fake(id);
    const id = await book(1);
    const order = await placeOrder((await store.get(id))!, "padrao", {});
    const event = {
      kind: "purchase.completed" as const,
      accountId: "local",
      productId: `order:${id}:${order.id}`,
      externalId: "pay_1",
      amountBrl: order.priceBrl,
    };
    expect(await applyPaymentEvent(event)).toBe(true);
    expect(await applyPaymentEvent(event)).toBe(false);
    const m = await until(id, ["done", "paused", "error"]);
    expect(m.status).toBe("done");
    expect(m.order!.payment).toBe("provider");
    expect(m.order!.externalId).toBe("pay_1");
  });

  it("pagamento simulado: página de pagamento → aviso assinado → tradução começa (sem dinheiro)", async () => {
    process.env.CHECKOUT_MODE = "live";
    process.env.PAYMENT_PROVIDER = "simulado";
    jobRunner.providerFactory = (id) => new Fake(id);
    const id = await book(1);
    const order = await placeOrder((await store.get(id))!, "padrao", {});
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
    process.env.CHECKOUT_MODE = "live";
    const id = await book(1);
    const order = await placeOrder((await store.get(id))!, "padrao", {});
    const applied = await applyPaymentEvent({
      kind: "purchase.completed",
      accountId: "local",
      productId: `order:${id}:${order.id}`,
      externalId: "pay_baixo",
      amountBrl: order.priceBrl - 5,
    });
    expect(applied).toBe(false);
    expect((await store.get(id))!.order!.status).toBe("awaiting_payment");
    expect(paymentProvider()).toBeNull();
  });
});
