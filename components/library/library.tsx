"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { BookSummary } from "@/types/book";
import { api } from "@/lib/client";
import { languageLabel } from "@/lib/languages";
import { STATUS_LABEL, isActive, formatDate } from "@/lib/format";
import { ProgressBar } from "@/components/ui/progress-bar";
import { ArrowRight } from "@/components/ui/icons";
import { LinkPending } from "@/components/ui/pending";

export function Library({ initial }: { initial: BookSummary[] }) {
  const [books, setBooks] = useState(initial);
  const anyActive = books.some((b) => isActive(b.status));

  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(async () => {
      try {
        const { books: b } = await api<{ books: BookSummary[] }>("/api/books");
        setBooks(b);
      } catch {
        /* ignora */
      }
    }, 3000);
    return () => clearInterval(t);
  }, [anyActive]);

  if (!books.length) {
    return (
      <div className="rise mt-16 border-t border-rule pt-10">
        <p className="serif text-[1.5rem] leading-snug text-ink-2 italic">Nenhum livro ainda.</p>
        <Link href="/" className="group mt-5 inline-flex items-center gap-2 text-[1rem] text-ink">
          Traduza seu primeiro livro <ArrowRight className="transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>
    );
  }

  return (
    <ul className="mt-10 border-t border-rule sm:mt-14">
      {books.map((b, i) => (
        <li key={b.id} className="rise border-b border-rule" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
          <BookRow book={b} />
        </li>
      ))}
    </ul>
  );
}

function Cover({ book }: { book: BookSummary }) {
  const [failed, setFailed] = useState(false);
  if (book.hasCover && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`/api/books/${book.id}/cover`}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
        className="h-[5.25rem] w-[3.6rem] shrink-0 rounded-[3px] object-cover shadow-[0_1px_2px_rgba(0,0,0,0.12),0_4px_14px_rgba(0,0,0,0.06)] sm:h-[6.5rem] sm:w-[4.4rem]"
      />
    );
  }
  // capa tipográfica quando o livro não tem imagem
  return (
    <div className="flex h-[5.25rem] w-[3.6rem] shrink-0 flex-col justify-between rounded-[3px] bg-paper-3 p-1.5 shadow-[inset_0_0_0_1px_var(--rule)] sm:h-[6.5rem] sm:w-[4.4rem] sm:p-2">
      <span className="serif line-clamp-4 text-[0.5rem] leading-[1.15] text-ink-2 sm:text-[0.5625rem]">{book.translatedTitle || book.title}</span>
      <span className="h-px w-3 bg-accent" />
    </div>
  );
}

function BookRow({ book }: { book: BookSummary }) {
  const active = isActive(book.status);
  const title = book.status === "done" && book.translatedTitle ? book.translatedTitle : book.title;
  const source = book.sourceLanguage ?? book.detectedLanguage;
  return (
    <div className="flex gap-4 py-6 sm:gap-6">
      <Link href={`/livros/${book.id}`} className="shrink-0" tabIndex={-1} aria-hidden>
        <Cover book={book} />
      </Link>
      <div className="min-w-0 flex-1">
        <Link href={`/livros/${book.id}`} className="block">
          <h2 className="serif text-[1.3rem] leading-[1.2] tracking-[-0.01em] text-ink text-balance sm:text-[1.5rem]">{title}</h2>
          {book.author && <p className="serif mt-0.5 truncate text-[0.9375rem] text-ink-2 italic">{book.author}</p>}
        </Link>
        <p className="mt-2 text-[0.8125rem] text-muted">
          {languageLabel(source, "Original")} → {languageLabel(book.targetLanguage)}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className={`text-[0.8125rem] ${book.status === "done" ? "text-ink" : book.status === "error" ? "text-accent" : "text-ink-2"}`}>
            {active || book.status === "paused" ? (
              <span className="num">
                {STATUS_LABEL[book.status]} · {Math.floor(book.percent)}%
              </span>
            ) : (
              <span className="num">
                {STATUS_LABEL[book.status]}
                {book.status === "done" ? " · 100%" : ""}
              </span>
            )}
          </span>
          {(active || book.status === "paused") && <ProgressBar value={book.percent} active={active} className="w-24 sm:w-32" />}
          <span className="hidden text-[0.75rem] text-muted sm:inline">{formatDate(book.createdAt)}</span>
        </div>
        <div className="mt-3.5 flex flex-wrap gap-x-5 gap-y-2 text-[0.875rem]">
          {book.status === "done" ? (
            <>
              <Link href={`/livros/${book.id}/revisar/1`} className="link inline-flex items-center gap-1.5 py-1 text-ink">
                Continuar
                <LinkPending />
              </Link>
              <a href={`/api/books/${book.id}/export/epub`} download className="link text-ink-2 hover:text-ink">
                Baixar EPUB
              </a>
              <Link href={`/livros/${book.id}`} className="link inline-flex items-center gap-1.5 py-1 text-ink-2 hover:text-ink">
                Detalhes
                <LinkPending />
              </Link>
            </>
          ) : (
            <Link href={`/livros/${book.id}`} className="link inline-flex items-center gap-1.5 py-1 text-ink">
              {book.status === "ready" ? "Começar" : active ? "Acompanhar" : "Continuar"}
              <LinkPending />
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
