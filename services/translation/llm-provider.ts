/** TranslationProvider baseado em um LLM qualquer (Claude, GPT, modelos locais…). */
import type { GlossaryType } from "@/types/book";
import type { LLMClient } from "./llm/types";
import type {
  BatchInput,
  BatchOutput,
  BookAnalysis,
  BookAnalysisInput,
  ChapterAnalysis,
  ChapterAnalysisInput,
  GlossaryCandidate,
  ProviderLimits,
  TranslationProvider,
} from "./translation-provider";
import {
  BOOK_ANALYSIS_SCHEMA,
  CHAPTER_ANALYSIS_SCHEMA,
  analysisSystemPrompt,
  bookAnalysisPrompt,
  chapterAnalysisPrompt,
  parseJsonLoose,
  parseNewTerms,
  parseSegments,
  translationSystemPrompt,
  translationUserPrompt,
} from "./prompts";

const TYPES: GlossaryType[] = ["character", "place", "organization", "term", "other"];

function cleanTerms(raw: unknown): GlossaryCandidate[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .map((t) => ({
      term: String(t.term ?? "").trim(),
      translation: String(t.translation ?? "").trim(),
      type: (TYPES.includes(t.type as GlossaryType) ? t.type : "other") as GlossaryType,
      note: String(t.note ?? "").trim() || undefined,
    }))
    .filter((t) => t.term && t.translation && t.term.length <= 80);
}

export class LLMTranslationProvider implements TranslationProvider {
  readonly paid: boolean;
  readonly limits: ProviderLimits;

  constructor(
    private readonly llm: LLMClient,
    opts: { paid: boolean; limits: ProviderLimits },
  ) {
    this.paid = opts.paid;
    this.limits = opts.limits;
  }

  get id() {
    return this.llm.providerId;
  }

  get model() {
    return this.llm.model;
  }

  async analyzeBook(input: BookAnalysisInput, signal?: AbortSignal) {
    const res = await this.llm.complete({
      purpose: "analysis",
      system: analysisSystemPrompt(),
      user: bookAnalysisPrompt(input),
      maxTokens: 16000,
      json: { name: "book_analysis", schema: BOOK_ANALYSIS_SCHEMA },
      effort: "medium",
      signal,
    });
    const data = parseJsonLoose<Record<string, unknown>>(res.text) ?? {};
    const str = (k: string) => (typeof data[k] === "string" ? (data[k] as string).trim() : "");
    const analysis: BookAnalysis = {
      sourceLanguage: str("sourceLanguage") || undefined,
      translatedTitle: str("translatedTitle") || undefined,
      profile: {
        genre: str("genre"),
        tone: str("tone"),
        narrativeVoice: str("narrativeVoice"),
        styleNotes: str("styleNotes"),
        synopsis: str("synopsis") || undefined,
      },
      glossary: cleanTerms(data.glossary),
      tocTranslations: Array.isArray(data.tocTranslations) ? data.tocTranslations.map((x) => String(x ?? "").trim()) : [],
    };
    return { ...analysis, usage: res.usage };
  }

  async analyzeChapter(input: ChapterAnalysisInput, signal?: AbortSignal): Promise<ChapterAnalysis & { usage: BatchOutput["usage"] }> {
    const res = await this.llm.complete({
      purpose: "analysis",
      system: analysisSystemPrompt(),
      user: chapterAnalysisPrompt(input),
      maxTokens: 8000,
      json: { name: "chapter_analysis", schema: CHAPTER_ANALYSIS_SCHEMA },
      effort: "low",
      signal,
    });
    const data = parseJsonLoose<Record<string, unknown>>(res.text) ?? {};
    return {
      summary: typeof data.summary === "string" ? data.summary.trim() : "",
      newTerms: cleanTerms(data.newTerms),
      usage: res.usage,
    };
  }

  async translateBatch(input: BatchInput): Promise<BatchOutput> {
    const sourceChars = input.segments.reduce((s, x) => s + x.text.length, 0);
    const res = await this.llm.complete({
      purpose: "translation",
      system: translationSystemPrompt(input.book),
      user: translationUserPrompt(input),
      // inclui folga para o raciocínio do modelo (thinking conta no limite)
      maxTokens: Math.min(64000, Math.max(16000, Math.ceil(sourceChars * 1.2) + 8000)),
      signal: input.signal,
    });
    return {
      translations: parseSegments(res.text),
      newTerms: parseNewTerms(res.text),
      truncated: res.stopReason === "max_tokens",
      refused: res.stopReason === "refusal",
      usage: res.usage,
    };
  }
}
