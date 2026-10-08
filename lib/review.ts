import type { BookMeta, ChapterMeta, DocContent, ReviewChapter } from "@/types/book";
import { renderSafeHtml } from "@/lib/markup";
import { chapterBlocks } from "@/services/parsing/chapters";

export function assetUrl(bookId: string, path: string) {
  return `/api/books/${bookId}/assets/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function isLastInDoc(meta: BookMeta, chapter: ChapterMeta) {
  return !meta.chapters.some((c) => c.docId === chapter.docId && c.start >= chapter.end);
}

/** Capítulo pronto para a tela de revisão (HTML seguro, sem atributos do livro). */
export function reviewChapter(meta: BookMeta, chapter: ChapterMeta, content: DocContent): ReviewChapter {
  const blocks = chapterBlocks(content, chapter, isLastInDoc(meta, chapter));
  return {
    id: chapter.id,
    index: meta.chapters.findIndex((c) => c.id === chapter.id),
    title: chapter.title,
    translatedTitle: chapter.translatedTitle,
    status: chapter.status,
    blocks: blocks.map((b) => {
      if (b.t === "s") {
        const s = content.segments[b.i];
        return {
          t: "s" as const,
          seg: {
            i: s.i,
            role: s.role,
            level: s.level,
            center: s.center,
            srcHtml: renderSafeHtml(s.src, content.tags),
            outHtml: s.out !== undefined ? renderSafeHtml(s.out, content.tags) : null,
            edited: s.edited,
            failed: s.failed,
          },
        };
      }
      if (b.t === "img") return { t: "img" as const, src: assetUrl(meta.id, b.src), alt: b.alt };
      return b;
    }),
  };
}
