"use client";

import type { CSSProperties } from "react";
import Link from "next/link";
import type { BookSummary } from "@/types/book";
import { Check, Plus } from "@/components/ui/icons";
import { BookObject, WireBook } from "./book-object";
import { bookAria, shelfStatus, type Binding } from "./book-look";
import s from "./bookshelf.module.css";

/** Para o iOS mostrar o :active no toque (sem isso ele só reage ao soltar). */
const noop = () => {};

/**
 * A estante: livros de pé, capa para a frente, em prateleiras. Quantos cabem
 * por prateleira é decidido só pelo CSS. Cada lugar (livro + etiqueta) é um
 * único botão que tira o livro da estante.
 */
export function Bookshelf({
  books,
  bindings,
  openId,
  panelId,
  onOpen,
}: {
  books: BookSummary[];
  bindings: Map<string, Binding>;
  openId: string | null;
  panelId: string;
  onOpen: (id: string) => void;
}) {
  return (
    <div className={s.case}>
      <ul className={s.grid}>
        {books.map((book, i) => {
          const pulled = openId === book.id;
          return (
            <li
              key={book.id}
              className={s.slot}
              data-slot={book.id}
              data-pulled={pulled ? "" : undefined}
              style={{ "--i": Math.min(i, 12) } as CSSProperties}
            >
              <button
                type="button"
                className={s.bookBtn}
                aria-label={bookAria(book)}
                aria-haspopup="dialog"
                aria-expanded={pulled}
                aria-controls={pulled ? panelId : undefined}
                onClick={() => onOpen(book.id)}
                onTouchStart={noop}
              >
                <span className={s.stand}>
                  <span className={s.contact} aria-hidden />
                  <span className={s.lift}>
                    <BookObject book={book} binding={bindings.get(book.id)!} variant="shelf" eager={i < 5} priority={i < 3} />
                  </span>
                </span>
                <ShelfTag book={book} />
              </button>
            </li>
          );
        })}
        <li className={`${s.slot} ${s.ghostSlot}`} style={{ "--i": Math.min(books.length, 12) } as CSSProperties}>
          <Link href="/" className={s.ghostLink} tabIndex={-1} aria-hidden onTouchStart={noop}>
            <span className={s.stand}>
              <span className={s.ghostBook}>
                <span className={s.ghostIcon}>
                  <Plus />
                </span>
                Novo livro
              </span>
            </span>
            <span className={s.tag} />
          </Link>
        </li>
      </ul>
    </div>
  );
}

/** Etiqueta curta da situação, abaixo da tábua (nunca encosta na do vizinho). */
function ShelfTag({ book }: { book: BookSummary }) {
  const st = shelfStatus(book);
  const color = { live: "text-ink", calm: "text-ink-2", alert: "text-accent", quiet: "text-muted", done: "text-ink-2" }[st.tone];
  return (
    <span className={s.tag} aria-hidden>
      <span className={`${s.tagText} ${color}`}>
        {st.pulse && <span className={`${s.tagDot} pulse-dot`} />}
        {st.tone === "done" && <Check className="h-3.5 w-3.5 flex-none text-ok" />}
        <span>{st.text}</span>
      </span>
      {st.meter && (
        <span className={s.tagMeter}>
          <span className={s.tagBar}>
            <span style={{ transform: `scaleX(${Math.max(0.02, st.percent / 100)})`, opacity: st.tone === "live" ? 1 : 0.5 }} />
          </span>
          <span className={`${s.tagPct} num`}>{st.percent}%</span>
        </span>
      )}
    </span>
  );
}

/** Estante vazia: o primeiro livro, desenhado em linhas, já tem lugar. */
export function EmptyShelf() {
  return (
    <div className={s.case}>
      <ul className={s.grid}>
        <li className={s.slot} aria-hidden>
          <span className={s.bookBtn}>
            <span className={s.stand}>
              <span className={s.contact} />
              <span className={s.lift}>
                <WireBook />
              </span>
            </span>
            <span className={s.tag} />
          </span>
        </li>
        <li className={s.emptyNote}>
          <p className="serif text-[1.375rem] leading-[1.2] tracking-[-0.01em] text-balance text-ink italic">Seu primeiro livro fica aqui.</p>
        </li>
      </ul>
    </div>
  );
}
