import type { BookStatus, BookSummary } from "@/types/book";
import { STATUS_LABEL, isActive } from "@/lib/format";
import { languageLabel } from "@/lib/languages";

/**
 * A cara de cada livro na estante, em funções puras (sem DOM): ordem, tons de
 * encadernação, espessura, situação na etiqueta e ação principal. O mesmo
 * livro tem sempre a mesma cara, no servidor e no navegador.
 */

/* ---------- título e ordem ---------- */

/** Título mostrado: o traduzido quando o livro está pronto. */
export function displayTitle(book: BookSummary) {
  return book.status === "done" && book.translatedTitle ? book.translatedTitle : book.title;
}

/** Quem pede atenção fica no alto: traduzindo, preparando, na fila, parados, não iniciados e, por fim, prontos. */
const PRIORITY: Record<BookStatus, number> = {
  translating: 0,
  analyzing: 1,
  queued: 2,
  paused: 3,
  error: 3,
  ready: 4,
  done: 5,
};

/**
 * Ordem estável da estante: prioridade da situação e, dentro dela, o mais
 * recente primeiro (data de envio — nunca a da última atualização, que muda a
 * cada poucos segundos durante a tradução).
 */
export function sortBooks<T extends BookSummary>(books: T[]): T[] {
  return [...books].sort(
    (a, b) =>
      PRIORITY[a.status] - PRIORITY[b.status] || Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/* ---------- encadernação ---------- */

/** FNV-1a: número estável a partir de um texto. */
export function hash(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export type Binding = {
  name: string;
  /** tecido da capa */
  cloth: string;
  /** lombada (um tom abaixo do tecido) */
  spine: string;
  /** tinta do título */
  ink: string;
  /** filetes e selo */
  rule: string;
  /** família de cor: vizinhos nunca da mesma */
  family: "azul" | "verde" | "vermelho" | "claro" | "neutro" | "terra";
};

/** Tecidos sóbrios de encadernação (título com contraste ≥ 4,5:1 em todos). */
export const BINDINGS: Binding[] = [
  { name: "azul-tinta", cloth: "#1f2b3a", spine: "#18222e", ink: "#ece4d3", rule: "#c9a36a", family: "azul" },
  { name: "verde-garrafa", cloth: "#2c3d33", spine: "#223029", ink: "#e9e2d0", rule: "#c7a96c", family: "verde" },
  { name: "vinho", cloth: "#4a2320", spine: "#3b1b19", ink: "#f1e5d4", rule: "#d9b07a", family: "vermelho" },
  { name: "linho", cloth: "#e4d9c3", spine: "#cbbd9f", ink: "#2a241e", rule: "#a5401f", family: "claro" },
  { name: "grafite", cloth: "#2a2826", spine: "#1f1e1c", ink: "#ebe4d7", rule: "#d77a52", family: "neutro" },
  { name: "ardósia", cloth: "#4b5762", spine: "#3c464f", ink: "#f2ece1", rule: "#e2c49a", family: "azul" },
  { name: "couro", cloth: "#7a5c35", spine: "#634a2a", ink: "#fbf4e6", rule: "#f0dcb4", family: "terra" },
  { name: "terracota", cloth: "#7c402c", spine: "#653424", ink: "#f7ece0", rule: "#ecd2a8", family: "vermelho" },
  { name: "sálvia", cloth: "#5b6957", spine: "#4b5747", ink: "#f4f1e8", rule: "#ebdfbc", family: "verde" },
];

/**
 * Um tecido para cada livro da lista, na ordem da estante: escolhido pelo id
 * e trocado quando cairia na mesma família de cor do vizinho (lado a lado
 * nunca o mesmo tom). Só contam os vizinhos com capa tipográfica.
 */
export function assignBindings(books: BookSummary[]): Map<string, Binding> {
  const out = new Map<string, Binding>();
  let prev: Binding | null = null;
  for (const book of books) {
    const h = hash(book.id);
    const step = 1 + ((h >>> 8) % (BINDINGS.length - 1));
    let i = h % BINDINGS.length;
    for (let tries = 0; prev && BINDINGS[i].family === prev.family && tries < BINDINGS.length; tries++) i = (i + step) % BINDINGS.length;
    out.set(book.id, BINDINGS[i]);
    prev = book.hasCover ? null : BINDINGS[i];
  }
  return out;
}

/** Espessura (fração da largura da capa) pelo número de palavras: conto fino, romance grosso. */
export function thicknessOf(words: number) {
  const f = Math.log(Math.max(words, 4000) / 4000) / Math.log(50);
  return Math.round((0.09 + 0.17 * Math.min(1, Math.max(0, f))) * 1000) / 1000;
}

/** Pequenas diferenças de formato, como numa estante de verdade (sempre iguais para o mesmo livro). */
export function shapeOf(book: BookSummary) {
  const h = hash(`${book.id}:forma`);
  return {
    scale: [1, 0.965, 0.94, 0.985][h % 4],
    ratio: book.hasCover ? 1.45 : [1.5, 1.53, 1.47, 1.55][(h >>> 4) % 4],
  };
}

/** Tamanho do título na capa tipográfica, para títulos longos nunca saírem da capa. */
export function titleFit(title: string): "normal" | "long" | "xlong" {
  const longest = Math.max(0, ...title.split(/\s+/).map((w) => w.length));
  if (title.length > 60 || longest > 14) return "xlong";
  if (title.length > 30 || longest > 10) return "long";
  return "normal";
}

/** Título da capa tipográfica: títulos enormes terminam em “…” numa palavra inteira (o título completo fica no painel). */
export function coverTitle(title: string, max = 78) {
  if (title.length <= max) return title;
  const cut = title.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, "")}…`;
}

/* ---------- cor da lombada a partir da capa ---------- */

export type EdgeTone = { spine: string; ink: string; rule: string; light: boolean };

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * Cor média da faixa esquerda da capa → um tom de encadernação sóbrio:
 * capas claras continuam claras (linho, papel), as outras viram um tecido
 * escuro, com saturação contida. Nunca berrante, nunca barrento.
 */
export function edgeTone(r: number, g: number, b: number): EdgeTone {
  const [h, s, l] = rgbToHsl(r, g, b);
  const hue = Math.round(h);
  if (l >= 0.58) {
    const L = clamp(l, 0.7, 0.84);
    return { spine: `hsl(${hue} ${Math.round(Math.min(s, 0.24) * 100)}% ${Math.round(L * 100)}%)`, ink: "#2a241e", rule: "#9a4a2c", light: true };
  }
  const L = clamp(l, 0.16, 0.38);
  return { spine: `hsl(${hue} ${Math.round(Math.min(s, 0.4) * 100)}% ${Math.round(L * 100)}%)`, ink: "#f1ebe0", rule: "#d2b57c", light: false };
}

/* ---------- situação e ações ---------- */

export type ShelfStatus = {
  /** texto curto da etiqueta (sempre cabe num lugar de ~100 px) */
  text: string;
  tone: "live" | "calm" | "alert" | "quiet" | "done";
  /** ponto pulsando: só enquanto traduz de verdade */
  pulse: boolean;
  /** barrinha e % (não aparece em “Na fila”/“Preparando” a 0%) */
  meter: boolean;
  percent: number;
};

export function shelfStatus(book: BookSummary): ShelfStatus {
  const percent = Math.max(0, Math.min(100, Math.floor(book.percent)));
  switch (book.status) {
    case "translating":
      return { text: "Traduzindo", tone: "live", pulse: true, meter: true, percent };
    case "analyzing":
      return { text: "Preparando", tone: "calm", pulse: false, meter: percent > 0, percent };
    case "queued":
      return { text: "Na fila", tone: "calm", pulse: false, meter: percent > 0, percent };
    case "paused":
      return { text: "Pausado", tone: "calm", pulse: false, meter: true, percent };
    case "error":
      return { text: "Interrompido", tone: "alert", pulse: false, meter: percent > 0, percent };
    case "ready":
      return { text: "Não iniciado", tone: "quiet", pulse: false, meter: false, percent: 0 };
    case "done":
      return { text: "Pronto", tone: "done", pulse: false, meter: false, percent: 100 };
  }
}

export type Action = { label: string; href: string };

/** Ação principal de cada situação — sempre um botão de verdade. */
export function primaryAction(book: BookSummary): Action {
  if (book.status === "done") return { label: "Ler e revisar", href: `/livros/${book.id}/revisar/1` };
  if (book.status === "ready") return { label: "Começar tradução", href: `/livros/${book.id}` };
  if (isActive(book.status)) return { label: "Acompanhar", href: `/livros/${book.id}` };
  return { label: "Continuar", href: `/livros/${book.id}` };
}

/** “Inglês → Português (Brasil)”. */
export function languagesOf(book: BookSummary, arrow = " → ") {
  return `${languageLabel(book.sourceLanguage ?? book.detectedLanguage, "Idioma original")}${arrow}${languageLabel(book.targetLanguage)}`;
}

/** Nome acessível do livro na estante: o que é, como está e o que o toque faz. */
export function bookAria(book: BookSummary) {
  const st = shelfStatus(book);
  const progress = st.meter && book.status !== "done" ? `, ${st.percent}%` : "";
  return `${displayTitle(book)}${book.author ? `, de ${book.author}` : ""}. ${STATUS_LABEL[book.status]}${progress}. ${languagesOf(book, " para ")}. Ver detalhes e ações.`;
}

/** Contagem do cabeçalho. */
export function countLine(n: number) {
  if (n === 0) return "Sua estante está vazia.";
  return n === 1 ? "Um livro na estante." : `${n} livros na estante.`;
}

export type SummaryPart = { key: string; text: string; live?: boolean };

/** Linha de resumo: “● 1 traduzindo agora · 1 pausado · 1 pronto para ler”. */
export function summaryOf(books: BookSummary[]): SummaryPart[] {
  const n = (s: BookStatus[]) => books.filter((b) => s.includes(b.status)).length;
  const parts: SummaryPart[] = [];
  const translating = n(["translating"]);
  const waiting = n(["queued", "analyzing"]);
  const paused = n(["paused"]);
  const stopped = n(["error"]);
  const done = n(["done"]);
  if (translating) parts.push({ key: "translating", text: `${translating} traduzindo agora`, live: true });
  if (waiting) parts.push({ key: "waiting", text: `${waiting} na fila` });
  if (paused) parts.push({ key: "paused", text: paused === 1 ? "1 pausado" : `${paused} pausados` });
  if (stopped) parts.push({ key: "error", text: stopped === 1 ? "1 interrompido" : `${stopped} interrompidos` });
  if (done) parts.push({ key: "done", text: done === 1 ? "1 pronto para ler" : `${done} prontos para ler` });
  return parts;
}
