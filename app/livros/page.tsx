import { connection } from "next/server";
import Link from "next/link";
import type { Metadata } from "next";
import { store } from "@/lib/storage";
import { summaryOf } from "@/lib/api";
import { jobRunner } from "@/services/processing/job-runner";
import { Library } from "@/components/library/library";
import { LinkPending } from "@/components/ui/pending";

export const metadata: Metadata = { title: "Meus livros" };

export default async function LibraryPage() {
  await connection();
  await jobRunner.init();
  const books = (await store.list()).map(summaryOf);
  return (
    <main className="mx-auto w-full max-w-[48rem] px-5 pt-8 pb-24 sm:px-8 sm:pt-14">
      <header className="rise flex items-end justify-between gap-4">
        <div>
          <h1 className="serif text-[2.6rem] leading-none font-[380] tracking-[-0.035em] text-ink sm:text-[3.4rem]">Meus livros</h1>
          <p className="num mt-3 text-[0.9375rem] text-muted">
            {books.length === 0 ? "Sua estante está vazia." : books.length === 1 ? "Um livro na estante." : `${books.length} livros na estante.`}
          </p>
        </div>
        {books.length > 0 && (
          <Link href="/" className="link mb-1 inline-flex shrink-0 items-center gap-1.5 py-1 text-[0.875rem] text-ink-2 hover:text-ink">
            Novo livro
            <LinkPending />
          </Link>
        )}
      </header>
      <Library initial={books} />
    </main>
  );
}
