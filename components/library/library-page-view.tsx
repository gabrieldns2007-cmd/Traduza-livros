import type { BookSummary } from "@/types/book";
import { Library } from "./library";

/** Página “Meus livros” (usada pelo servidor e pela versão pública). */
export function LibraryPageView({ books }: { books: BookSummary[] }) {
  return (
    <main className="mx-auto w-full max-w-[60rem] px-5 pt-7 pb-24 sm:px-8 sm:pt-14">
      <Library initial={books} />
    </main>
  );
}
