import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { Metadata } from "next";
import { loadBook, viewOf } from "@/lib/api";
import { store } from "@/lib/storage";
import { BookScreen } from "@/components/book/book-screen";
import { PUBLIC_MODE } from "@/lib/mode";
import { PublicBook } from "@/components/public/loaders";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  if (PUBLIC_MODE) return { title: "Livro" };
  const meta = await loadBook((await params).id);
  return { title: meta ? meta.translatedTitle || meta.title : "Livro" };
}

export default async function BookPage({ params }: Props) {
  const { id } = await params;
  if (PUBLIC_MODE) return <PublicBook id={id} />;
  await connection();
  const meta = await loadBook(id);
  if (!meta) notFound();
  const glossary = await store.readGlossary(id);
  return <BookScreen initial={viewOf(meta)} initialGlossary={glossary} />;
}
