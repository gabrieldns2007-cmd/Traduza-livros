/**
 * TranslationProvider: a abstração que o resto do app usa para traduzir.
 *
 * Qualquer provedor (Claude, GPT, um modelo local, ou até um serviço que não
 * é LLM, como DeepL) só precisa implementar estes três métodos. O fluxo de
 * capítulos, glossário, progresso e reconstrução não muda.
 */
import type { BookProfile, GlossaryEntry, GlossaryType, TranslationOptions } from "@/types/book";

export interface BookContext {
  title: string;
  author?: string;
  sourceLanguage: string; // nome em inglês, ex.: "English"
  targetLanguage: string; // ex.: "Brazilian Portuguese"
  targetCode: string; // ex.: "pt-BR"
  profile?: BookProfile;
  options: TranslationOptions;
}

export interface BookAnalysisInput {
  book: BookContext;
  /** trechos do início do livro */
  sample: string;
  /** rótulos únicos do sumário, na ordem */
  tocLabels: string[];
}

export interface GlossaryCandidate {
  term: string;
  translation: string;
  type: GlossaryType;
  note?: string;
}

export interface BookAnalysis {
  sourceLanguage?: string;
  translatedTitle?: string;
  profile: BookProfile;
  glossary: GlossaryCandidate[];
  /** traduções dos rótulos do sumário (mesma ordem; pode vir incompleto) */
  tocTranslations: string[];
}

export interface ChapterAnalysisInput {
  book: BookContext;
  chapterTitle: string;
  text: string;
  knownTerms: string[];
  previousSummaries: string[];
}

export interface ChapterAnalysis {
  summary: string;
  newTerms: GlossaryCandidate[];
}

export interface BatchSegment {
  id: number;
  /** marcação compacta (ver lib/markup.ts) */
  text: string;
}

export interface BatchInput {
  book: BookContext;
  glossary: GlossaryEntry[];
  storySoFar: string[];
  chapterTitle: string;
  chapterSummary?: string;
  /** últimos parágrafos já traduzidos (continuidade) */
  preceding: string[];
  segments: BatchSegment[];
  /** reforço quando é uma nova tentativa (tags perdidas, segmentos faltando) */
  strict?: boolean;
  /**
   * por que é uma nova tentativa: códigos de lib/quality.ts ("echo", "leak", "wrong-language"…)
   * e do processador ("missing", "tags", "misaligned"). O pedido diz o que corrigir.
   */
  issues?: string[];
  signal?: AbortSignal;
  /** chamado quando o provedor precisa esperar um limite (ms) */
  onWait?: (ms: number) => void;
}

export interface BatchOutput {
  /** id do segmento → tradução (marcação compacta, ainda não validada) */
  translations: Map<number, string>;
  /** nomes/termos novos que o modelo listou junto da tradução (economiza uma chamada por capítulo) */
  newTerms?: GlossaryCandidate[];
  truncated: boolean;
  refused: boolean;
  usage: { inputTokens: number; outputTokens: number };
}

export interface ProviderLimits {
  /**
   * caracteres por pedido (vários capítulos pequenos cabem num pedido só);
   * conta o texto de origem e a moldura <seg id="N"></seg> de cada trecho
   */
  batchChars: number;
  /** trechos por pedido (padrão 120); poesia tem muitos trechos curtos, então o Gemini aceita mais */
  maxSegments?: number;
  /** pedidos simultâneos */
  concurrency: number;
  /**
   * teto de tokens de saída por pedido, quando o serviço tem um teto baixo (ex.: Groq, 4000):
   * a análise do livro pede menos nomes, para a resposta não ser cortada no meio
   */
  maxOutputTokens?: number;
}

export interface TranslationProvider {
  readonly id: string;
  readonly model: string;
  /** pode gerar cobrança */
  readonly paid: boolean;
  readonly limits: ProviderLimits;
  /**
   * a saída vem de um modelo de tradução de verdade: além da formatação, cada trecho passa
   * pela conferência de idioma (voltou igual ao original, ficou no idioma de origem) antes
   * de ser gravado. O provedor de demonstração devolve o original de propósito e não liga isto.
   */
  readonly checkLanguage?: boolean;
  analyzeBook(input: BookAnalysisInput, signal?: AbortSignal): Promise<BookAnalysis & { usage?: BatchOutput["usage"] }>;
  analyzeChapter(input: ChapterAnalysisInput, signal?: AbortSignal): Promise<ChapterAnalysis & { usage?: BatchOutput["usage"] }>;
  translateBatch(input: BatchInput): Promise<BatchOutput>;
}
