import type { BookSummary } from "@/types/book";
import { Library } from "./library";
import type { UploadConfig } from "./new-book";
import type { AdConfig } from "@/lib/ads";
import { AdSlot } from "@/components/ads/ad-slot";

/** Página “Meus livros” (usada pelo servidor e pela versão pública, que não passa `upload` nem `ad`). */
export function LibraryPageView({ books, upload, ad }: { books: BookSummary[]; upload?: UploadConfig; ad?: AdConfig | null }) {
  return (
    <main className="mx-auto w-full max-w-[60rem] px-5 pt-7 pb-24 sm:px-8 sm:pt-14">
      <Library initial={books} upload={upload} />
      <AdSlot ad={ad} placement="livros" className="mx-auto mt-14 max-w-[44rem]" />
    </main>
  );
}
