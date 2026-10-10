/**
 * Economia de tokens sem perder qualidade: nada é pedido duas vezes à toa.
 *  - resposta cortada: os trechos completos são aproveitados, só o resto volta;
 *  - erro temporário no meio do lote: só o que falta é reenviado;
 *  - trechos sem palavras ficam como estão e repetidos vão uma vez só.
 */
import { describe, expect, it, vi } from "vitest";
import { fixtureEpub } from "./helpers";

import { importBook } from "@/services/parsing/import-book";
import { store } from "@/lib/storage";
import { toPlainText } from "@/lib/markup";
import { hasWords, processChapters } from "@/services/processing/chapter-processor";
import { geminiThinkingLevel } from "@/services/translation/llm/gemini";
import { ProviderError } from "@/services/translation/llm/types";
import type { BatchInput, BatchOutput, TranslationProvider } from "@/services/translation/translation-provider";

type Behavior = (input: BatchInput, call: number) => Partial<BatchOutput> | "throw" | void;

class RecordingProvider implements TranslationProvider {
  id = "fake";
  model = "fake";
  paid = false;
  limits = { batchChars: 50_000, concurrency: 1 };
  calls: BatchInput[] = [];
  constructor(private behavior: Behavior = () => {}) {}
  async analyzeBook() {
    return { profile: { genre: "", tone: "", narrativeVoice: "", styleNotes: "" }, glossary: [], tocTranslations: [] };
  }
  async analyzeChapter() {
    return { summary: "", newTerms: [] };
  }
  async translateBatch(input: BatchInput): Promise<BatchOutput> {
    this.calls.push(input);
    const translations = new Map<number, string>();
    for (const s of input.segments) translations.set(s.id, `PT ${s.text}`);
    const b = this.behavior(input, this.calls.length);
    if (b === "throw") throw new ProviderError("sobrecarga", { fatal: false, code: "server" });
    return { translations, truncated: false, refused: false, usage: { inputTokens: 10, outputTokens: 10 }, ...b };
  }
  get sentSegments() {
    return this.calls.reduce((n, c) => n + c.segments.length, 0);
  }
}

async function freshBook() {
  const meta = await importBook(await fixtureEpub(), { fileName: "lighthouse.epub", targetLanguage: "pt-BR" });
  return meta.id;
}

function hooks(stats: { retries: number; local: number; requests: number }) {
  return {
    signal: new AbortController().signal,
    analysisLock: <T>(fn: () => Promise<T>) => fn(),
    onUsage: async (_u: unknown, info?: { retry?: boolean }) => {
      stats.requests++;
      if (info?.retry) stats.retries++;
    },
    onLocal: async (n: number) => {
      stats.local += n;
    },
    onProgress: async () => {},
    onChapterSaved: async () => {},
  };
}

async function allSegments(bookId: string) {
  const meta = (await store.get(bookId))!;
  const doc = await store.readDoc(bookId, meta.chapters[0].docId);
  return { meta, doc, range: doc.segments.slice(meta.chapters[0].start, meta.chapters[0].end) };
}

