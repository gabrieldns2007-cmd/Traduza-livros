/**
 * Identificação dos capítulos.
 *
 * Cada arquivo do spine é um “documento”. Os capítulos que o usuário vê são
 * definidos pelo sumário: se várias entradas apontam para âncoras dentro do
 * mesmo arquivo, o arquivo é dividido nesses pontos. Sem sumário, cada
 * arquivo com texto vira um capítulo, nomeado pelo primeiro título.
 */
import type { ChapterMeta, DocContent, DocMeta, TocEntry } from "@/types/book";
import { toPlainText } from "@/lib/markup";
import { truncate } from "@/utils/text";

export interface ParsedDoc {
  meta: DocMeta;
  content: DocContent;
  anchors: Record<string, number>;
  title: string | null;
}

interface Split {
  start: number;
  title: string;
  depth: number;
}

export function buildChapters(docs: ParsedDoc[], toc: TocEntry[]): ChapterMeta[] {
  const chapters: ChapterMeta[] = [];
  const maxDepth = 1;

  for (const doc of docs) {
    const n = doc.content.segments.length;
    if (n === 0) continue;

    const entries = toc.filter((t) => t.href === doc.meta.href && t.depth <= maxDepth);
    const splits: Split[] = [];
    for (const e of entries) {
      const start = e.fragment ? doc.anchors[e.fragment] : 0;
      if (start === undefined || start >= n) continue;
      const existing = splits.find((s) => s.start === start);
      if (existing) {
        if (e.depth < existing.depth) Object.assign(existing, { title: e.label, depth: e.depth });
        continue;
      }
      splits.push({ start, title: e.label, depth: e.depth });
    }
    splits.sort((a, b) => a.start - b.start);

    if (!splits.length || splits[0].start > 0) {
      splits.unshift({ start: 0, title: titleFor(doc, 0, splits[0]?.start ?? n), depth: 0 });
    }

    for (let i = 0; i < splits.length; i++) {
      const start = splits[i].start;
      const end = i + 1 < splits.length ? splits[i + 1].start : n;
      if (end <= start) continue;
      const segs = doc.content.segments.slice(start, end);
      const words = segs.reduce((s, x) => s + x.words, 0);
      chapters.push({
        id: `c${String(chapters.length + 1).padStart(3, "0")}`,
        docId: doc.meta.id,
        start,
        end,
        href: doc.meta.href,
        title: splits[i].title || titleFor(doc, start, end),
        wordCount: words,
        segmentCount: segs.length,
        translatedSegments: 0,
        translatedWords: 0,
        failedSegments: 0,
        status: "pending",
      });
    }
  }
  return chapters;
}

function titleFor(doc: ParsedDoc, start: number, end: number): string {
  const segs = doc.content.segments.slice(start, end);
  const heading = segs.find((s) => s.role === "heading" && (s.level ?? 9) <= 3) ?? segs.find((s) => s.role === "heading");
  if (heading) return truncate(toPlainText(heading.src).trim(), 120);
  if (start === 0 && doc.title) return doc.title;
  const first = segs[0];
  return first ? truncate(toPlainText(first.src).trim(), 60) : "Sem título";
}

/** Segmentos e blocos de exibição de um capítulo (intervalo de um documento). */
export function chapterBlocks(content: DocContent, chapter: Pick<ChapterMeta, "start" | "end">, isLastInDoc: boolean) {
  const out: DocContent["blocks"] = [];
  let next = 0; // índice do próximo segmento
  for (const b of content.blocks) {
    if (b.t === "s") {
      if (b.i >= chapter.start && b.i < chapter.end) out.push(b);
      next = b.i + 1;
      continue;
    }
    const inRange = next >= chapter.start && next < chapter.end;
    const trailing = isLastInDoc && next >= chapter.end && next >= content.segments.length;
    if (inRange || trailing) out.push(b);
  }
  return out;
}
