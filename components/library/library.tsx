"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { BookSummary } from "@/types/book";
import { api } from "@/lib/client";
import { isActive } from "@/lib/format";
import { ButtonLink } from "@/components/ui/button";
import { Plus } from "@/components/ui/icons";
import { LinkPending } from "@/components/ui/pending";
import { Bookshelf, EmptyShelf } from "./bookshelf";
import { BookSheet } from "./book-sheet";
import { assignBindings, countLine, sortBooks, summaryOf } from "./book-look";
import s from "./bookshelf.module.css";

/** Parâmetro da URL com o livro aberto: o Voltar do celular fecha o painel e o link reabre o livro. */
const PARAM = "livro";

function urlWith(id: string | null) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set(PARAM, id);
  else url.searchParams.delete(PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * “Meus livros”: a pequena biblioteca do cliente. A lista inicial vem do
 * servidor (sem carregar de novo no navegador); enquanto algum livro traduz,
 * ela se atualiza a cada 3 s (e para quando a aba fica escondida).
 */
export function Library({ initial }: { initial: BookSummary[] }) {
  const [books, setBooks] = useState(() => sortBooks(initial));
  const [openId, setOpenId] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [flight, setFlight] = useState(true);
  const panelId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);

  // estado atual para os ouvintes do histórico (registrados uma vez só)
  const live = useRef({ books, openId, closing });
  useEffect(() => {
    live.current = { books, openId, closing };
  });
  /** abrimos com pushState (então Voltar/fechar = history.back) */
  const pushed = useRef(false);
  /** para onde vai o foco depois de fechar: o livro na estante ou o título */
  const focusAfter = useRef<string | null>(null);

  const bindings = useMemo(() => assignBindings(books), [books]);

  /* ---------- atualização ao vivo ---------- */
  const anyActive = books.some((b) => isActive(b.status));
  useEffect(() => {
    if (!anyActive) return;
    let alive = true;
    let busy = false;
    const tick = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const { books: list } = await api<{ books: BookSummary[] }>("/api/books");
        if (alive) setBooks(sortBooks(list));
      } catch {
        /* sem rede: tenta de novo no próximo ciclo */
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(tick, 3000);
    const onVisible = () => !document.hidden && void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [anyActive]);

  /* ---------- abrir e fechar (com o histórico do navegador) ---------- */
  const open = useCallback((id: string) => {
    if (live.current.openId) return;
    window.history.pushState({ versoLivro: id }, "", urlWith(id));
    pushed.current = true;
    setFlight(true);
    setClosing(false);
    setOpenId(id);
  }, []);

  const requestClose = useCallback(() => {
    const { openId: id, closing: already } = live.current;
    if (!id || already) return;
    if (pushed.current && window.history.state?.versoLivro === id) {
      window.history.back(); // o popstate fecha
      return;
    }
    pushed.current = false;
    window.history.replaceState(null, "", urlWith(null));
    setClosing(true);
  }, []);

  const onClosed = useCallback(() => {
    focusAfter.current = live.current.openId;
    setOpenId(null);
    setClosing(false);
  }, []);

  // ?livro=<id> ao carregar (link ou recarregar a página) e Voltar/Avançar
  useEffect(() => {
    const fromUrl = () => new URLSearchParams(window.location.search).get(PARAM);
    const first = fromUrl();
    if (first) {
      if (live.current.books.some((b) => b.id === first)) {
        pushed.current = false;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- abre o livro pedido no link
        setFlight(false);
        setOpenId(first);
      } else {
        window.history.replaceState(null, "", urlWith(null));
      }
    }
    const onPop = () => {
      const id = fromUrl();
      const { openId: current, closing: already, books: list } = live.current;
      if (!id) {
        if (current && !already) {
          pushed.current = false;
          setClosing(true);
        }
        return;
      }
      if (!current && list.some((b) => b.id === id)) {
        pushed.current = window.history.state?.versoLivro === id;
        setFlight(true);
        setClosing(false);
        setOpenId(id);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // o livro aberto sumiu da lista (ex.: foi apagado): fecha e devolve o foco ao título
  const openBook = openId ? books.find((b) => b.id === openId) : undefined;
  useEffect(() => {
    if (!openId || openBook) return;
    if (pushed.current) window.history.replaceState(null, "", urlWith(null));
    pushed.current = false;
    focusAfter.current = "";
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reage à lista atualizada
    setOpenId(null);
    setClosing(false);
  }, [openId, openBook]);

  // depois de fechar (o fundo já voltou a ser interativo), o foco volta para o livro
  useEffect(() => {
    if (openId !== null || focusAfter.current === null) return;
    const id = focusAfter.current;
    focusAfter.current = null;
    const target = id ? document.querySelector<HTMLElement>(`[data-slot="${CSS.escape(id)}"] button`) : null;
    (target ?? headingRef.current)?.focus({ preventScroll: true });
  }, [openId]);

  const origin = useCallback(
    () => (openId ? document.querySelector<HTMLElement>(`[data-slot="${CSS.escape(openId)}"] [data-book-scene]`) : null),
    [openId],
  );

  const count = books.length;
  const summary = summaryOf(books);

  return (
    <div className={s.theme}>
      <header className="rise">
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="serif text-[2.6rem] leading-none font-[380] tracking-[-0.035em] whitespace-nowrap text-ink outline-none sm:text-[3.4rem]"
        >
          Meus livros
        </h1>
        {/* o botão desce para a linha de baixo quando falta espaço; o título nunca quebra */}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <p className="num text-[0.9375rem] text-muted">{countLine(count)}</p>
          {count > 0 && (
            <ButtonLink href="/" variant="secondary" size="sm" className="relative shrink-0 !pr-5 !pl-4">
              <Plus />
              Novo livro
              <LinkPending className="absolute right-2" />
            </ButtonLink>
          )}
        </div>
        {summary.length > 0 && (
          <p className="num mt-2 text-[0.875rem] leading-relaxed text-pretty text-ink-2">
            {summary.map((part, i) => (
              <span key={part.key}>
                <span className="whitespace-nowrap">
                  {part.live && (
                    <span className="pulse-dot mr-2 mb-[0.15em] inline-block h-1.5 w-1.5 rounded-full bg-accent align-middle" aria-hidden />
                  )}
                  {part.text}
                  {i < summary.length - 1 && <span className="pr-[0.15em] pl-[0.4em] text-muted">·</span>}
                </span>{" "}
              </span>
            ))}
          </p>
        )}
      </header>

      {count === 0 ? (
        <div className="mt-8 sm:mt-12">
          <EmptyShelf />
          <div className="rise mt-7 max-w-[26rem]" style={{ animationDelay: "160ms" }}>
            <p className="text-[0.9375rem] leading-relaxed text-pretty text-ink-2">
              Envie um EPUB ou PDF. Ele entra nesta estante e é traduzido do começo ao fim, com capítulos e capa.
            </p>
            <ButtonLink href="/" size="lg" className="relative mt-6 w-full sm:w-auto">
              <Plus />
              Traduzir meu primeiro livro
              <LinkPending className="absolute right-5" />
            </ButtonLink>
          </div>
        </div>
      ) : (
        <div className="mt-8 sm:mt-12">
          <Bookshelf books={books} bindings={bindings} openId={openId} panelId={panelId} onOpen={open} />
          {count === 1 && (
            <p className="serif mt-6 text-[1.125rem] leading-snug text-balance text-ink-2 italic">
              Os próximos livros que você traduzir vão ficar aqui.
            </p>
          )}
          <p className={`${s.hint} mt-4 text-[0.8125rem] text-muted`} data-hidden={openId ? "" : undefined} aria-hidden={openId ? true : undefined}>
            <span className={s.hintTouch}>Toque em um livro para tirá-lo da estante.</span>
            <span className={s.hintPointer}>Clique em um livro para tirá-lo da estante.</span>
          </p>
        </div>
      )}

      {openBook && (
        <BookSheet
          key={openBook.id}
          id={panelId}
          book={openBook}
          binding={bindings.get(openBook.id)!}
          closing={closing}
          flight={flight}
          origin={origin}
          onRequestClose={requestClose}
          onClosed={onClosed}
        />
      )}
    </div>
  );
}