describe("economia de tokens", () => {
  it("resposta cortada: aproveita os trechos completos e pede só o resto", async () => {
    const bookId = await freshBook();
    const { meta, range } = await allSegments(bookId);
    const total = range.length;
    expect(total).toBeGreaterThan(3);
    // 1º pedido “corta” depois de 2 trechos
    const provider = new RecordingProvider((input, call) => {
      if (call !== 1) return;
      const translations = new Map<number, string>();
      for (const s of input.segments.slice(0, 2)) translations.set(s.id, `PT ${s.text}`);
      return { translations, truncated: true };
    });
    const stats = { retries: 0, local: 0, requests: 0 };
    await processChapters(meta, [meta.chapters[0]], provider, hooks(stats));

    const after = await allSegments(bookId);
    expect(after.range.every((s) => s.out !== undefined)).toBe(true);
    const sent = total - stats.local;
    // antes: o lote inteiro voltava em metades (sent + sent); agora só os que faltaram
    expect(provider.sentSegments).toBe(sent + (sent - 2));
    expect(stats.retries).toBe(provider.calls.length - 1);
  });

  it("erro temporário no meio do lote: o que já voltou não é pedido de novo", async () => {
    const bookId = await freshBook();
    const { meta, range } = await allSegments(bookId);
    // 1º pedido: corta na metade; 2º (o resto): falha uma vez; 3º: dá certo
    const provider = new RecordingProvider((input, call) => {
      if (call === 1) {
        const translations = new Map<number, string>();
        for (const s of input.segments.slice(0, Math.floor(input.segments.length / 2))) translations.set(s.id, `PT ${s.text}`);
        return { translations, truncated: true };
      }
      if (call === 2) return "throw";
    });
    const stats = { retries: 0, local: 0, requests: 0 };
    const h = hooks(stats);
    // a espera entre tentativas (15 s) é adiantada no relógio falso
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let done = false;
      const run = processChapters(meta, [meta.chapters[0]], provider, h).finally(() => (done = true));
      while (!done) await vi.advanceTimersByTimeAsync(1000);
      await run;
    } finally {
      vi.useRealTimers();
    }
    const after = await allSegments(bookId);
    expect(after.range.every((s) => s.out !== undefined)).toBe(true);
    const firstHalf = new Set(provider.calls[0].segments.slice(0, Math.floor(provider.calls[0].segments.length / 2)).map((s) => s.text));
    // nenhum trecho já traduzido voltou no pedido depois do erro
    for (const s of provider.calls[2].segments) expect(firstHalf.has(s.text)).toBe(false);
    expect(range.length).toBeGreaterThan(0);
  });

  it("trechos sem palavras ficam como estão; repetidos vão ao modelo uma vez", async () => {
    const bookId = await freshBook();
    const { meta } = await allSegments(bookId);
    const ch = meta.chapters[0];
    let repeated = "";
    await store.updateDoc(bookId, ch.docId, (content) => {
      const segs = content.segments.slice(ch.start, ch.end).filter((s) => !/<|&/.test(s.src) && hasWords(s.src));
      segs[0].src = "* * *";
      repeated = segs[1].src;
      segs[2].src = repeated;
    });
    const provider = new RecordingProvider();
    const stats = { retries: 0, local: 0, requests: 0 };
    await processChapters((await store.get(bookId))!, [ch], provider, hooks(stats));

    const sentTexts = provider.calls.flatMap((c) => c.segments.map((s) => s.text));
    expect(sentTexts).not.toContain("* * *");
    expect(sentTexts.filter((t) => t === repeated)).toHaveLength(1);
    expect(stats.local).toBe(2);
    const { range } = await allSegments(bookId);
    expect(range.find((s) => s.src === "* * *")!.out).toBe("* * *");
    const copies = range.filter((s) => s.src === repeated);
    expect(copies).toHaveLength(2);
    expect(copies.every((s) => toPlainText(s.out!) === `PT ${toPlainText(repeated)}`)).toBe(true);
  });

  it("sem palavras: números, pontuação e marcas; com palavras: qualquer letra", () => {
    expect(hasWords("* * *")).toBe(false);
    expect(hasWords("12.")).toBe(false);
    expect(hasWords("<a_3>[1]</a_3>")).toBe(false);
    expect(hasWords("I")).toBe(true);
    expect(hasWords("Ça va")).toBe(true);
  });

  it("raciocínio do Gemini: só com a variável, só na tradução, só valores aceitos", () => {
    expect(geminiThinkingLevel("translation", undefined)).toBeUndefined();
    expect(geminiThinkingLevel("translation", "LOW")).toBe("low");
    expect(geminiThinkingLevel("analysis", "low")).toBeUndefined();
    expect(geminiThinkingLevel("translation", "off")).toBeUndefined();
  });
});
