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
import { OrderProgress } from "@/components/commerce/order-progress";
import { StageTrack } from "@/components/ui/stage-track";
import { AdSlot } from "@/components/ads/ad-slot";
import { bookAdPlacement, type AdConfig } from "@/lib/ads";

/** Publicidade da página do livro (só o servidor próprio passa; a versão pública não tem anúncios). */
type BookAds = { traduzindo?: AdConfig | null; pronto?: AdConfig | null };

export function BookScreen({ initial, initialGlossary, ads }: { initial: BookView; initialGlossary: GlossaryEntry[]; ads?: BookAds }) {
  const router = useRouter();
  const [book, setBook] = useState(initial);
  const [glossary, setGlossary] = useState(initialGlossary);
  // troca da Grátis para a Literária aberta pelo acompanhamento (o pedido ainda não foi feito)
  const [upgrading, setUpgrading] = useState(false);
  const active = isActive(book.status);
  const stopped = book.status === "paused" || book.status === "error";
  // a prévia grátis roda com o livro ainda “pronto”: acompanha também
  const preview = book.preview?.status === "running";
  // Grátis à espera dos serviços gratuitos: confere de vez em quando, para a tela mudar sozinha quando ela voltar
  const waiting = book.status === "paused" && book.stopCode === "waiting";
  const polling = active || preview || waiting;

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
    const t = setInterval(refresh, active ? 3000 : preview ? 2000 : 30_000);
    const g = setInterval(refreshGlossary, waiting ? 60_000 : 12000);
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      clearInterval(g);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [polling, active, preview, waiting, refresh, refreshGlossary]);

  // a troca aberta pelo acompanhamento só vale enquanto o livro está parado: quando ele volta a andar
  // (ou termina), fecha — senão o pedido reabriria sozinho na próxima espera
  useEffect(() => {
    if (!stopped) setUpgrading(false);
  }, [stopped]);

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

  // pedido esperando o pagamento num livro já começado (troca para a Literária, ou um pedido antigo):
  // o pedido volta a aparecer, com as duas saídas — pagar ou seguir na Grátis
  const pendingOrder = !PUBLIC_MODE && stopped && book.order?.status === "awaiting_payment";
  const showOrder = !PUBLIC_MODE && (book.status === "ready" || pendingOrder || (upgrading && stopped));

  const source = book.sourceLanguage ?? book.detectedLanguage;
  const adPlacement = PUBLIC_MODE ? null : bookAdPlacement(book.status);
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
      ) : book.status === "ready" ? (
        // compra de uma tradução: Enviar → Confirmar → Tradução → Baixar
        <Steps steps={COMMERCE_STEPS} current={2} className="mt-8" />
      ) : book.status === "done" ? (
        // depois da compra, as etapas da própria tradução (Livro → … → Pronto)
        <StageTrack current={4} done className="mt-8" />
      ) : null}

      <div className="mt-8 sm:mt-10">
        {PUBLIC_MODE ? (
          <>
            {book.status === "ready" && <StartPanel book={book} onStarted={setBook} />}
            {(active || stopped) && <ProgressPanel book={book} onAction={act} />}
          </>
        ) : showOrder ? (
          <OrderPanel
            book={book}
            onChange={(b) => {
              setUpgrading(false);
              setBook(b);
            }}
            onCancel={pendingOrder ? undefined : () => setUpgrading(false)}
          />
        ) : (
          (active || stopped) && <OrderProgress book={book} onResume={() => act("resume")} onUpgrade={() => setUpgrading(true)} />
        )}
        {book.status === "done" && <DonePanel book={book} onChange={setBook} onRetry={() => act("retry-failed")} />}
      </div>

      {book.status !== "ready" && (
        <>
          <ChapterList book={book} />
          <GlossaryPanel bookId={book.id} entries={glossary} onChange={setGlossary} live={active} />
          {book.profile && (book.profile.genre || book.profile.tone) && <AboutBook profile={book.profile} />}
        </>
      )}

      {/* publicidade: no fim da página (se o espaço sumir ou mudar de altura, a lista de capítulos não pula) —
          nunca no pedido, no pagamento nem entre os botões */}
      {adPlacement && <AdSlot ad={ads?.[adPlacement]} placement={adPlacement} className="mt-14" />}

      <footer className="mt-16 flex flex-wrap items-center justify-between gap-4 border-t border-rule pt-6 text-[0.8125rem] text-muted">
        <span className="num">
          {book.originalFileName}
          {PUBLIC_MODE && book.provider && book.provider.id !== "demo" ? ` · ${book.provider.model}` : ""}
          {PUBLIC_MODE && book.usage.outputTokens > 0 ? ` · ${Math.round((book.usage.inputTokens + book.usage.outputTokens) / 1000)} mil tokens` : ""}
        </span>
        <button onClick={remove} className="link relative before:absolute before:-inset-x-2 before:-inset-y-3 before:content-[''] hover:text-accent">
          Excluir livro
        </button>
      </footer>
    </main>
  );
}
