/**
 * Modelo de dados do Verso.
 *
 * Um livro é guardado como:
 *   - o EPUB de origem (original, ou gerado a partir de um PDF);
 *   - um "esqueleto" XHTML por capítulo, em que cada bloco de texto traduzível
 *     foi substituído por um marcador <!--tl:N-->;
 *   - os segmentos (texto de origem + tradução) em um formato de marcação
 *     compacto, em que as tags inline viram marcadores como <em_3>…</em_3>.
 *
 * Isso permite reconstruir um EPUB fiel ao original, apenas com o texto trocado.
 */

export type BookStatus =
  | "ready" // enviado e analisado, aguardando início
  | "queued" // na fila
  | "analyzing" // conhecendo o livro (perfil + glossário)
  | "translating"
  | "paused"
  | "done"
  | "error";

export type ChapterStatus = "pending" | "analyzing" | "translating" | "done" | "error";

export type SourceFormat = "epub" | "pdf";

/** Um arquivo XHTML do EPUB (spine). */
export interface DocMeta {
  id: string;
  /** posição no spine (0-based) */
  index: number;
  /** caminho do arquivo dentro do EPUB */
  href: string;
  segmentCount: number;
}

/**
 * Um capítulo lógico: um intervalo de segmentos de um documento.
 * Normalmente é um arquivo inteiro, mas quando o sumário aponta para
 * âncoras dentro do mesmo arquivo (comum em livros do Gutenberg), o arquivo
 * é dividido em vários capítulos.
 */
export interface ChapterMeta {
  id: string;
  docId: string;
  /** primeiro segmento (inclusive) */
  start: number;
  /** último segmento (exclusive) */
  end: number;
  href: string;
  title: string;
  translatedTitle?: string;
  wordCount: number;
  segmentCount: number;
  translatedSegments: number;
  translatedWords: number;
  failedSegments: number;
  status: ChapterStatus;
  /** resumo curto do capítulo (contexto para os capítulos seguintes) */
  summary?: string;
  /** provedor e modelo que traduziram o capítulo */
  provider?: string;
  model?: string;
}

export type GlossaryType = "character" | "place" | "organization" | "term" | "other";

export interface GlossaryEntry {
  id: string;
  term: string;
  translation: string;
  type: GlossaryType;
  note?: string;
  origin: "auto" | "user";
}

export interface BookProfile {
  genre: string;
  tone: string;
  narrativeVoice: string;
  styleNotes: string;
  synopsis?: string;
}

export interface TocEntry {
  label: string;
  translatedLabel?: string;
  /** caminho (sem âncora) do documento de destino */
  href: string;
  /** âncora dentro do documento, se houver */
  fragment?: string;
  depth: number;
}

export interface TranslationOptions {
  /** instruções livres do usuário (ex.: “use ‘você’, nunca ‘tu’”) */
  instructions?: string;
  /** "target": convenções tipográficas do idioma de destino (ex.: travessão); "source": manter as do original */
  dialogueStyle: "target" | "source";
  /** análise prévia de cada capítulo (resumo + novos termos para o glossário) */
  deepContext: boolean;
}

/** O que a tradução está fazendo agora (só em memória, para a tela). */
export interface BookActivity {
  /** "request": pedido enviado, aguardando resposta; "waiting": esperando um limite do provedor */
  kind: "request" | "waiting";
  since: string;
  until?: string;
  /** capítulos incluídos no pedido */
  chapters?: number;
}

export interface BookProgress {
  translatedWords: number;
  translatedSegments: number;
  startedAt?: string;
  finishedAt?: string;
  /** tempo efetivo traduzindo (ms), usado para estimar o tempo restante */
  activeMs: number;
  /** palavras traduzidas no período medido por activeMs */
  measuredWords: number;
}

/** Prévia grátis: um trecho traduzido antes de decidir traduzir o livro todo. */
export interface BookPreview {
  status: "running" | "done" | "error";
  provider: { id: string; model: string };
  chapterId: string;
  docId: string;
  /** intervalo de segmentos (no documento) incluídos na prévia */
  start: number;
  end: number;
  error?: string;
  at: string;
}

export interface BookMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  originalFileName: string;
  originalFormat: SourceFormat;
  fileSize: number;
  title: string;
  translatedTitle?: string;
  author?: string;
  /** null = detectar automaticamente */
  sourceLanguage: string | null;
  detectedLanguage?: string | null;
  targetLanguage: string;
  status: BookStatus;
  error?: string;
  /** motivo técnico da última parada (ex.: "credits") */
  stopCode?: string;
  /** descrição curta da etapa atual, para a tela de progresso */
  phase?: string;
  activeChapterIds: string[];
  docs: DocMeta[];
  chapters: ChapterMeta[];
  toc: TocEntry[];
  totals: { words: number; segments: number; chapters: number };
  progress: BookProgress;
  profile?: BookProfile;
  options: TranslationOptions;
  provider?: { id: string; model: string };
  preview?: BookPreview;
  usage: { inputTokens: number; outputTokens: number };
  /** caminho da imagem de capa dentro do EPUB */
  cover?: string;
  /** incrementado a cada edição manual (invalida exportações em cache) */
  contentVersion: number;
}

/* ---------- conteúdo dos documentos ---------- */

export interface InlineTag {
  /** nome do elemento (em, strong, a, span, br…) */
  n: string;
  /** tag de abertura original, com atributos (ou o elemento inteiro, se v) */
  o: string;
  /** elemento vazio/opaco: renderizado como está, sem conteúdo traduzível */
  v?: 1;
}

export type SegmentRole = "heading" | "paragraph" | "quote" | "list" | "caption" | "cell" | "other";

export interface Segment {
  i: number;
  /** elemento de bloco que contém o segmento (p, h1, li…) */
  tag: string;
  role: SegmentRole;
  level?: number;
  center?: boolean;
  /** texto de origem em marcação compacta (ver lib/markup.ts) */
  src: string;
  /** tradução na mesma marcação */
  out?: string;
  edited?: boolean;
  failed?: boolean;
  words: number;
}

export type DisplayBlock = { t: "s"; i: number } | { t: "hr" } | { t: "img"; src: string; alt?: string } | { t: "orn"; text: string };

/** Conteúdo de um documento: tabela de tags inline, segmentos e blocos de exibição. */
export interface DocContent {
  tags: Record<string, InlineTag>;
  segments: Segment[];
  blocks: DisplayBlock[];
}

/* ---------- respostas da API ---------- */

export interface BookSummary {
  id: string;
  title: string;
  translatedTitle?: string;
  author?: string;
  sourceLanguage: string | null;
  detectedLanguage?: string | null;
  targetLanguage: string;
  status: BookStatus;
  percent: number;
  chapters: number;
  words: number;
  originalFormat: SourceFormat;
  hasCover: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewSegment {
  i: number;
  role: SegmentRole;
  level?: number;
  center?: boolean;
  /** HTML seguro (apenas tags inline permitidas, sem atributos) */
  srcHtml: string;
  outHtml: string | null;
  edited?: boolean;
  failed?: boolean;
}

export type ReviewBlock = { t: "s"; seg: ReviewSegment } | { t: "hr" } | { t: "img"; src: string; alt?: string } | { t: "orn"; text: string };

export interface ReviewChapter {
  id: string;
  index: number;
  title: string;
  translatedTitle?: string;
  status: ChapterStatus;
  blocks: ReviewBlock[];
}
