"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { BookSummary } from "@/types/book";
import { api } from "@/lib/client";
import { Button, ButtonLink } from "@/components/ui/button";
import { Plus } from "@/components/ui/icons";
import { LinkPending } from "@/components/ui/pending";
import { Bookshelf, EmptyShelf } from "./bookshelf";
import { BookSheet } from "./book-sheet";
import { assignBindings, countLine, inMotion, shelfSummary, sortBooks } from "./book-look";
import { useNewBook, type UploadConfig } from "./new-book";
import s from "./bookshelf.module.css";

/** Parâmetro da URL com o livro aberto: o Voltar do celular fecha o painel e o link reabre o livro. */
const PARAM = "livro";

function urlWith(id: string | null) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set(PARAM, id);
  else url.searchParams.delete(PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

const idInUrl = () => new URLSearchParams(window.location.search).get(PARAM);

/** Esta entrada do histórico foi criada por nós ao abrir o livro (sobrevive a recarregar e a voltar de outra página). */
const ours = (id: string) => window.history.state?.versoLivro === id;

/**
 * “Meus livros”: a pequena biblioteca do cliente. A lista inicial vem do
 * servidor (sem carregar de novo no navegador); enquanto algum livro traduz,
 * ela se atualiza a cada 3 s (e para quando a aba fica escondida).
 * Com `upload`, “Novo livro” abre direto o seletor de arquivo.
 */
export function Library({ initial, upload }: { initial: BookSummary[]; upload?: UploadConfig }) {
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
  /** livro pedido pelo histórico enquanto outro painel ainda saía: abre quando ele terminar de sair */
  const pending = useRef<string | null>(null);
  const newBook = useNewBook(upload);

  const bindings = useMemo(() => assignBindings(books), [books]);

  /* ---------- atualização ao vivo ---------- */
  // inclui a tradução pausada só à espera da vez: ela volta sozinha e a estante precisa mostrar
  const anyActive = books.some(inMotion);
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
    // guarda onde a estante estava, para reabrir no mesmo ponto ao voltar de outra página
    window.history.pushState({ versoLivro: id, versoY: window.scrollY }, "", urlWith(id));
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

  // ?livro=<id> ao carregar (link, recarregar ou voltar de outra página) e Voltar/Avançar
  useEffect(() => {
    const first = idInUrl();
    if (first) {
      if (live.current.books.some((b) => b.id === first)) {
        // entrada nossa: fechar volta (history.back) para a /livros que já está antes dela
        pushed.current = ours(first);
        const y = pushed.current ? window.history.state?.versoY : undefined;
        if (typeof y === "number") window.scrollTo(0, y); // a trava do painel guarda esta posição
        // eslint-disable-next-line react-hooks/set-state-in-effect -- abre o livro pedido no link
        setFlight(false);
        setOpenId(first);
      } else {
        window.history.replaceState(null, "", urlWith(null));
      }
    }
    const onPop = () => {
      const id = idInUrl();
      const { openId: current, closing: already, books: list } = live.current;
      pending.current = null;
      if (!id) {
        if (current && !already) {
          pushed.current = false;
          setClosing(true);
        }
        return;
      }
      if (!list.some((b) => b.id === id)) {
        // a URL nunca afirma um livro que não está aberto
        if (!current) window.history.replaceState(null, "", urlWith(null));
        return;
      }
      if (current === id && !already) return;
      if (current) {
        // ainda há um painel (saindo, ou outro livro): este abre quando ele terminar de sair
        pending.current = id;
        if (!already) {
          pushed.current = false;
          setClosing(true);
        }
        return;
      }
      pushed.current = ours(id);
      setFlight(true);
      setClosing(false);
      setOpenId(id);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // o livro aberto sumiu da lista (ex.: foi apagado): fecha e devolve o foco ao título
  const openBook = openId ? books.find((b) => b.id === openId) : undefined;
  useEffect(() => {
    if (!openId || openBook) return;
    if (pushed.current && ours(openId))
      window.history.back(); // volta para a /livros de antes, sem entrada duplicada
    else if (idInUrl()) window.history.replaceState(null, "", urlWith(null));
    pushed.current = false;
    focusAfter.current = "";
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reage à lista atualizada
    setOpenId(null);
    setClosing(false);
  }, [openId, openBook]);

  // depois de fechar (o fundo já voltou a ser interativo): abre o livro que o histórico pediu
  // no meio da saída, ou devolve o foco para o livro na estante
  useEffect(() => {
    if (openId !== null) return;
    const next = pending.current;
    pending.current = null;
    if (next && idInUrl() === next && live.current.books.some((b) => b.id === next)) {
      pushed.current = ours(next);
      focusAfter.current = null;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- segue o histórico
      setFlight(true);
      setOpenId(next);
      return;
    }
    if (focusAfter.current === null) return;
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
  const summary = shelfSummary(books);

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
          {count > 0 &&
            (newBook ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={newBook.pick}
                aria-busy={newBook.progress !== null || undefined}
                className={`num shrink-0 ${newBook.progress === null ? "!pr-5 !pl-4" : ""}`}
              >
                {newBook.progress === null ? (
                  <>
                    <Plus />
                    Novo livro
                  </>
                ) : (
                  newBook.status
                )}
              </Button>
            ) : (
              <ButtonLink href="/" variant="secondary" size="sm" className="relative shrink-0 !pr-5 !pl-4">
                <Plus />
                Novo livro
                <LinkPending className="absolute right-2" />
              </ButtonLink>
            ))}
        </div>
        {count > 0 && newBook?.error && (
          <p className="mt-2 text-[0.875rem] text-accent" role="alert">
            {newBook.error}
          </p>
        )}
        {summary.length > 0 && (
          /* separadores no começo de cada item, cortados na margem: nenhum “·” fica pendurado quando a linha quebra */
          <p className="num mt-2 overflow-hidden text-[0.875rem] leading-relaxed text-ink-2">
            <span className="-ml-[1.1em] flex flex-wrap">
              {summary.map((part) => (
                <span
                  key={part.key}
                  className="relative pl-[1.1em] whitespace-nowrap before:absolute before:left-[0.38em] before:text-muted before:content-['·']"
                >
                  {part.live && (
                    <span className="pulse-dot mr-2 mb-[0.15em] inline-block h-1.5 w-1.5 rounded-full bg-accent align-middle" aria-hidden />
                  )}
                  {part.text}
                </span>
              ))}
            </span>
          </p>
        )}
        {count > 0 && (
          <p className={`${s.hint} mt-3 text-[0.8125rem] text-muted`} data-hidden={openId ? "" : undefined} aria-hidden={openId ? true : undefined}>
            <span className={s.hintTouch}>Toque em um livro para tirá-lo da estante.</span>
            <span className={s.hintPointer}>Clique em um livro para tirá-lo da estante.</span>
          </p>
        )}
      </header>
      {newBook?.input}

      {count === 0 ? (
        <div className="mt-8 sm:mt-12">
          <EmptyShelf />
          <div className="rise mt-7 max-w-[26rem]" style={{ animationDelay: "160ms" }}>
            <p className="text-[0.9375rem] leading-relaxed text-pretty text-ink-2">
              Envie um EPUB ou PDF. Ele entra nesta estante e volta como uma nova edição, do começo ao fim, com capítulos e capa. Você verá o valor
              antes de continuar.
            </p>
            {newBook ? (
              <>
                <Button size="lg" onClick={newBook.pick} aria-busy={newBook.progress !== null || undefined} className="num mt-6 w-full sm:w-auto">
                  {newBook.progress === null ? (
                    <>
                      <Plus />
                      Traduzir meu primeiro livro
                    </>
                  ) : (
                    newBook.status
                  )}
                </Button>
                {newBook.error && (
                  <p className="mt-3 text-[0.875rem] text-accent" role="alert">
                    {newBook.error}
                  </p>
                )}
              </>
            ) : (
              <ButtonLink href="/" size="lg" className="relative mt-6 w-full sm:w-auto">
                <Plus />
                Traduzir meu primeiro livro
                <LinkPending className="absolute right-5" />
              </ButtonLink>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-6 sm:mt-10">
          <Bookshelf books={books} bindings={bindings} openId={openId} panelId={panelId} onOpen={open} newBook={newBook} />
          {count === 1 && (
            <p className="serif mt-6 text-[1.125rem] leading-snug text-balance text-ink-2 italic">
              Os próximos livros que você traduzir vão ficar aqui.
            </p>
          )}
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
          queueAhead={books.some((b) => b.id !== openBook.id && (b.status === "translating" || b.status === "analyzing"))}
          origin={origin}
          onRequestClose={requestClose}
          onClosed={onClosed}
        />
      )}
    </div>
  );
}
