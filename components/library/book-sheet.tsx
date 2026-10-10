"use client";

import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { BookSummary } from "@/types/book";
import { formatNumber, isActive } from "@/lib/format";
import { api } from "@/lib/client";
import { PUBLIC_MODE } from "@/lib/mode";
import { Button, ButtonLink } from "@/components/ui/button";
import { ArrowRight, Check, Close, Download } from "@/components/ui/icons";
import { LinkPending } from "@/components/ui/pending";
import { usePdfDownload } from "@/components/book/use-pdf-download";
import { BookObject } from "./book-object";
import { displayTitle, languagesOf, primaryAction, shelfStatus, typeset, waitingTurn, type Binding } from "./book-look";
import s from "./bookshelf.module.css";

const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";

function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** O retângulo está (ao menos em parte) na tela? */
function onScreen(r: DOMRect | undefined): r is DOMRect {
  return !!r && r.width > 0 && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
}

/**
 * Trava a rolagem da página de um jeito que também funciona no Safari do
 * iPhone (onde `overflow: hidden` no body não basta): o body fica fixo no
 * lugar e a posição é devolvida ao destravar.
 */
function lockScroll() {
  const body = document.body;
  const y = window.scrollY;
  const before = body.getAttribute("style");
  const gutter = window.innerWidth - document.documentElement.clientWidth;
  body.style.position = "fixed";
  body.style.top = `-${y}px`;
  body.style.left = "0";
  body.style.right = "0";
  body.style.width = "100%";
  body.style.overflow = "hidden";
  if (gutter > 0) body.style.paddingRight = `${gutter}px`;
  return () => {
    if (before === null) body.removeAttribute("style");
    else body.setAttribute("style", before);
    window.scrollTo(0, y);
  };
}

/** Tira do alcance (toque, Tab e leitor de tela) tudo o que está atrás do painel. */
function inertExcept(keep: HTMLElement) {
  const changed: HTMLElement[] = [];
  for (const el of Array.from(document.body.children) as HTMLElement[]) {
    if (el === keep || el.inert) continue;
    el.inert = true;
    changed.push(el);
  }
  return () => changed.forEach((el) => (el.inert = false));
}

/**
 * O livro tirado da estante: ele voa do lugar dele até o painel (FLIP só com
 * transform) e volta pelo mesmo caminho ao fechar. O painel traz a situação,
 * os idiomas, o progresso e as ações. Fecham: “Devolver à estante”, Esc,
 * toque fora, arrastar para baixo e o Voltar do celular.
 */
