/**
 * Provedor de demonstração: não usa IA. Devolve o texto original, com uma
 * pequena pausa, para testar o fluxo completo (progresso, revisão,
 * exportação) sem chave de API. A interface avisa que é uma demonstração.
 */
import { toPlainText } from "@/lib/markup";
import type { BatchInput, BatchOutput, BookAnalysisInput, ChapterAnalysisInput, TranslationProvider } from "./translation-provider";
import { sleep } from "@/utils/async";

export class DemoTranslationProvider implements TranslationProvider {
  readonly id = "demo";
  readonly paid = false;
  readonly limits = { batchChars: 8000, concurrency: 2 };
  readonly model = "demo";

  constructor(private readonly delayMs = Number(process.env.DEMO_DELAY_MS ?? 350)) {}

  async analyzeBook(input: BookAnalysisInput, signal?: AbortSignal) {
    await sleep(this.delayMs, signal);
    return {
      translatedTitle: input.book.title,
      profile: { genre: "", tone: "", narrativeVoice: "", styleNotes: "" },
      glossary: frequentNames(input.sample).map((term) => ({ term, translation: term, type: "other" as const })),
      tocTranslations: input.tocLabels,
    };
  }

  async analyzeChapter(input: ChapterAnalysisInput, signal?: AbortSignal) {
    await sleep(this.delayMs / 2, signal);
    const known = new Set(input.knownTerms);
    return {
      summary: "",
      newTerms: frequentNames(input.text)
        .filter((t) => !known.has(t))
        .slice(0, 10)
        .map((term) => ({ term, translation: term, type: "other" as const })),
    };
  }

  async translateBatch(input: BatchInput): Promise<BatchOutput> {
    const chars = input.segments.reduce((s, x) => s + toPlainText(x.text).length, 0);
    await sleep(this.delayMs + Math.min(1500, chars / 20), input.signal);
    return {
      translations: new Map(input.segments.map((s) => [s.id, s.text])),
      truncated: false,
      refused: false,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

/** Nomes próprios frequentes (palavras capitalizadas fora do início de frase). */
function frequentNames(text: string): string[] {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(/(?<=[a-z,;] )([A-Z][a-z]{2,}(?: [A-Z][a-z]{2,})?)/g)) {
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([t]) => t);
}
