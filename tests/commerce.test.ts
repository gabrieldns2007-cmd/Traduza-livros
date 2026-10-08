/**
 * Experiência de compra: o cliente vê o preço da tradução (em reais), confirma
 * e a tradução começa sozinha, com o serviço escolhido por dentro. Se a cota de
 * um serviço gratuito acabar, segue com o próximo; se todos acabarem, espera e
 * continua sozinha quando a cota voltar.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeEpub } from "@/services/export/epub-writer";
import { importBook } from "@/services/parsing/import-book";
import { config } from "@/lib/config";
import { DEFAULT_SETTINGS, store, writeSettings } from "@/lib/storage";
import { jobRunner } from "@/services/processing/job-runner";
import { confirmOrder, offerFor, placeOrder } from "@/services/commerce/orders";
import { applyPaymentEvent } from "@/services/billing/payments";
import { recordExhausted } from "@/services/quota/usage";
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
});
