/**
 * Cenário real: a conta fica sem créditos no meio do livro.
 * Garante que nada é apagado, que a tradução fica pausada com a mensagem
 * certa e que, ao continuar, nenhum trecho já traduzido é enviado de novo.
 */
import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import { writeEpub } from "@/services/export/epub-writer";
import { importBook } from "@/services/parsing/import-book";
import { store } from "@/lib/storage";
import { jobRunner, recountProgress } from "@/services/processing/job-runner";
import { ProviderError } from "@/services/translation/llm/types";
import type { BatchInput, BatchOutput, TranslationProvider } from "@/services/translation/translation-provider";

const CHAPTERS = 12;

class CountingProvider implements TranslationProvider {
  id = "fake";
  model = "fake";
  paid = false;
  limits = { batchChars: 1000, concurrency: 1 };
  sent: number[][] = []; // [docIndexHint, segId] não importa: guardamos textos enviados
  texts: string[] = [];
  analyzed: string[] = [];
  bookAnalyses = 0;
  calls = 0;
  constructor(private creditsLeft = Infinity) {}
  async analyzeBook() {
    this.bookAnalyses++;
    return {
      profile: { genre: "ficção", tone: "sóbrio", narrativeVoice: "3ª pessoa", styleNotes: "" },
      glossary: [{ term: "Marta", translation: "Marta", type: "character" as const }],
      tocTranslations: [],
    };
  }
  async analyzeChapter(input: { chapterTitle: string }) {
    if (this.creditsLeft <= 0) throw this.noCredits();
    this.analyzed.push(input.chapterTitle);
    return {
      summary: `Resumo de ${input.chapterTitle}`,
      newTerms: [{ term: `Lugar ${input.chapterTitle}`, translation: "X", type: "place" as const }],
    };
  }
  async translateBatch(input: BatchInput): Promise<BatchOutput> {
    if (this.creditsLeft <= 0) throw this.noCredits();
    this.creditsLeft--;
    this.calls++;
    for (const s of input.segments) this.texts.push(s.text);
    return {
      translations: new Map(input.segments.map((s) => [s.id, `PT ${s.text}`])),
      // nomes novos vêm junto da tradução (sem chamada extra)
      newTerms: [{ term: `Lugar ${this.calls}-${input.chapterTitle}`, translation: "X", type: "place" as const }],
      truncated: false,
      refused: false,
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
  noCredits() {
    return new ProviderError("Sua conta da Anthropic ficou sem créditos.", { fatal: true, code: "credits" });
  }
}

async function waitFor(bookId: string, statuses: string[]) {
  for (let i = 0; i < 400; i++) {
    const m = (await store.get(bookId))!;
    if (statuses.includes(m.status) && !jobRunner.isRunning(bookId)) return m;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timeout");
}

describe("retomada após falta de créditos", () => {
  let bookId = "";
  beforeAll(async () => {
    const epub = await writeEpub({
      title: "Livro de Teste",
      language: "en",
      chapters: Array.from({ length: CHAPTERS }, (_, i) => ({
        title: `Chapter ${i + 1}`,
        body:
          `<h1>Chapter ${i + 1}</h1>` +
          Array.from({ length: 6 }, (_, j) => `<p>Marta walked through paragraph ${j + 1} of chapter ${i + 1}, thinking about the sea.</p>`).join(""),
      })),
    });
    bookId = (await importBook(epub, { fileName: "teste.epub", targetLanguage: "pt-BR" })).id;
  });

  it("pausa com a mensagem de créditos sem apagar nada e continua do ponto certo", async () => {
    // 1ª execução: créditos acabam depois de 5 lotes
    const first = new CountingProvider(2);
    jobRunner.providerFactory = () => first;
    await jobRunner.start(bookId);
    const stopped = await waitFor(bookId, ["paused", "error"]);
    expect(stopped.status).toBe("paused");
    expect(stopped.stopCode).toBe("credits");
    expect(stopped.error).toMatch(/créditos/);

    const doneBefore = stopped.chapters.filter((c) => c.status === "done").map((c) => c.id);
    expect(doneBefore.length).toBeGreaterThan(0);
    expect(doneBefore.length).toBeLessThan(CHAPTERS);
    const wordsBefore = stopped.progress.translatedWords;
    expect(wordsBefore).toBeGreaterThan(0);

    // traduções gravadas em disco batem com o progresso
    const resume = await recountProgress(bookId);
    expect(resume!.doneChapters).toBe(doneBefore.length);

    // `npm run status` lê o mesmo estado, sem alterar nada
    const status = execFileSync(process.execPath, ["scripts/book-status.mjs"], { env: process.env, encoding: "utf8" });
    expect(status).toContain(`capítulos concluídos:  ${doneBefore.length} de ${CHAPTERS}`);
    expect(status).toContain(`continua do capítulo:  ${resume!.nextChapterIndex! + 1}`);
    const afterRecount = (await store.get(bookId))!;
    expect(afterRecount.progress.translatedWords).toBe(wordsBefore);

    const savedOut = new Map<string, string>();
    for (const d of afterRecount.docs) {
      const doc = await store.readDoc(bookId, d.id);
      doc.segments.forEach((s) => s.out !== undefined && savedOut.set(`${d.id}:${s.i}`, s.out));
    }
    const glossaryBefore = (await store.readGlossary(bookId)).map((g) => g.term);
    expect(glossaryBefore.length).toBeGreaterThan(1);
    const summariesBefore = afterRecount.chapters.filter((c) => c.summary).map((c) => c.id);

    // 2ª execução: créditos de volta
    const second = new CountingProvider();
    jobRunner.providerFactory = () => second;
    await jobRunner.start(bookId);
    const finished = await waitFor(bookId, ["done", "error", "paused"]);
    expect(finished.status).toBe("done");
    expect(finished.chapters.every((c) => c.status === "done")).toBe(true);

    // nenhum trecho já traduzido foi enviado de novo
    const alreadyTranslatedSources = new Set<string>();
    for (const d of finished.docs) {
      const doc = await store.readDoc(bookId, d.id);
      for (const s of doc.segments) if (savedOut.has(`${d.id}:${s.i}`)) alreadyTranslatedSources.add(s.src);
    }
    for (const t of second.texts) expect(alreadyTranslatedSources.has(t)).toBe(false);
    // o livro não foi reanalisado e capítulos já resumidos não foram relidos
    expect(second.bookAnalyses).toBe(0);
    const resummarized = finished.chapters.filter((c) => summariesBefore.includes(c.id) && second.analyzed.includes(c.title));
    expect(resummarized).toHaveLength(0);
    // economia: nenhuma chamada extra por capítulo (análise desligada por padrão)
    expect(first.analyzed).toHaveLength(0);
    expect(second.analyzed).toHaveLength(0);
    // vários capítulos pequenos por pedido: bem menos pedidos que capítulos
    expect(first.calls + second.calls).toBeLessThan(CHAPTERS);

    // traduções antigas preservadas exatamente; glossário só cresceu
    for (const d of finished.docs) {
      const doc = await store.readDoc(bookId, d.id);
      for (const s of doc.segments) {
        const key = `${d.id}:${s.i}`;
        if (savedOut.has(key)) expect(s.out).toBe(savedOut.get(key));
      }
    }
    const glossaryAfter = (await store.readGlossary(bookId)).map((g) => g.term);
    for (const t of glossaryBefore) expect(glossaryAfter).toContain(t);
    expect(finished.progress.translatedWords).toBe(finished.totals.words);
  });
});
