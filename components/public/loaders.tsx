"use client";

/**
 * Versão pública: as páginas buscam os dados no “servidor” do navegador
 * (mesmas rotas /api) em vez de ler o disco do servidor.
 */
import { useEffect, useState } from "react";
import { notFound, useRouter } from "next/navigation";
import type { BookSummary, GlossaryEntry, ReviewChapter } from "@/types/book";
import type { BookView } from "@/lib/api";
import { api } from "@/lib/client";
import { PageLoading } from "@/components/ui/page-loading";
import { TranslateFlow, type FlowDefaults } from "@/components/home/translate-flow";
import { LibraryPageView } from "@/components/library/library-page-view";
import { BookScreen } from "@/components/book/book-screen";
import { Reader } from "@/components/review/reader";
import { isActive } from "@/lib/format";

function useLoad<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string; missing: boolean } {
  const [state, setState] = useState<{ data: T | null; error: string; missing: boolean }>({ data: null, error: "", missing: false });
  useEffect(() => {
    let alive = true;
    load()
      .then((data) => alive && setState({ data, error: "", missing: false }))
      .catch((err: Error) => alive && setState({ data: null, error: err.message, missing: /não encontrad/i.test(err.message) }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

function LoadError({ message }: { message: string }) {
  return (
    <main className="mx-auto max-w-md px-5 pt-20 text-center">
      <p className="serif text-[1.5rem] text-ink">Não foi possível abrir.</p>
      <p className="mt-3 text-[0.9375rem] text-ink-2">{message}</p>
    </main>
  );
}

export function PublicHomeFlow() {
  const { data, error } = useLoad(
    () =>
      api<{
        settings: { targetLanguage: string; dialogueStyle: "target" | "source"; deepContext: boolean; instructions: string };
        defaultProvider: string;
        maxUploadMb: number;
      }>("/api/settings"),
    [],
  );
  if (error) return <LoadError message={error} />;
  if (!data) return <div className="h-48 animate-pulse rounded-[1.25rem] bg-paper-2" aria-label="Carregando" />;
  const defaults: FlowDefaults = {
    targetLanguage: data.settings.targetLanguage,
    dialogueStyle: data.settings.dialogueStyle,
    deepContext: data.settings.deepContext,
    instructions: data.settings.instructions,
    maxUploadMb: data.maxUploadMb,
    demo: data.defaultProvider === "demo",
  };
  return <TranslateFlow defaults={defaults} />;
}

export function PublicLibrary() {
  const { data, error } = useLoad(() => api<{ books: BookSummary[] }>("/api/books"), []);
  if (error) return <LoadError message={error} />;
  if (!data) return <PageLoading label="Abrindo sua estante…" />;
  return <LibraryPageView books={data.books} />;
}

export function PublicBook({ id }: { id: string }) {
  const { data, error, missing } = useLoad(
    () => Promise.all([api<{ book: BookView }>(`/api/books/${id}`), api<{ entries: GlossaryEntry[] }>(`/api/books/${id}/glossary`)]),
    [id],
  );
  if (missing) notFound();
  if (error) return <LoadError message={error} />;
  if (!data) return <PageLoading label="Abrindo o livro…" />;
  return <BookScreen initial={data[0].book} initialGlossary={data[1].entries} />;
}

export function PublicReview({ id, n }: { id: string; n: string }) {
  const router = useRouter();
  const { data, error, missing } = useLoad(async () => {
    const { book } = await api<{ book: BookView }>(`/api/books/${id}`);
    const index = Math.min(Math.max(0, Number(n) - 1 || 0), book.chapters.length - 1);
    const { chapter } = await api<{ chapter: ReviewChapter }>(`/api/books/${id}/chapters/${book.chapters[index].id}`);
    return { book, index, chapter };
  }, [id, n]);
  useEffect(() => {
    if (data && String(data.index + 1) !== n) router.replace(`/livros/${id}/revisar/${data.index + 1}`);
  }, [data, id, n, router]);
  if (missing) notFound();
  if (error) return <LoadError message={error} />;
  if (!data) return <PageLoading label="Abrindo o capítulo…" />;
  const { book, index, chapter } = data;
  return (
    <Reader
      bookId={id}
      bookTitle={book.translatedTitle || book.title}
      targetLanguage={book.targetLanguage}
      sourceLanguage={book.sourceLanguage ?? book.detectedLanguage ?? null}
      chapters={book.chapters.map((c) => ({
        id: c.id,
        title: c.title,
        translatedTitle: c.translatedTitle,
        done: c.status === "done",
        started: c.translatedSegments > 0,
      }))}
      index={index}
      chapter={chapter}
      translating={isActive(book.status)}
    />
  );
}
