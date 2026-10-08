import { beforeAll, describe, expect, it } from "vitest";
import { fixtureEpub } from "./helpers";

import { importBook } from "@/services/parsing/import-book";
import { store } from "@/lib/storage";
import { tokenize, toPlainText } from "@/lib/markup";
import { processChapters } from "@/services/processing/chapter-processor";
import { jobRunner } from "@/services/processing/job-runner";
import { buildTranslatedEpub } from "@/services/export/epub-export";
import { buildTranslatedPdf } from "@/services/export/pdf-export";
import type { BatchInput, BatchOutput, TranslationProvider } from "@/services/translation/translation-provider";

/** “Tradutor” que põe o texto em maiúsculas e, na primeira tentativa, erra de propósito. */
class FlakyProvider implements TranslationProvider {
  id = "fake";
  model = "fake";
  paid = false;
  limits = { batchChars: 5000, concurrency: 1 };
  calls = 0;
  strictCalls = 0;
  seenGlossary = new Set<string>();
  async analyzeBook() {
    return {
      profile: { genre: "ficção", tone: "sóbrio", narrativeVoice: "3ª pessoa", styleNotes: "" },
      glossary: [{ term: "Captain Reyes", translation: "Capitão Reyes", type: "character" as const }],
      tocTranslations: [],
    };
  }
  async analyzeChapter() {
    return { summary: "Resumo.", newTerms: [{ term: "Porto Velho", translation: "Porto Velho", type: "place" as const }] };
  }
  async translateBatch(input: BatchInput): Promise<BatchOutput> {
    this.calls++;
    if (input.strict) this.strictCalls++;
    for (const g of input.glossary) this.seenGlossary.add(g.term);
    const translations = new Map<number, string>();
    input.segments.forEach((s, idx) => {
      if (!input.strict && idx === 0) return; // omite um segmento
      let t = tokenize(s.text)
        .map((tok) =>
          tok.type === "text"
            ? tok.text.toUpperCase()
            : tok.type === "open"
              ? `<${tok.name}_${tok.k}>`
              : tok.type === "close"
                ? `</${tok.name}_${tok.k}>`
                : `<${tok.name}_${tok.k}/>`,
        )
        .join("");
      if (!input.strict && idx === 1) t = toPlainText(s.text).toUpperCase(); // perde as tags
      translations.set(s.id, t);
    });
    return { translations, truncated: false, refused: false, usage: { inputTokens: 10, outputTokens: 10 } };
  }
}

describe("pipeline", () => {
  let bookId = "";

  beforeAll(async () => {
    const meta = await importBook(await fixtureEpub(), { fileName: "lighthouse.epub", targetLanguage: "pt-BR" });
    bookId = meta.id;
  });

  it("importa capítulos, segmentos e idioma", async () => {
    const meta = (await store.get(bookId))!;
    expect(meta.chapters).toHaveLength(2);
    expect(meta.chapters[0].title).toBe("Chapter One");
    expect(meta.detectedLanguage).toBe("en");
    const doc = await store.readDoc(bookId, meta.chapters[0].docId);
    const texts = doc.segments.map((s) => toPlainText(s.src));
    expect(texts).toContain("The sea remembers everything.");
    expect(texts).toContain("Mixed content text here");
    expect(doc.segments.find((s) => s.role === "quote")).toBeTruthy();
    expect(doc.blocks.some((b) => b.t === "orn")).toBe(true);
  });

  it("traduz um capítulo com novas tentativas e glossário", async () => {
    const provider = new FlakyProvider();
    // “leitura atenta” ligada neste teste: cobre também a análise por capítulo
    const meta = await store.update(bookId, (m) => {
      m.options.deepContext = true;
    });
    await store.updateGlossary(bookId, (e) =>
      e.push({ id: "g1", term: "Captain Reyes", translation: "Capitão Reyes", type: "character", origin: "auto" }),
    );
    let words = 0;
    await processChapters(meta, [meta.chapters[0]], provider, {
      signal: new AbortController().signal,
      onChapterSaved: async () => {},
      analysisLock: <T>(fn: () => Promise<T>) => fn(),
      onUsage: async () => {},
      onProgress: async (_c: string, d: { words: number }) => {
        words += d.words;
      },
    });
    const doc = await store.readDoc(bookId, meta.chapters[0].docId);
    const segs = doc.segments.slice(meta.chapters[0].start, meta.chapters[0].end);
    expect(segs.every((s) => s.out !== undefined)).toBe(true);
    expect(provider.strictCalls).toBeGreaterThan(0);
    expect(provider.seenGlossary.has("Captain Reyes")).toBe(true);
    // as tags sobreviveram (a 2ª tentativa devolveu a marcação completa)
    for (const s of segs) expect(s.out!.match(/<[a-z]+_\d+/g)?.length ?? 0).toBe(s.src.match(/<[a-z]+_\d+/g)?.length ?? 0);
    expect(words).toBe(segs.reduce((a, s) => a + s.words, 0));
    const glossary = await store.readGlossary(bookId);
    expect(glossary.map((g) => g.term)).toContain("Porto Velho");
  });

  it("roda o livro inteiro na fila (provedor de demonstração) e exporta", async () => {
    await jobRunner.start(bookId);
    for (let i = 0; i < 200; i++) {
      const m = (await store.get(bookId))!;
      if (m.status === "done" || m.status === "error") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const meta = (await store.get(bookId))!;
    expect(meta.status).toBe("done");
    expect(meta.chapters.every((c) => c.status === "done")).toBe(true);

    const epub = await buildTranslatedEpub(meta);
    const again = await importBook(epub, { fileName: "again.epub" });
    expect(again.totals.segments).toBe(meta.totals.segments);
    expect(again.chapters.map((c) => c.title)).toEqual(meta.chapters.map((c) => c.translatedTitle || c.title));

    const pdf = await buildTranslatedPdf(meta);
    expect(Buffer.from(pdf.subarray(0, 5)).toString()).toBe("%PDF-");
  });
});
