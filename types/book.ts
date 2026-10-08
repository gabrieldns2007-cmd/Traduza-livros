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

/**
 * Uma execução de tradução (um “começar” ou “continuar”, ou uma prévia):
 * quem traduziu, quanto consumiu e quanto custou. É a base para calcular a
 * margem real de cada livro (`npm run custos`).
 */
export interface TranslationRun {
  id: string;
  kind: "translation" | "preview";
  provider: string;
  model: string;
  /** quem paga o processamento (ver ProviderConfig.billing) */
  billing: "byok" | "hosted" | "none";
  startedAt: string;
  endedAt?: string;
  /** tempo de processamento (ms) */
  activeMs: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** custo estimado pela tabela de preços (US$); null se o modelo não tem preço conhecido */
  costUsd: number | null;
  words: number;
  segments: number;
  chapters: number;
  /** créditos (em milésimos): taxa da qualidade, quanto foi reservado e cobrado */
  credits: {
    quality: string;
    per1k: number;
    /** o que esta execução valeria em créditos (sempre calculado, mesmo sem cobrança) */
    valueMilli: number;
    reservedMilli: number;
    chargedMilli: number;
    mode: "off" | "preview" | "enforce";
  };
  stopReason?: string;
}

/**
 * Pedido de tradução: o que o cliente comprou. O preço fica travado no
 * momento do pedido e cobre as palavras que faltavam traduzir.
 */
export interface BookOrder {
  id: string;
  /** tipo de tradução escolhido pelo cliente */
  level: "padrao" | "literaria";
  words: number;
  priceBrl: number;
  status: "awaiting_payment" | "paid" | "canceled" | "refunded";
  /** "beta": confirmado sem cobrança durante o beta; "provider": pago pelo meio de pagamento */
  payment: "beta" | "provider" | null;
  /** meio de pagamento usado (ex.: "simulado", "mercadopago") */
  paymentProvider?: string;
  createdAt: string;
  paidAt?: string;
  refundedAt?: string;
  /** id do pagamento no meio de pagamento */
  externalId?: string;
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
  /** navegador que enviou o livro (serviço sem contas: cookie aleatório); sem dono, só o painel vê */
  ownerId?: string;
  /** tipo de tradução (o serviço de IA é escolhido por dentro, conforme o tipo) */
  level?: "padrao" | "literaria";
  order?: BookOrder;
  /** pausada à espera de cota: quando continua sozinha (ISO) */
  resumeAt?: string;
  /**
   * revisão automática ao fim da tradução (pedidos de cliente): refaz os trechos
   * que falharam e os que voltaram iguais ao original
   */
  review?: { startedAt: string; finishedAt?: string; segments: number };
  /** histórico de execuções (custo real por tradução) */
  runs?: TranslationRun[];
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