export function BookSheet({
  id,
  book,
  binding,
  closing,
  flight,
  queueAhead,
  origin,
  onRequestClose,
  onClosed,
}: {
  id: string;
  book: BookSummary;
  binding: Binding;
  /** outro livro está sendo traduzido agora (este, na fila, começa depois dele) */
  queueAhead: boolean;
  /** pedido de fechar já aceito: anima a saída e chama `onClosed` */
  closing: boolean;
  /** abrir com o voo a partir da estante */
  flight: boolean;
  /** o livro na estante (para o voo de ida e de volta) */
  origin: () => HTMLElement | null;
  onRequestClose: () => void;
  onClosed: () => void;
}) {
  const titleId = useId();
  const overlayRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const flyerRef = useRef<HTMLDivElement>(null);
  const rigRef = useRef<HTMLSpanElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const closingRef = useRef(closing);
  closingRef.current = closing;
  /** quando o painel abriu (o 2º clique de um clique duplo não pode fechá-lo) */
  const openedAt = useRef(0);

  const requestClose = useEffectEvent(() => onRequestClose());

  /** Põe o livro voador exatamente sobre o livro do painel. */
  const placeFlyer = (to: DOMRect) => {
    const flyer = flyerRef.current!;
    flyer.style.left = `${to.left}px`;
    flyer.style.top = `${to.top}px`;
    flyer.style.setProperty("--hero-w", `${to.width}px`);
  };
  /** O voador só existe (e só usa preserve-3d) durante o voo. */
  const setFlying = (on: boolean) => flyerRef.current?.toggleAttribute("data-flying", on);
  const heroScene = () => heroRef.current?.querySelector<HTMLElement>("[data-book-scene]") ?? null;

  // abrir: trava o fundo, foca o título, e o livro sai da estante
  useLayoutEffect(() => {
    const overlay = overlayRef.current!;
    const panel = panelRef.current!;
    const backdrop = backdropRef.current!;
    const flyer = flyerRef.current!;
    const unlock = lockScroll();
    const restore = inertExcept(overlay);
    openedAt.current = performance.now();
    headingRef.current?.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        requestClose();
        return;
      }
      if (e.key !== "Tab") return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"));
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (e.shiftKey && (current === first || current === headingRef.current || !panel.contains(current))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !panel.contains(current))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const running: Animation[] = [];
    const hero = heroScene();
    const cleanup = () => {
      document.removeEventListener("keydown", onKey);
      running.forEach((a) => a.cancel());
      setFlying(false);
      flyer.style.transform = "";
      if (hero) hero.style.visibility = "";
      restore();
      unlock();
    };
    if (reducedMotion()) return cleanup;

    // mede tudo com o painel parado, antes de qualquer animação
    const from = flight ? origin()?.getBoundingClientRect() : undefined;
    const to = hero?.getBoundingClientRect();

    running.push(
      backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 360, easing: "ease-out" }),
      panel.animate([{ transform: "translateY(100%)" }, { transform: "none" }], { duration: 480, easing: EASE_OUT }),
    );

    if (hero && to && onScreen(from)) {
      placeFlyer(to);
      const k = from.width / to.width;
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      const start = `translate(${dx}px, ${dy}px) scale(${k})`;
      // o primeiro quadro já mostra o livro no lugar dele na estante
      flyer.style.transform = start;
      hero.style.visibility = "hidden";
      setFlying(true);
      const fly = flyer.animate(
        [
          { transform: start, easing: "cubic-bezier(0.3, 0.6, 0.4, 1)" },
          { transform: `translate(${dx}px, ${dy - 16}px) scale(${k * 1.07})`, offset: 0.2, easing: "cubic-bezier(0.25, 0.8, 0.25, 1)" },
          { transform: "none" },
        ],
        { duration: 680 },
      );
      running.push(fly);
      const turn = rigRef.current?.animate(
        [{ transform: "none" }, { transform: "translateZ(14px) rotateY(-16deg)", offset: 0.45 }, { transform: "none" }],
        { duration: 680, easing: "ease-in-out" },
      );
      if (turn) running.push(turn);
      fly.finished
        .then(() => {
          if (closingRef.current) return;
          flyer.style.transform = "";
          setFlying(false);
          hero.style.visibility = "";
        })
        .catch(() => {});
    }
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só ao abrir
  }, []);

  // fechar: o painel desce e o livro volta voando para o lugar dele
  useEffect(() => {
    if (!closing) return;
    let alive = true;
    const finish = () => alive && onClosed();
    if (reducedMotion()) {
      finish();
      return;
    }
    const panel = panelRef.current!;
    const backdrop = backdropRef.current!;
    const flyer = flyerRef.current!;
    const hero = heroScene();
    // se ainda estava chegando, o livro volta de onde está agora
    const from = flyer.hasAttribute("data-flying") ? flyer.getBoundingClientRect() : hero?.getBoundingClientRect();
    const to = origin()?.getBoundingClientRect();

    const current = getComputedStyle(panel).transform;
    panel.getAnimations().forEach((a) => a.cancel());
    const slide = panel.animate([{ transform: current === "none" ? "translateY(0)" : current }, { transform: "translateY(105%)" }], {
      duration: 300,
      easing: "cubic-bezier(0.4, 0, 1, 1)",
      fill: "forwards",
    });
    backdrop.animate([{ opacity: getComputedStyle(backdrop).opacity }, { opacity: 0 }], { duration: 340, easing: "ease-in", fill: "forwards" });

    let landed: Promise<unknown> = slide.finished;
    if (hero && from && onScreen(to)) {
      flyer.getAnimations().forEach((a) => a.cancel());
      flyer.style.transform = "";
      placeFlyer(from);
      hero.style.visibility = "hidden";
      setFlying(true);
      const k = to.width / from.width;
      landed = flyer.animate([{ transform: "none" }, { transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${k})` }], {
        duration: 540,
        easing: "cubic-bezier(0.45, 0, 0.2, 1)",
        fill: "forwards",
      }).finished;
      rigRef.current?.animate([{ transform: "none" }, { transform: "translateZ(10px) rotateY(-12deg)", offset: 0.5 }, { transform: "none" }], {
        duration: 540,
        easing: "ease-in-out",
      });
    }
    landed.then(finish, finish);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só quando começa a fechar
  }, [closing]);

  // arrastar para baixo (pelo livro, pela alça ou pelo topo) devolve o livro
  const drag = useRef<{ id: number; y: number; t: number; dy: number; on: boolean } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.pointerType === "mouse" && e.button !== 0) || closingRef.current) return;
    if ((e.target as Element).closest("a, button")) return;
    drag.current = { id: e.pointerId, y: e.clientY, t: performance.now(), dy: 0, on: false };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const panel = panelRef.current;
    if (!d || d.id !== e.pointerId || !panel) return;
    const dy = e.clientY - d.y;
    if (!d.on) {
      if (dy < -6) drag.current = null;
      if (dy <= 6) return;
      d.on = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      panel.getAnimations().forEach((a) => a.finish());
      panel.style.transition = "none";
    }
    d.dy = Math.max(0, dy - 6);
    panel.style.transform = `translateY(${d.dy}px)`;
    if (backdropRef.current) backdropRef.current.style.opacity = String(Math.max(0.35, 1 - d.dy / 500));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    const panel = panelRef.current;
    if (!d || d.id !== e.pointerId || !d.on || !panel) return;
    const speed = d.dy / Math.max(1, performance.now() - d.t);
    if (d.dy > 96 || (d.dy > 28 && speed > 0.55)) {
      panel.style.transition = "";
      onRequestClose();
      return;
    }
    // volta para o lugar e limpa os estilos do arraste (a saída animada continua funcionando)
    const clear = () => {
      panel.style.transition = "";
      panel.removeEventListener("transitionend", clear);
    };
    panel.addEventListener("transitionend", clear);
    panel.style.transition = reducedMotion() ? "none" : `transform 0.32s ${EASE_OUT}`;
    panel.style.transform = "";
    if (backdropRef.current) backdropRef.current.style.opacity = "";
    if (reducedMotion()) clear();
  };

  const title = typeset(displayTitle(book));
  const active = isActive(book.status);
  const st = shelfStatus(book);
  const action = primaryAction(book);
  const original = book.status === "done" && book.translatedTitle && book.translatedTitle !== book.title ? book.title : null;
  const meter = st.meter && book.status !== "done";
  const pdf = usePdfDownload(book.id);

  // “Continuar” retoma a tradução ali mesmo e abre a página do livro (na versão pública, que pode pedir
  // confirmação de custo, leva à página do livro)
  const router = useRouter();
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState("");
  const resume = async () => {
    setResuming(true);
    setResumeError("");
    try {
      await api(`/api/books/${book.id}/translate`, { method: "POST", json: { action: "resume" } });
      router.push(`/livros/${book.id}`);
    } catch (err) {
      setResumeError((err as Error).message);
      setResuming(false);
    }
  };
  const resumeHere = action.resume && !PUBLIC_MODE;

  return createPortal(
    <div ref={overlayRef} className={`${s.theme} ${s.overlay}`}>
      <div
        ref={backdropRef}
        className={s.backdrop}
        onClick={(e) => {
          // o 2º clique de um clique duplo no livro cai aqui: não fecha o que acabou de abrir
          if (e.detail > 1 || performance.now() - openedAt.current < 400) return;
          onRequestClose();
        }}
        aria-hidden
      />
      <div ref={panelRef} id={id} role="dialog" aria-modal="true" aria-labelledby={titleId} className={s.panel}>
        <div className={s.sheetBg} aria-hidden />
        <div className={s.handle} aria-hidden />
        <div className={s.scroller}>
          <div
            className={`${s.head} select-none`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <div ref={heroRef} className={s.heroCell} aria-hidden>
              <BookObject book={book} binding={binding} variant="hero" eager />
            </div>
            <div className={s.closeRow}>
              <button type="button" onClick={onRequestClose} className={s.closeBtn} aria-label="Devolver à estante">
                <span className={s.closeText}>Devolver à estante</span>
                <Close className="h-[1.0625rem] w-[1.0625rem]" />
              </button>
            </div>
            <div className={`${s.titles} ${s.reveal}`}>
              <p
                className={`label inline-flex items-center gap-1.5 ${book.status === "done" ? "!text-ok" : book.status === "error" ? "!text-accent" : ""}`}
              >
                {st.pulse && <span className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />}
                {book.status === "done" && <Check className="h-3.5 w-3.5" />}
                {st.tone === "quiet" && <span className={s.tagRing} aria-hidden />}
                {st.text}
              </p>
              <h2
                ref={headingRef}
                id={titleId}
                tabIndex={-1}
                className={`${s.sheetTitle} serif mt-1.5 text-[1.375rem] leading-[1.15] tracking-[-0.012em] text-balance text-ink outline-none [overflow-wrap:break-word] sm:text-[1.625rem] [@media(max-height:720px)]:text-[1.25rem]`}
              >
                {title}
              </h2>
              {book.author && <p className="serif mt-1 text-[1rem] leading-snug text-ink-2 italic">{book.author}</p>}
              {original && (
                <p className="mt-1 text-[0.8125rem] leading-snug text-muted">
                  Título original: <span className="serif italic">{original}</span>
                </p>
              )}
            </div>
          </div>

          <dl className={`mt-5 border-t border-rule text-[0.9375rem] ${s.reveal} ${s.reveal2} [@media(max-height:720px)]:mt-4`}>
            <div className={`${s.row} flex items-baseline justify-between gap-4`}>
              <dt className="flex-none text-muted">Idiomas</dt>
              <dd className="min-w-0 text-right text-ink">{languagesOf(book)}</dd>
            </div>
            <div className={`${s.row} ${meter ? s.rowMeter : ""} flex items-baseline justify-between gap-4`}>
              <dt className="flex-none text-muted">Progresso</dt>
              <dd className="num min-w-0 text-right text-ink">
                <ProgressText book={book} percent={st.percent} queueAhead={queueAhead} />
                {meter && (
                  <div
                    className={`${s.meter} ${active ? "" : s.meterCalm}`}
                    role="progressbar"
                    aria-label="Progresso da tradução"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={st.percent}
                  >
                    <span style={{ transform: `scaleX(${Math.max(0.01, st.percent / 100)})` }} />
                  </div>
                )}
              </dd>
            </div>
            <div className={`${s.row} flex items-baseline justify-between gap-4`}>
              <dt className="flex-none text-muted">Tamanho</dt>
              <dd className="num min-w-0 text-right text-ink-2">
                <span className="whitespace-nowrap">
                  {book.chapters} {book.chapters === 1 ? "capítulo" : "capítulos"}
                </span>
                {/* telas estreitas: uma informação por linha, sem “·” pendurado */}
                <span className="max-[359px]:hidden"> · </span>
                <br className="min-[360px]:hidden" />
                <span className="whitespace-nowrap">{formatNumber(book.words)} palavras</span>
              </dd>
            </div>
          </dl>

          <div
            className={`${s.actions} mt-5 flex flex-col gap-2.5 ${s.reveal} ${s.reveal3} [@media(max-height:720px)]:mt-4 [@media(max-height:720px)]:gap-2`}
          >
            {resumeHere ? (
              <Button size="lg" onClick={resume} disabled={resuming} className="w-full [@media(max-height:720px)]:h-12">
                {resuming ? "Continuando…" : action.label}
                {!resuming && <ArrowRight />}
              </Button>
            ) : (
              <ButtonLink href={action.href} size="lg" className="relative w-full [@media(max-height:720px)]:h-12">
                {action.label}
                <ArrowRight />
                <LinkPending className="absolute right-6" />
              </ButtonLink>
            )}
            {resumeError && (
              <p className="text-[0.875rem] text-accent" role="alert">
                {resumeError}
              </p>
            )}
            {book.status === "ready" && <p className="text-center text-[0.8125rem] text-muted">Você verá o valor antes de continuar.</p>}
            {book.status === "done" && (
              <div className="grid grid-cols-2 gap-2.5 [@media(max-height:720px)]:gap-2">
                <ButtonLink
                  href={`/api/books/${book.id}/export/epub`}
                  download
                  variant="secondary"
                  className="w-full !px-3 [@media(max-height:720px)]:h-11"
                >
                  <Download />
                  Baixar EPUB
                </ButtonLink>
                <Button
                  variant="secondary"
                  onClick={pdf.download}
                  disabled={pdf.loading}
                  className="w-full !px-3 disabled:!opacity-60 [@media(max-height:720px)]:h-11"
                >
                  {pdf.loading ? (
                    "Gerando PDF…"
                  ) : (
                    <>
                      <Download />
                      Baixar PDF
                    </>
                  )}
                </Button>
              </div>
            )}
            {pdf.error && (
              <p className="text-[0.875rem] text-accent" role="alert">
                {pdf.error}
              </p>
            )}
            {(book.status === "done" || resumeHere) && (
              <Link
                href={`/livros/${book.id}`}
                className="link mx-auto inline-flex min-h-11 items-center px-3 text-[0.875rem] text-ink-2 hover:text-ink"
              >
                Ver página do livro
              </Link>
            )}
          </div>
        </div>
      </div>
      <div ref={flyerRef} className={s.flyer} aria-hidden>
        <BookObject book={book} binding={binding} variant="hero" eager rigRef={rigRef} />
      </div>
    </div>,
    document.body,
  );
}

/** “21% · atualiza sozinho”, “Nova edição em EPUB e PDF”… */
function ProgressText({ book, percent, queueAhead }: { book: BookSummary; percent: number; queueAhead: boolean }) {
  switch (book.status) {
    case "done":
      return (
        <span className="text-ok">
          <Check className="mr-1.5 inline-block h-4 w-4 align-[-0.2em]" />
          {/* quebra antes de “EPUB e PDF”, nunca deixa “PDF” sozinho na linha */}
          Nova edição em EPUB&nbsp;e&nbsp;PDF
        </span>
      );
    case "ready":
      return <span className="text-ink-2">Esperando você começar</span>;
    case "translating":
      return (
        <>
          {percent}% <span className="text-muted">· atualiza sozinho</span>
        </>
      );
    case "queued":
      // um livro por vez: se outro está traduzindo, este espera ele terminar
      return percent > 0 ? (
        <>{percent}% · na fila</>
      ) : (
        <span className="text-ink-2">{queueAhead ? "Começa após o livro atual" : "Começa em instantes"}</span>
      );
    case "analyzing":
      return percent > 0 ? <>{percent}% · preparando</> : <span className="text-ink-2">Preparando o livro</span>;
    default:
      if (waitingTurn(book))
        return (
          <>
            {percent}% <span className="text-muted">· continua sozinha</span>
          </>
        );
      // pausado ou interrompido: nada do que já foi traduzido se perde
      return percent > 0 ? (
        <>
          {percent}% <span className="text-muted">· tudo salvo</span>
        </>
      ) : (
        <>{percent}% traduzido</>
      );
  }
}
