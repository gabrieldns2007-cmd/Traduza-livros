import type { BookStatus, ChapterStatus } from "@/types/book";

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return "calculando…";
  if (seconds < 60) return "< 1 min";
  const min = Math.round(seconds / 60);
  if (min < 60) return `~${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `~${h} h ${m} min` : `~${h} h`;
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat("pt-BR").format(Math.round(n));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

/** “VI” → “Capítulo VI”; títulos de verdade ficam como estão. */
export function chapterLabel(title: string): string {
  const t = title.trim();
  if (/^([IVXLCDM]+|\d+)\.?$/i.test(t)) return `Capítulo ${t.replace(/\.$/, "")}`;
  return t;
}

export const STATUS_LABEL: Record<BookStatus, string> = {
  ready: "Não iniciado",
  queued: "Na fila",
  analyzing: "Preparando",
  translating: "Traduzindo",
  paused: "Pausado",
  done: "Concluído",
  error: "Interrompido",
};

export const CHAPTER_STATUS_LABEL: Record<ChapterStatus, string> = {
  pending: "Aguardando",
  analyzing: "Lendo",
  translating: "Traduzindo",
  done: "Traduzido",
  error: "Erro",
};

export function isActive(status: BookStatus) {
  return status === "queued" || status === "analyzing" || status === "translating";
}

export function pad2(n: number) {
  return String(n).padStart(2, "0");
}
