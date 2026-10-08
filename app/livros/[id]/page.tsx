import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { Metadata } from "next";
import { loadBook, viewOf } from "@/lib/api";
import { store } from "@/lib/storage";
import { BookScreen } from "@/components/book/book-screen";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const meta = await loadBook((await params).id);
  return { title: meta ? meta.translatedTitle || meta.title : "Livro" };
}

export default async function BookPage({ params }: Props) {
  await connection();
  const { id } = await params;
  const meta = await loadBook(id);
  if (!meta) notFound();
  const glossary = await store.readGlossary(id);
  return <BookScreen initial={viewOf(meta)} initialGlossary={glossary} />;
}
