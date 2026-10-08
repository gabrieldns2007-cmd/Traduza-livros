const WORD_RE = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;
const CJK_RE = /[぀-ヿ㐀-鿿가-힯]/g;

/** Conta palavras; para chinês/japonês/coreano, aproxima pelo número de caracteres. */
export function countWords(text: string): number {
  const cjk = text.match(CJK_RE)?.length ?? 0;
  if (cjk > 0) return Math.round(cjk / 1.5) + (text.replace(CJK_RE, " ").match(WORD_RE)?.length ?? 0);
  return text.match(WORD_RE)?.length ?? 0;
}

/** O texto tem letras ou números (ou seja, algo a traduzir)? */
export function hasMeaningfulText(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

export function collapseWhitespace(text: string): string {
  return text.replace(/[ \t\n\r\f]+/g, " ");
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + "…";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat("pt-BR").format(n);
}

export function slugify(text: string, max = 60): string {
  const s = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
  return s || "livro";
}
