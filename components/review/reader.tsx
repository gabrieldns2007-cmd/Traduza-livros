"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReviewBlock, ReviewChapter, ReviewSegment } from "@/types/book";
import type { EditedNode } from "@/lib/markup";
import { api } from "@/lib/client";
import { chapterLabel, pad2 } from "@/lib/format";
import { Sheet } from "@/components/ui/sheet";
import { ArrowLeft, ArrowRight, Check, Columns, Contents, Dots, Pencil } from "@/components/ui/icons";
import { EditableText } from "./editable-text";

export interface ReaderChapterInfo {
  id: string;
  title: string;
  translatedTitle?: string;
  done: boolean;
  started: boolean;
}

interface Props {
  bookId: string;
  bookTitle: string;
  targetLanguage: string;
  sourceLanguage: string | null;
  chapters: ReaderChapterInfo[];
  index: number;
  chapter: ReviewChapter;
  translating: boolean;
}

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

const SIZES = ["text-[1.0625rem]", "", "text-[1.3125rem]"];

export function Reader(props: Props) {
  const { bookId, chapters, index } = props;
  const router = useRouter();
  const [chapter, setChapter] = useState(props.chapter);
  const [showOriginal, setShowOriginal] = useState(false);
  const [editing, setEditing] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [save, setSave] = useState<SaveState>("idle");
  const [size, setSize] = useState(1);
  const pending = useRef(new Map<number, () => EditedNode[]>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setChapter(props.chapter), [props.chapter]);

  // preferências de leitura ficam no aparelho
  useEffect(() => {
    try {
      const s = Number(localStorage.getItem("verso:size"));
      if (s >= 0 && s <= 2) setSize(s);
      setShowOriginal(localStorage.getItem("verso:original") === "1");
    } catch {
      /* armazenamento indisponível */
    }
  }, []);
  const remember = (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* ignora */
    }
  };

  // enquanto o livro ainda está sendo traduzido, atualiza o capítulo aberto
  useEffect(() => {
    if (!props.translating || editing) return;
    const t = setInterval(async () => {
      try {
        const { chapter: c } = await api<{ chapter: ReviewChapter }>(`/api/books/${bookId}/chapters/${chapter.id}`);
        setChapter(c);
      } catch {
        /* ignora */
      }
    }, 4000);
    return () => clearInterval(t);
  }, [props.translating, editing, bookId, chapter.id]);

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!pending.current.size) return;
    const edits = [...pending.current.entries()].map(([i, read]) => ({ i, nodes: read() }));
    pending.current.clear();
    setSave("saving");
    try {
      const { saved } = await api<{ saved: { i: number; outHtml: string }[] }>(`/api/books/${bookId}/chapters/${chapter.id}`, {
        method: "PATCH",
        json: { edits },
      });
      const ids = new Set(saved.map((s) => s.i));
      setChapter((c) => ({
        ...c,
        blocks: c.blocks.map((b) =>
          b.t === "s" && ids.has(b.seg.i)
            ? { ...b, seg: { ...b.seg, edited: true, failed: false, outHtml: saved.find((s) => s.i === b.seg.i)!.outHtml } }
            : b,
        ),
      }));
      setSave("saved");
    } catch {
      setSave("error");
    }
  }, [bookId, chapter.id]);

  const markDirty = useCallback(
    (i: number, read: () => EditedNode[]) => {
      pending.current.set(i, read);
      setSave("dirty");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, 1500);
    },
    [flush],
  );

  // salva ao sair da página ou trocar de aba
  useEffect(() => {
    const onHide = () => document.visibilityState === "hidden" && void flush();
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [flush]);

  const go = useCallback(
    async (n: number) => {
      if (n < 1 || n > chapters.length) return;
      await flush();
      setTocOpen(false);
      router.push(`/livros/${bookId}/revisar/${n}`);
    },
    [bookId, chapters.length, flush, router],
  );

  // setas do teclado navegam entre capítulos (quando não está editando)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing || (e.target as HTMLElement)?.isContentEditable || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowRight") void go(index + 2);
      if (e.key === "ArrowLeft") void go(index);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editing, go, index]);

  const retranslate = async () => {
    setMenuOpen(false);
    if (!confirm("Retraduzir este capítulo? Os parágrafos que você editou serão mantidos.")) return;
    await api(`/api/books/${bookId}/chapters/${chapter.id}`, { method: "POST", json: { action: "retranslate" } });
    router.push(`/livros/${bookId}`);
  };

  const pendingCount = chapter.blocks.filter((b) => b.t === "s" && b.seg.outHtml === null).length;
  const firstIsHeading = useMemo(() => {
    const first = chapter.blocks.find((b) => b.t === "s");
    return first?.t === "s" && first.seg.role === "heading";
  }, [chapter.blocks]);
  const displayTitle = chapterLabel(chapter.translatedTitle || chapter.title);

  const toc = (
    <ol className="space-y-px">
      {chapters.map((c, i) => {
        const current = i === index;
        return (
          <li key={c.id}>
            <button
              onClick={() => go(i + 1)}
              className={`flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${current ? "bg-paper-3/70" : "hover:bg-paper-2"}`}
              aria-current={current ? "page" : undefined}
            >
              <span className="num w-6 shrink-0 pt-[0.15rem] text-[0.75rem] text-muted">{pad2(i + 1)}</span>
              <span
                className={`serif min-w-0 flex-1 text-[0.9875rem] leading-snug ${current ? "text-ink" : c.started ? "text-ink-2" : "text-muted"}`}
              >
                {chapterLabel((c.done && c.translatedTitle) || c.title)}
              </span>
              {c.done && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />}
            </button>
          </li>
        );
      })}
    </ol>
  );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[18rem_1fr]">
      {/* ---------- índice lateral (desktop) ---------- */}
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-rule lg:flex">
        <div className="px-6 pt-7 pb-5">
          <Link href={`/livros/${bookId}`} className="group inline-flex items-center gap-1.5 text-[0.8125rem] text-muted hover:text-ink">
            <ArrowLeft className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-0.5" /> Voltar ao livro
          </Link>
          <p className="serif mt-5 text-[1.25rem] leading-snug text-ink">{props.bookTitle}</p>
          <p className="label mt-2">Sumário</p>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 pb-8">{toc}</nav>
      </aside>

      <div className="min-w-0">
        {/* ---------- barra superior ---------- */}
        <header className="sticky top-0 z-30 border-b border-rule bg-paper/92 pt-[env(safe-area-inset-top)] backdrop-blur-md">
          <div className="mx-auto flex h-14 max-w-[64rem] items-center gap-2 px-3 sm:px-6">
            <Link href={`/livros/${bookId}`} className="rounded-full p-2 text-ink-2 hover:text-ink lg:hidden" aria-label="Voltar ao livro">
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[0.8125rem] text-muted lg:hidden">{props.bookTitle}</p>
              <p className="truncate text-[0.875rem] text-ink">{displayTitle}</p>
            </div>
            <SaveIndicator state={save} />
            <button
              onClick={() => {
                setShowOriginal((v) => !v);
                remember("verso:original", showOriginal ? "0" : "1");
              }}
              aria-pressed={showOriginal}
              aria-label="Mostrar original"
              className={`inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[0.8125rem] transition-colors ${showOriginal ? "bg-ink text-paper" : "text-ink-2 hover:bg-paper-2"}`}
            >
              <Columns className="h-4 w-4" />
              <span className="hidden sm:inline">Original</span>
            </button>
            <button
              onClick={() => {
                if (editing) void flush();
                setEditing((v) => !v);
              }}
              aria-pressed={editing}
              className={`inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[0.8125rem] transition-colors ${editing ? "bg-accent text-white" : "text-ink-2 hover:bg-paper-2"}`}
            >
              <Pencil className="h-4 w-4" />
              <span>{editing ? "Concluir" : "Editar"}</span>
            </button>
            <div className="relative">
              <button onClick={() => setMenuOpen((v) => !v)} className="rounded-full p-2 text-ink-2 hover:bg-paper-2" aria-label="Mais opções">
                <Dots />
              </button>
              {menuOpen && (
                <>
                  <button className="fixed inset-0 z-40 cursor-default" aria-hidden tabIndex={-1} onClick={() => setMenuOpen(false)} />
                  <div className="fade-in absolute top-11 right-0 z-50 w-60 rounded-2xl border border-rule bg-paper p-2 shadow-[0_12px_40px_rgba(0,0,0,0.12)]">
                    <div className="flex items-center justify-between px-3 py-2">
                      <span className="text-[0.8125rem] text-ink-2">Tamanho do texto</span>
                      <span className="flex gap-1">
                        {[0, 1, 2].map((s) => (
                          <button
                            key={s}
                            onClick={() => {
                              setSize(s);
                              remember("verso:size", String(s));
                            }}
                            className={`serif h-8 w-8 rounded-full ${size === s ? "bg-ink text-paper" : "text-ink-2 hover:bg-paper-2"}`}
                            style={{ fontSize: `${0.8 + s * 0.18}rem` }}
                          >
                            A
                          </button>
                        ))}
                      </span>
                    </div>
                    <a
                      href={`/api/books/${bookId}/export/epub`}
                      download
                      className="block rounded-lg px-3 py-2.5 text-[0.875rem] text-ink hover:bg-paper-2"
                    >
                      Baixar EPUB
                    </a>
                    <button onClick={retranslate} className="block w-full rounded-lg px-3 py-2.5 text-left text-[0.875rem] text-ink hover:bg-paper-2">
                      Retraduzir este capítulo
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        {/* ---------- texto ---------- */}
        <main className={`mx-auto px-5 pt-10 pb-36 sm:px-8 sm:pt-14 lg:pb-24 ${showOriginal ? "max-w-[64rem]" : "max-w-[40rem]"}`}>
          <p className="label text-center">
            {index + 1} de {chapters.length}
          </p>
          {!firstIsHeading && (
            <h1 className="serif mt-8 mb-10 text-center text-[1.9rem] leading-tight tracking-[-0.015em] text-ink text-balance">{displayTitle}</h1>
          )}

          {editing && (
            <p className="rise mx-auto mt-6 max-w-[32rem] rounded-xl bg-accent-soft/60 px-4 py-3 text-center text-[0.8125rem] leading-relaxed text-ink-2">
              Toque em um parágrafo para editar. As alterações são salvas sozinhas.
              <span className="hidden sm:inline"> ⌘/Ctrl+I itálico · ⌘/Ctrl+B negrito.</span>
            </p>
          )}
          {pendingCount > 0 && !editing && (
            <p className="mt-6 text-center text-[0.8125rem] text-muted">
              {props.translating
                ? "Este capítulo ainda está sendo traduzido — os trechos em cinza aparecem em instantes."
                : `${pendingCount} trechos ainda no original.`}
            </p>
          )}

          <article className={`book-text mt-8 ${SIZES[size]}`} lang={props.targetLanguage}>
            {chapter.blocks.map((b, idx) => (
              <Block
                key={b.t === "s" ? `s${b.seg.i}` : `b${idx}`}
                block={b}
                prev={chapter.blocks[idx - 1]}
                showOriginal={showOriginal}
                editing={editing}
                sourceLang={props.sourceLanguage ?? undefined}
                targetLang={props.targetLanguage}
                onDirty={markDirty}
                onCommit={() => {
                  if (timer.current) clearTimeout(timer.current);
                  timer.current = setTimeout(flush, 250);
                }}
              />
            ))}
          </article>

          {/* navegação no fim do capítulo (desktop) */}
          <nav className="mt-20 hidden items-start justify-between gap-6 border-t border-rule pt-6 lg:flex">
            {index > 0 ? (
              <button onClick={() => go(index)} className="group max-w-[45%] text-left">
                <span className="label inline-flex items-center gap-1.5">
                  <ArrowLeft className="h-3 w-3" /> Capítulo anterior
                </span>
                <span className="serif mt-1.5 block text-[1.0625rem] text-ink-2 group-hover:text-ink">
                  {chapterLabel(chapters[index - 1].translatedTitle || chapters[index - 1].title)}
                </span>
              </button>
            ) : (
              <span />
            )}
            {index < chapters.length - 1 && (
              <button onClick={() => go(index + 2)} className="group max-w-[45%] text-right">
                <span className="label inline-flex items-center gap-1.5">
                  Próximo capítulo <ArrowRight className="h-3 w-3" />
                </span>
                <span className="serif mt-1.5 block text-[1.0625rem] text-ink-2 group-hover:text-ink">
                  {chapterLabel(chapters[index + 1].translatedTitle || chapters[index + 1].title)}
                </span>
              </button>
            )}
          </nav>
        </main>

        {/* ---------- barra inferior (celular/tablet) ---------- */}
        <nav className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-rule bg-paper/94 backdrop-blur-md lg:hidden">
          <div className="mx-auto flex h-14 max-w-[40rem] items-center justify-between px-2">
            <button
              onClick={() => go(index)}
              disabled={index === 0}
              className="inline-flex h-11 items-center gap-1.5 rounded-full px-3 text-[0.875rem] text-ink-2 disabled:opacity-30"
            >
              <ArrowLeft className="h-4 w-4" /> <span className="hidden min-[400px]:inline">Anterior</span>
            </button>
            <button onClick={() => setTocOpen(true)} className="inline-flex h-11 items-center gap-2 rounded-full px-4 text-[0.875rem] text-ink">
              <Contents className="h-[1.1rem] w-[1.1rem] text-ink-2" />
              <span className="num">
                Capítulo {index + 1} de {chapters.length}
              </span>
            </button>
            <button
              onClick={() => go(index + 2)}
              disabled={index >= chapters.length - 1}
              className="inline-flex h-11 items-center gap-1.5 rounded-full px-3 text-[0.875rem] text-ink-2 disabled:opacity-30"
            >
              <span className="hidden min-[400px]:inline">Próximo</span> <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </nav>

        <Sheet open={tocOpen} onClose={() => setTocOpen(false)} title="Sumário">
          <div className="pb-4">{toc}</div>
        </Sheet>
      </div>
    </div>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  if (state === "idle") return null;
  const label = state === "dirty" ? "Editando" : state === "saving" ? "Salvando…" : state === "saved" ? "Salvo" : "Erro ao salvar";
  return (
    <span className={`hidden text-[0.75rem] sm:inline ${state === "error" ? "text-accent" : "text-muted"}`} aria-live="polite">
      {label}
    </span>
  );
}

function Block({
  block,
  prev,
  showOriginal,
  editing,
  sourceLang,
  targetLang,
  onDirty,
  onCommit,
}: {
  block: ReviewBlock;
  prev?: ReviewBlock;
  showOriginal: boolean;
  editing: boolean;
  sourceLang?: string;
  targetLang: string;
  onDirty: (i: number, read: () => EditedNode[]) => void;
  onCommit: () => void;
}) {
  if (block.t === "hr" || block.t === "orn") {
    return (
      <div className="my-9 text-center text-[0.9rem] tracking-[0.6em] text-muted select-none" aria-hidden>
        ⁂
      </div>
    );
  }
  if (block.t === "img") {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={block.src} alt={block.alt ?? ""} loading="lazy" className="mx-auto my-8 max-h-[70vh] w-auto max-w-full rounded-[2px]" />
    );
  }
  const seg = block.seg;
  const prevIsBreak = !prev || prev.t !== "s" || prev.seg.role === "heading" || prev.seg.role !== "paragraph";
  return (
    <SegmentView
      seg={seg}
      indent={!prevIsBreak}
      showOriginal={showOriginal}
      editing={editing}
      sourceLang={sourceLang}
      targetLang={targetLang}
      onDirty={onDirty}
      onCommit={onCommit}
    />
  );
}

