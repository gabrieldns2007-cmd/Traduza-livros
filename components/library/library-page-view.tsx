import type { BookSummary } from "@/types/book";
import { Library } from "./library";
import type { UploadConfig } from "./new-book";

/** Página “Meus livros” (usada pelo servidor e pela versão pública, que não passa `upload`). */
export function LibraryPageView({ books, upload }: { books: BookSummary[]; upload?: UploadConfig }) {
  return (
    <main className="mx-auto w-full max-w-[60rem] px-5 pt-7 pb-24 sm:px-8 sm:pt-14">
      <Library initial={books} upload={upload} />
    </main>
  );
}
