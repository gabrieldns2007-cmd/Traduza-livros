/**
 * Economia do produto: catálogo com margem, estimativa em créditos, carteira
 * (reserva → captura → liberação), e o motor de tradução nunca consumindo
 * além dos créditos — nem gastando mais do que cobrou.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeEpub } from "@/services/export/epub-writer";
import { importBook } from "@/services/parsing/import-book";
import { store } from "@/lib/storage";
import { config } from "@/lib/config";
import { jobRunner } from "@/services/processing/job-runner";
import {
  assertCatalogProtectsMargin,
  minCreditPriceBrl,
  PACKS,
  PLANS,
  pricePerCredit,
  worstCostPerCreditBrl,
  QUALITIES,
} from "@/lib/billing/catalog";
import { quoteWords } from "@/lib/billing/quote";
import { availableMilli, wallet } from "@/services/billing/wallet";
import { applyPaymentEvent } from "@/services/billing/payments";
import type { BatchInput, BatchOutput, TranslationProvider } from "@/services/translation/translation-provider";

class FakeProvider implements TranslationProvider {
  paid = true;
  limits = { batchChars: 1500, concurrency: 1 };
  calls = 0;
  sent: string[] = [];
  constructor(
    public id: string,
    public model: string,
    private tokensPerWord = 3,
  ) {}
  async analyzeBook() {
    return {
      profile: { genre: "", tone: "", narrativeVoice: "", styleNotes: "" },
      glossary: [],
      tocTranslations: [],
      usage: { inputTokens: 500, outputTokens: 200 },
    };
  }
  async analyzeChapter() {
    return { summary: "", newTerms: [] };
  }
  async translateBatch(input: BatchInput): Promise<BatchOutput> {
    this.calls++;
    for (const s of input.segments) this.sent.push(s.text);
    const words = input.segments.reduce((n, s) => n + s.text.split(/\s+/).length, 0);
    return {
      translations: new Map(input.segments.map((s) => [s.id, `PT ${s.text}`])),
      truncated: false,
      refused: false,
      usage: { inputTokens: words * 2, outputTokens: Math.round(words * this.tokensPerWord) },
    };
  }
}

async function waitFor(bookId: string, statuses: string[]) {
  for (let i = 0; i < 600; i++) {
    const m = (await store.get(bookId))!;
    if (statuses.includes(m.status) && !jobRunner.isRunning(bookId)) return m;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout");
}

async function newBook(chapters: number, paragraphs: number) {
  const epub = await writeEpub({
    title: "Livro Pago",
    language: "en",
    chapters: Array.from({ length: chapters }, (_, i) => ({
      title: `Chapter ${i + 1}`,
      body: Array.from(
        { length: paragraphs },
        (_, j) => `<p>Paragraph ${j + 1} of chapter ${i + 1}: the keeper climbed the long stair and lit the lamp for the ships at sea.</p>`,
      ).join(""),
    })),
  });
  return (await importBook(epub, { fileName: "pago.epub", targetLanguage: "pt-BR" })).id;
}

async function resetWallet() {
  await fs.rm(path.join(config.dataDir, "billing"), { recursive: true, force: true });
}

afterEach(() => {
  delete process.env.BILLING_MODE;
});

describe("catálogo e estimativa", () => {
  it("todo crédito vendido cobre o pior custo com margem", () => {
    const floor = assertCatalogProtectsMargin();
    expect(floor).toBeGreaterThan(Math.max(...QUALITIES.map(worstCostPerCreditBrl)));
    for (const item of [...PLANS.filter((p) => p.priceBrl > 0), ...PACKS]) expect(pricePerCredit(item)).toBeGreaterThanOrEqual(minCreditPriceBrl());
  });

  it("estima créditos pelas palavras e pela qualidade; a chave da própria pessoa não consome", () => {
    const opus = quoteWords({ id: "anthropic", model: "claude-opus-5-5", billing: "hosted" }, 44152);
    expect(opus.quality.id).toBe("premium");
    expect(opus.credits).toBe(Math.ceil((44152 * 12) / 1000));
    expect(opus.costUsd.worst).toBeGreaterThan(opus.costUsd.expected);
    const lite = quoteWords({ id: "gemini", model: "gemini-3.5-flash-lite", billing: "hosted" }, 44152);
    expect(lite.credits).toBe(45);
    const byok = quoteWords({ id: "gemini", model: "gemini-3.8-flash", billing: "byok" }, 44152);
    expect(byok.credits).toBe(0);
  });
});

describe("carteira", () => {
  beforeAll(resetWallet);

  it("boas-vindas + mês, reserva, captura, liberação e vencimento", async () => {
    await resetWallet();
    let w = await wallet.read();
    expect(availableMilli(w)).toBe(20_000); // 15 de boas-vindas + 5 do mês (plano Grátis)
    await expect(wallet.reserve("r1", "b", 25_000)).rejects.toThrow(/precisa de 25 créditos/);
    expect(await wallet.reserve("r1", "b", 25_000, { partial: true })).toBe(20_000);
    expect(await wallet.capture("r1", 5_000)).toBe(5_000);
    expect(await wallet.capture("r1", 50_000)).toBe(15_000); // nunca além da reserva
    await wallet.release("r1");
    w = await wallet.read();
    expect(availableMilli(w)).toBe(0);
    expect(w.ledger.filter((e) => e.kind === "charge").map((e) => e.milli)).toEqual([-20_000]);
  });

  it("pagamento é creditado uma única vez (idempotente)", async () => {
    await resetWallet();
    const event = { kind: "purchase.completed" as const, accountId: "local", productId: "pack-50", externalId: "pay_123", amountBrl: 14.9 };
    expect(await applyPaymentEvent(event)).toBe(true);
    expect(await applyPaymentEvent(event)).toBe(false);
    expect(availableMilli(await wallet.read())).toBe(70_000);
  });

  it("plano Grátis não libera a qualidade Premium", async () => {
    await resetWallet();
    process.env.BILLING_MODE = "enforce";
    const bookId = await newBook(2, 5);
    jobRunner.providerFactory = () => new FakeProvider("anthropic", "claude-opus-5-5");
    await jobRunner.start(bookId);
    const m = await waitFor(bookId, ["paused", "error", "done"]);
    expect(m.status).toBe("paused");
    expect(m.error).toMatch(/Premium não faz parte do plano Grátis/);
  });

  it("limita as prévias grátis por dia", async () => {
    await resetWallet();
    for (let i = 0; i < 2; i++) await wallet.notePreview();
    await expect(wallet.notePreview()).rejects.toThrow(/prévias grátis de hoje/);
  });
});

describe("motor de tradução com créditos (BILLING_MODE=enforce)", () => {
  it("sem créditos não começa; parcial traduz só o que o saldo cobre; depois de comprar, continua sem cobrar de novo", async () => {
    await resetWallet();
    process.env.BILLING_MODE = "enforce";
    await wallet.setPlan("pro"); // Premium só no Pro
    // o plano Pro dá 300 créditos: consome quase tudo antes para testar a falta de saldo
    await wallet.reserve("ocupa", "x", (await wallet.read()).lots.reduce((n, l) => n + l.milli, 0) - 20_000);
    await wallet.capture("ocupa", 1_000_000);
    await wallet.release("ocupa");
    const bookId = await newBook(10, 10); // ~2.000 palavras × 12 créditos/1k (Premium) ≈ 24 créditos; saldo: 20
    const meta = (await store.get(bookId))!;
    const provider = new FakeProvider("anthropic", "claude-opus-5-5");
    jobRunner.providerFactory = () => provider;

    // 1) sem saldo suficiente e sem “parcial”: não começa
    await jobRunner.start(bookId);
    let m = await waitFor(bookId, ["paused", "error"]);
    expect(m.stopCode).toBe("wallet");
    expect(provider.calls).toBe(0);

    // 2) parcial: traduz até a reserva acabar e pausa
    await jobRunner.start(bookId, { partial: true });
    m = await waitFor(bookId, ["paused", "error", "done"]);
    expect(m.status).toBe("paused");
    expect(m.stopCode).toBe("wallet");
    const run = m.runs!.at(-1)!;
    expect(run.billing).toBe("hosted");
    expect(run.credits.chargedMilli).toBeLessThanOrEqual(run.credits.reservedMilli);
    expect(run.credits.chargedMilli).toBe(run.words * 12);
    expect(m.progress.translatedWords).toBeLessThanOrEqual(Math.floor(20_000 / 12));
    expect(m.progress.translatedWords).toBeGreaterThan(0);
    // o saldo foi usado (sobra no máximo o equivalente a um lote, que não é cortado ao meio)
    expect(availableMilli(await wallet.read())).toBeLessThan(12 * 300);

    // 3) “compra” créditos e continua: nada já traduzido é reenviado nem cobrado de novo
    await applyPaymentEvent({ kind: "purchase.completed", accountId: "local", productId: "pack-50", externalId: "pay_x", amountBrl: 14.9 });
    const sentBefore = new Set(provider.sent);
    provider.sent = [];
    await jobRunner.start(bookId);
    m = await waitFor(bookId, ["done", "paused", "error"]);
    expect(m.status).toBe("done");
    for (const t of provider.sent) expect(sentBefore.has(t)).toBe(false);
    const charged = m.runs!.filter((r) => r.kind === "translation").reduce((n, r) => n + r.credits.chargedMilli, 0);
    expect(charged).toBe(meta.totals.words * 12);
    // cada execução tem custo, tokens e tempo registrados
    for (const r of m.runs!) {
      expect(r.endedAt).toBeTruthy();
      if (r.words > 0) {
        expect(r.costUsd).toBeGreaterThan(0);
        expect(r.inputTokens).toBeGreaterThan(0);
      }
    }
  });

  it("pausa quando o custo real passa do que foi cobrado (proteção de margem)", async () => {
    await resetWallet();
    process.env.BILLING_MODE = "enforce";
    await applyPaymentEvent({ kind: "purchase.completed", accountId: "local", productId: "pack-300", externalId: "pay_m", amountBrl: 64.9 });
    await wallet.setPlan("pro");
    const bookId = await newBook(4, 10);
    // um modelo “descontrolado”: 400 tokens de saída por palavra
    jobRunner.providerFactory = () => new FakeProvider("anthropic", "claude-opus-5-5", 400);
    await jobRunner.start(bookId);
    const m = await waitFor(bookId, ["paused", "error", "done"]);
    expect(m.status).toBe("paused");
    expect(m.stopCode).toBe("margin");
    expect(m.error).toMatch(/custando mais que o previsto/);
  });

  it("com a chave da própria pessoa (byok) nada é reservado nem cobrado", async () => {
    await resetWallet();
    process.env.BILLING_MODE = "enforce";
    const bookId = await newBook(4, 10);
    jobRunner.providerFactory = () => new FakeProvider("gemini", "gemini-3.8-flash");
    await jobRunner.start(bookId);
    const m = await waitFor(bookId, ["done", "paused", "error"]);
    expect(m.status).toBe("done");
    const run = m.runs!.at(-1)!;
    expect(run.billing).toBe("byok");
    expect(run.credits.reservedMilli).toBe(0);
    expect(run.credits.chargedMilli).toBe(0);
    expect(run.costUsd).toBeGreaterThan(0); // o custo de referência fica registrado mesmo assim
  });

  it("modo prévia (padrão): registra o valor em créditos, mas não desconta nem bloqueia", async () => {
    await resetWallet();
    const bookId = await newBook(4, 10);
    jobRunner.providerFactory = () => new FakeProvider("anthropic", "claude-opus-5-5");
    await jobRunner.start(bookId);
    const m = await waitFor(bookId, ["done", "paused", "error"]);
    expect(m.status).toBe("done");
    const run = m.runs!.at(-1)!;
    expect(run.credits.mode).toBe("preview");
    expect(run.credits.valueMilli).toBe(m.totals.words * 12);
    expect(run.credits.chargedMilli).toBe(0);
    expect((await wallet.read()).ledger.some((e) => e.kind === "charge")).toBe(false);
  });
});
