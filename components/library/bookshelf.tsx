"use client";

import type { CSSProperties } from "react";
import Link from "next/link";
import type { BookSummary } from "@/types/book";
import { Check } from "@/components/ui/icons";
import { BookObject, WireBook } from "./book-object";
import { bookAria, shelfStatus, type Binding } from "./book-look";
import type { NewBook } from "./new-book";
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
  newBook,
}: {
  books: BookSummary[];
  bindings: Map<string, Binding>;
  openId: string | null;
  panelId: string;
  onOpen: (id: string) => void;
  /** abre o seletor de arquivo (sem isso, o lugar livre leva à página inicial) */
  newBook: NewBook | null;
}) {
  const ghost = (
    <>
      <span className={s.stand}>
        <span className={s.lift}>
          <WireBook plus />
        </span>
      </span>
      <span className={s.tag}>
        <span className={`${s.tagText} num`}>
          <span>{newBook?.status || "Novo livro"}</span>
        </span>
      </span>
    </>
  );
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
        {/* lugar livre no fim da última prateleira: atalho para quem toca na estante (o botão acessível é o do cabeçalho) */}
        <li className={`${s.slot} ${s.ghostSlot}`} style={{ "--i": Math.min(books.length, 12) } as CSSProperties} aria-hidden role="presentation">
          {newBook ? (
            <button
              type="button"
              className={s.ghostLink}
              tabIndex={-1}
              onClick={newBook.pick}
              onTouchStart={noop}
              data-busy={newBook.progress !== null ? "" : undefined}
            >
              {ghost}
            </button>
          ) : (
            <Link href="/" className={s.ghostLink} tabIndex={-1} onTouchStart={noop}>
              {ghost}
            </Link>
          )}
        </li>
      </ul>
    </div>
  );
}

/** Etiqueta curta da situação, abaixo da tábua (nunca encosta na do vizinho). */
function ShelfTag({ book }: { book: BookSummary }) {
  const st = shelfStatus(book);
  const color = { live: "text-ink", calm: "text-ink-2", alert: "text-accent", quiet: "text-ink-2", done: "text-ink-2" }[st.tone];
  return (
    <span className={s.tag} aria-hidden>
      <span className={`${s.tagText} ${color}`}>
        {st.pulse && <span className={`${s.tagDot} pulse-dot`} />}
        {st.tone === "quiet" && <span className={s.tagRing} />}
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
