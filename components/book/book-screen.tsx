"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { GlossaryEntry } from "@/types/book";
import type { BookView } from "@/lib/api";
import { api } from "@/lib/client";
import { languageLabel } from "@/lib/languages";
import { isActive } from "@/lib/format";
import { ProgressPanel } from "./progress-panel";
import { DonePanel } from "./done-panel";
import { StartPanel } from "./start-panel";
import { ChapterList } from "./chapter-list";
import { GlossaryPanel } from "./glossary-panel";
import { AboutBook } from "./about-book";
import { PUBLIC_MODE } from "@/lib/mode";
import { COMMERCE_STEPS, Steps } from "@/components/ui/steps";
import { OrderPanel } from "@/components/commerce/order-panel";

export function BookScreen({ initial, initialGlossary }: { initial: BookView; initialGlossary: GlossaryEntry[] }) {
  const router = useRouter();
  const [book, setBook] = useState(initial);
  const [glossary, setGlossary] = useState(initialGlossary);
  const active = isActive(book.status);
  // a prévia grátis roda com o livro ainda “pronto”: acompanha também
  const polling = active || book.preview?.status === "running";

  const refresh = useCallback(async () => {
    try {
      const { book: b } = await api<{ book: BookView }>(`/api/books/${book.id}`);
      if (b) setBook(b);
    } catch {
      /* rede instável: tenta de novo no próximo ciclo */
    }
  }, [book.id]);

  const refreshGlossary = useCallback(async () => {
    try {
      const { entries } = await api<{ entries: GlossaryEntry[] }>(`/api/books/${book.id}/glossary`);
      setGlossary(entries);
    } catch {
      /* ignora */
    }
  }, [book.id]);

  // acompanha o progresso enquanto a tradução está em andamento
  useEffect(() => {
    if (!polling) return;
    const t = setInterval(refresh, active ? 3000 : 2000);
    const g = setInterval(refreshGlossary, 12000);
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      clearInterval(g);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [polling, active, refresh, refreshGlossary]);

  // ao terminar, atualiza o glossário uma última vez
  useEffect(() => {
    if (book.status === "done") void refreshGlossary();
  }, [book.status, refreshGlossary]);

  const act = async (action: "pause" | "resume" | "retry-failed", extra?: { providerId?: string; confirmCost?: boolean; partial?: boolean }) => {
    const { book: b } = await api<{ book: BookView }>(`/api/books/${book.id}/translate`, { method: "POST", json: { action, ...extra } });
    if (b) setBook(b);
  };

  const remove = async () => {
    if (!confirm("Excluir este livro e a tradução? Essa ação não pode ser desfeita.")) return;
    await api(`/api/books/${book.id}`, { method: "DELETE" });
    router.push("/livros");
    router.refresh();
  };

  const source = book.sourceLanguage ?? book.detectedLanguage;
  const displayTitle = book.translatedTitle && book.status === "done" ? book.translatedTitle : book.title;

  return (
    <main className="mx-auto w-full max-w-[44rem] px-5 pt-6 pb-28 sm:px-8 sm:pt-12">
      {/* cabeçalho editorial */}
      <header className="rise">
        <p className="label">
          {languageLabel(source, "Idioma original")} <span className="mx-1 text-rule-strong">→</span> {languageLabel(book.targetLanguage)}
        </p>
        <h1 className="serif mt-3 text-[2.35rem] leading-[1.04] font-[400] tracking-[-0.03em] text-ink text-balance sm:text-[3.25rem]">
          {displayTitle}
        </h1>
        {book.author && <p className="serif mt-2 text-[1.125rem] text-ink-2 italic">{book.author}</p>}
        {book.status === "done" && book.translatedTitle && book.translatedTitle !== book.title && (
          <p className="mt-2 text-[0.8125rem] text-muted">
            Original: <span className="serif italic">{book.title}</span>
          </p>
        )}
      </header>

      {PUBLIC_MODE ? (
        <Steps current={book.status === "ready" ? 2 : 3} done={book.status === "done"} className="mt-8" />
      ) : (
        // compra de uma tradução: Enviar → Confirmar → Tradução → Baixar
        <Steps
          steps={COMMERCE_STEPS}
          current={book.status === "ready" ? 2 : book.status === "done" ? 4 : 3}
          done={book.status === "done"}
          className="mt-8"
        />
      )}

      <div className="mt-8 sm:mt-10">
        {book.status === "ready" && (PUBLIC_MODE ? <StartPanel book={book} onStarted={setBook} /> : <OrderPanel book={book} onChange={setBook} />)}
        {(active || book.status === "paused" || book.status === "error") && <ProgressPanel book={book} onAction={act} />}
        {book.status === "done" && <DonePanel book={book} onChange={setBook} onRetry={() => act("retry-failed")} />}
      </div>

      {book.status !== "ready" && (
        <>
          <ChapterList book={book} />
          <GlossaryPanel bookId={book.id} entries={glossary} onChange={setGlossary} live={active} />
          {book.profile && (book.profile.genre || book.profile.tone) && <AboutBook profile={book.profile} />}
        </>
      )}

      <footer className="mt-16 flex flex-wrap items-center justify-between gap-4 border-t border-rule pt-6 text-[0.8125rem] text-muted">
        <span className="num">
          {book.originalFileName}
          {PUBLIC_MODE && book.provider && book.provider.id !== "demo" ? ` · ${book.provider.model}` : ""}
          {PUBLIC_MODE && book.usage.outputTokens > 0 ? ` · ${Math.round((book.usage.inputTokens + book.usage.outputTokens) / 1000)} mil tokens` : ""}
        </span>
        <button onClick={remove} className="link hover:text-accent">
          Excluir livro
        </button>
      </footer>
    </main>
  );
}