function SegmentView({
  seg,
  indent,
  showOriginal,
  editing,
  sourceLang,
  targetLang,
  onDirty,
  onCommit,
}: {
  seg: ReviewSegment;
  indent: boolean;
  showOriginal: boolean;
  editing: boolean;
  sourceLang?: string;
  targetLang: string;
  onDirty: (i: number, read: () => EditedNode[]) => void;
  onCommit: () => void;
}) {
  const translated = seg.outHtml !== null;
  const html = seg.outHtml ?? seg.srcHtml;
  const heading = seg.role === "heading";
  const big = heading && (seg.level ?? 2) <= 2;

  const shape = heading
    ? big
      ? "serif text-center text-[1.75rem] sm:text-[2rem] leading-[1.18] tracking-[-0.015em] mt-6 mb-10 text-balance"
      : "text-center text-[1.2rem] italic leading-snug mt-10 mb-5"
    : seg.role === "quote"
      ? "ml-5 sm:ml-8 text-[0.94em] leading-[1.6] my-3 text-ink-2"
      : seg.role === "list"
        ? "pl-5 -indent-4 my-1.5 before:content-['•'] before:mr-2.5 before:text-muted"
        : seg.role === "caption" || seg.role === "cell"
          ? "text-[0.9em] my-2 text-ink-2"
          : seg.center
            ? "text-center my-2"
            : indent
              ? "indent-[1.5em]"
              : "";

  const state = !translated ? "text-muted" : "";
  const editShape = editing
    ? "rounded-[3px] outline-none transition-colors -mx-2 px-2 hover:bg-paper-2 focus:bg-paper-2 focus:shadow-[inset_2px_0_0_var(--accent)] cursor-text"
    : "";

  const text = (
    <EditableText
      as={heading ? (big ? "h2" : "h3") : "p"}
      html={html}
      editable={editing}
      lang={translated ? targetLang : sourceLang}
      className={`${shape} ${state} ${editShape} ${seg.edited && !editing ? "relative before:absolute before:top-[0.55em] before:-left-4 before:h-1.5 before:w-1.5 before:rounded-full before:bg-accent/70 sm:before:-left-5" : ""}`}
      onDirty={(read) => onDirty(seg.i, read)}
      onCommit={onCommit}
    />
  );

  if (!showOriginal) return text;

  return (
    <div className="group/row my-3 grid gap-x-10 gap-y-1.5 border-l border-rule pl-3 lg:my-0 lg:grid-cols-2 lg:border-0 lg:py-1.5 lg:pl-0">
      <div
        className={`original-text ${heading ? "text-center italic" : ""} lg:order-first`}
        lang={sourceLang}
        dangerouslySetInnerHTML={{ __html: seg.srcHtml }}
      />
      <div>{text}</div>
    </div>
  );
}
