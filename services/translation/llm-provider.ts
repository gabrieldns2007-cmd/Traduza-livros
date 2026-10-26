/** TranslationProvider baseado em um LLM qualquer (Claude, GPT, modelos locais…). */
import type { GlossaryType } from "@/types/book";
import { toPlainText } from "@/lib/markup";
import { ProviderError, type LLMClient, type LLMRequest, type LLMResponse } from "./llm/types";
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
  stripReasoning,
  translationSystemPrompt,
  translationUserPrompt,
} from "./prompts";

const TYPES: GlossaryType[] = ["character", "place", "organization", "term", "other"];

/** Abaixo deste teto de saída (tokens), a análise pede menos nomes (a resposta não pode ser cortada). */
const SMALL_OUTPUT = 8000;

/** Recusa escrita no próprio texto (modelos no formato OpenAI não avisam com um código). */
const REFUSAL_RE =
  /(?<![\p{L}])(?:I(?:['’]m| am) (?:sorry|unable|not able|afraid)|I can(?:no|['’])t|I won['’]t|I must decline|I apologi[sz]e|as an AI|unfortunately|não (?:posso|consigo|é possível)|desculpe|sinto muito|lamento|infelizmente|como (?:um )?modelo de linguagem)(?![\p{L}])/iu;

/**
 * …e fala da tarefa (traduzir, este texto, este pedido), não de uma cena do livro: “— Desculpe —
 * disse ele” numa resposta que perdeu as tags é tradução, não recusa.
 */
const REFUSAL_TASK_RE =
  /(?<![\p{L}])(?:translat\p{L}*|traduz\p{L}*|tradu[çc]\p{L}*|(?:this|that|your) (?:text|passage|content|request|excerpt)|(?:este|esse|esta|essa) (?:texto|trecho|conteúdo|pedido|passagem|solicitação)|(?:help|assist) (?:you )?with (?:this|that)|ajudar com (?:isso|isto)|comply)(?![\p{L}])/iu;

/** Até aqui (caracteres) do começo da resposta é que se procura a recusa: ela vem logo de saída. */
const REFUSAL_HEAD = 200;

/**
 * Resposta (ou o que sobrou depois do último trecho) com cara de “desculpe, não posso
 * traduzir isto”: conta como recusa (o lote é dividido). Fala de personagem (começa com
 * travessão ou aspas) não conta.
 */
export function looksLikeRefusal(text: string): boolean {
  const t = stripReasoning(text)
    .replace(/^[\s*_#>`]+/, "")
    .trim();
  if (!t || /^[—–\-“"‘«<]/.test(t)) return false;
  const head = t.slice(0, REFUSAL_HEAD);
  return REFUSAL_RE.test(head) && REFUSAL_TASK_RE.test(head);
}

/** O que vem depois do último </seg> (sem o bloco <new_terms>): onde fica a recusa no meio do lote. */
function afterLastSegment(text: string): string {
  const t = stripReasoning(text).replace(/<new_terms>[\s\S]*?(?:<\/new_terms>|$)/g, "");
  const end = t.toLowerCase().lastIndexOf("</seg>");
  return end < 0 ? t : t.slice(end + "</seg>".length);
}

type Usage = BatchOutput["usage"];
const addUsage = (a: Usage, b?: Usage): Usage => ({
  inputTokens: a.inputTokens + (b?.inputTokens ?? 0),
  outputTokens: a.outputTokens + (b?.outputTokens ?? 0),
});

/** Análise sem resposta aproveitável: erro passageiro, o livro segue sem ela e a análise é refeita depois. */
function analysisError(what: string, res: LLMResponse, usage: Usage): ProviderError {
  const why = res.stopReason === "max_tokens" ? "veio cortada" : "não veio no formato esperado";
  // os tokens da resposta inútil já foram gastos: vão junto, para entrar na conta
  return new ProviderError(`A análise ${what} ${why}.`, { fatal: false, code: "other", usage });
}

/** Erro no segundo pedido de uma análise: leva junto os tokens do primeiro (já gastos). */
function withUsage(err: unknown, usage: Usage): unknown {
  if (!(err instanceof ProviderError)) return err;
  return new ProviderError(err.message, {
    fatal: err.fatal,
    cause: err.cause,
    code: err.code,
    retryAt: err.retryAt,
    usage: addUsage(usage, err.usage),
  });
}

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
  readonly checkLanguage = true;

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

  /** teto de saída do serviço, quando é baixo */
  private get outputCap() {
    return this.limits.maxOutputTokens;
  }

  async analyzeBook(input: BookAnalysisInput, signal?: AbortSignal) {
    const small = (this.outputCap ?? Infinity) < SMALL_OUTPUT;
    const request = (inp: BookAnalysisInput, entries?: number): Omit<LLMRequest, "signal"> => ({
      purpose: "analysis",
      system: analysisSystemPrompt(),
      user: bookAnalysisPrompt(inp, { glossaryEntries: entries }),
      // nunca acima do teto do serviço (ProviderLimits.maxOutputTokens: Groq 4000, Cloudflare e Mistral 8192)
      maxTokens: Math.min(16000, this.outputCap ?? 16000),
      json: { name: "book_analysis", schema: BOOK_ANALYSIS_SCHEMA },
      effort: "medium",
    });
    // teto de saída baixo: menos nomes e, com um sumário longo, sem os títulos do sumário
    // (os capítulos pegam o título traduzido do próprio texto)
    const compact = (): Omit<LLMRequest, "signal"> => request(input.tocLabels.length > 60 ? { ...input, tocLabels: [] } : input, 30);
    let res = await this.llm.complete({ ...(small ? compact() : request(input)), signal });
    let usage = res.usage;
    if (res.stopReason === "max_tokens" && !small) {
      // cortada (o serviço tem um teto de saída menor que o pedido): uma vez, uma versão menor
      try {
        res = await this.llm.complete({ ...compact(), signal });
      } catch (err) {
        throw withUsage(err, usage);
      }
      usage = addUsage(usage, res.usage);
    }
    const data = res.stopReason === "max_tokens" ? null : parseJsonLoose<Record<string, unknown>>(res.text);
    // nunca grava um perfil cortado ou vazio: ele não seria refeito nunca mais
    if (!data) throw analysisError("do livro", res, usage);
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
    const p = analysis.profile;
    if (!p.genre && !p.tone && !p.narrativeVoice && !p.styleNotes) throw analysisError("do livro", res, usage);
    return { ...analysis, usage };
  }

  async analyzeChapter(input: ChapterAnalysisInput, signal?: AbortSignal): Promise<ChapterAnalysis & { usage: BatchOutput["usage"] }> {
    const small = (this.outputCap ?? Infinity) < SMALL_OUTPUT;
    const res = await this.llm.complete({
      purpose: "analysis",
      system: analysisSystemPrompt(),
      user: chapterAnalysisPrompt(input, { newTerms: small ? 15 : undefined }),
      maxTokens: Math.min(8000, this.outputCap ?? 8000),
      json: { name: "chapter_analysis", schema: CHAPTER_ANALYSIS_SCHEMA },
      effort: "low",
      signal,
    });
    const data = res.stopReason === "max_tokens" ? null : parseJsonLoose<Record<string, unknown>>(res.text);
    if (!data) throw analysisError("do capítulo", res, res.usage);
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
      // inclui folga para o raciocínio do modelo (thinking conta no limite) e ~8 tokens
      // da moldura <seg id="N"></seg> de cada trecho (poesia: centenas de versos curtos)
      maxTokens: Math.min(this.outputCap ?? 64000, 64000, Math.max(16000, Math.ceil(sourceChars * 1.2) + input.segments.length * 8 + 8000)),
      signal: input.signal,
      onWait: input.onWait,
    });
    const truncated = res.stopReason === "max_tokens";
    const translations = parseSegments(res.text, {
      // a entrada repetida (antes ou depois da resposta) não ganha da tradução
      sources: new Map(input.segments.map((s) => [s.id, s.text])),
      // terminou normalmente: o último trecho vale mesmo sem </seg>
      complete: res.stopReason === "end",
    });
    // “desculpe, não posso traduzir isto” no lugar da resposta, ou depois do último trecho que voltou
    const missing = translations.size < input.segments.length;
    const inBand = !truncated && missing && looksLikeRefusal(translations.size ? afterLastSegment(res.text) : res.text);
    return {
      translations,
      // só ficam os nomes que aparecem mesmo neste lote
      newTerms: parseNewTerms(res.text, input.segments.map((s) => toPlainText(s.text)).join("\n")),
      truncated,
      refused: res.stopReason === "refusal" || inBand,
      usage: res.usage,
    };
  }
}
