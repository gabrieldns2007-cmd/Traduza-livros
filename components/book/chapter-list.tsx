import Link from "next/link";
import type { BookView } from "@/lib/api";
import { chapterLabel, pad2 } from "@/lib/format";
import { Check } from "@/components/ui/icons";

export function ChapterList({ book }: { book: BookView }) {
  return (
    <section className="mt-16">
      <div className="flex items-baseline justify-between">
        <h2 className="label">Capítulos</h2>
        <span className="num text-[0.75rem] text-muted">{book.chapters.length}</span>
      </div>
      <ol className="mt-3 border-t border-rule">
        {book.chapters.map((c, i) => {
          const active = book.activeChapterIds.includes(c.id);
          const done = c.status === "done";
          const pct = c.wordCount ? Math.round((c.translatedWords / c.wordCount) * 100) : 0;
          const title = chapterLabel((done && c.translatedTitle) || c.title);
          const inner = (
            <>
              <span className="num w-7 shrink-0 pt-[0.2rem] text-[0.75rem] text-muted">{pad2(i + 1)}</span>
              <span className={`serif min-w-0 flex-1 text-[1.0625rem] leading-snug ${done || active ? "text-ink" : "text-ink-2"}`}>{title}</span>
              <span className="flex w-16 shrink-0 items-center justify-end gap-2 pt-[0.15rem]">
                {done ? (
                  c.failedSegments > 0 ? (
                    <span className="text-[0.75rem] text-accent" title="Alguns trechos ficaram no original">
                      {c.failedSegments}!
                    </span>
                  ) : (
                    <Check className="h-4 w-4 text-ink" />
                  )
                ) : active ? (
                  <>
                    <span className="num text-[0.75rem] text-ink-2">{pct}%</span>
                    <span className="pulse-dot h-2 w-2 rounded-full bg-accent" />
                  </>
                ) : (
                  <span className="h-2 w-2 rounded-full border border-rule-strong" />
                )}
              </span>
            </>
          );
          return (
            <li key={c.id} className="border-b border-rule">
              {done || c.translatedSegments > 0 ? (
                <Link
                  href={`/livros/${book.id}/revisar/${i + 1}`}
                  className="flex items-start gap-3 py-3.5 transition-colors hover:bg-paper-2/70 sm:-mx-3 sm:px-3"
                >
                  {inner}
                </Link>
              ) : (
                <div className="flex items-start gap-3 py-3.5 sm:-mx-3 sm:px-3">{inner}</div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
