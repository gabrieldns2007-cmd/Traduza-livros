/**
 * Prévia grátis: traduz só um trecho do primeiro capítulo de verdade, num
 * único pedido; o trecho fica salvo e não é reenviado quando o livro todo é traduzido.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { writeEpub } from "@/services/export/epub-writer";
import { importBook } from "@/services/parsing/import-book";
import { store } from "@/lib/storage";
import { jobRunner } from "@/services/processing/job-runner";
import type { BatchInput, BatchOutput, TranslationProvider } from "@/services/translation/translation-provider";

class FakeProvider implements TranslationProvider {
  id = "demo";
  model = "fake";
  paid = false;
  limits = { batchChars: 4000, concurrency: 1 };
  calls = 0;
  texts: string[] = [];
  async analyzeBook() {
    return { profile: { genre: "", tone: "", narrativeVoice: "", styleNotes: "" }, glossary: [], tocTranslations: [] };
  }
  async analyzeChapter() {
    return { summary: "", newTerms: [] };
  }
  async translateBatch(input: BatchInput): Promise<BatchOutput> {
    this.calls++;
    for (const s of input.segments) this.texts.push(s.text);
    return {
      translations: new Map(input.segments.map((s) => [s.id, `PT ${s.text}`])),
      truncated: false,
      refused: false,
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

async function until(fn: () => Promise<boolean>) {
  for (let i = 0; i < 400; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timeout");
}

describe("prévia grátis", () => {
  let bookId = "";
  beforeAll(async () => {
    const epub = await writeEpub({
      title: "Prévia",
      language: "en",
      chapters: [
        // página de direitos autorais (curta): a prévia deve pulá-la
        { title: "Copyright", body: "<p>Copyright 2026. All rights reserved.</p>" },
        ...Array.from({ length: 3 }, (_, i) => ({
          title: `Chapter ${i + 1}`,
          body:
            `<h1>Chapter ${i + 1}</h1>` +
            Array.from(
              { length: 30 },
              (_, j) =>
                `<p>Paragraph ${j + 1} of chapter ${i + 1}: the lighthouse keeper counted the waves again, slowly, as if they owed him something.</p>`,
            ).join(""),
        })),
      ],
    });
    bookId = (await importBook(epub, { fileName: "previa.epub", targetLanguage: "pt-BR" })).id;
  });

  it("traduz um trecho do primeiro capítulo de verdade e não o reenvia depois", async () => {
    const provider = new FakeProvider();
    jobRunner.providerFactory = () => provider;
    await jobRunner.preview(bookId, "demo");
    await until(async () => (await store.get(bookId))!.preview?.status === "done");

    const meta = (await store.get(bookId))!;
    expect(meta.status).toBe("ready");
    expect(provider.calls).toBe(1);
    const p = meta.preview!;
    const chapter = meta.chapters.find((c) => c.id === p.chapterId)!;
    expect(chapter.title).toMatch(/Chapter 1/);
    expect(p.end - p.start).toBeGreaterThan(1);
    expect(p.end).toBeLessThan(chapter.end);
    const previewTexts = [...provider.texts];
    expect(previewTexts.join("").length).toBeLessThanOrEqual(2600);
    const doc = await store.readDoc(bookId, p.docId);
    expect(doc.segments.slice(p.start, p.end).every((s) => s.out?.startsWith("PT "))).toBe(true);
    expect(meta.progress.translatedSegments).toBe(p.end - p.start);

    // livro todo: nada da prévia é enviado de novo
    provider.texts = [];
    await jobRunner.start(bookId);
    await until(async () => (await store.get(bookId))!.status === "done" && !jobRunner.isRunning(bookId));
    for (const t of previewTexts) expect(provider.texts).not.toContain(t);
    const done = (await store.get(bookId))!;
    expect(done.progress.translatedSegments).toBe(done.totals.segments);
  });
});
