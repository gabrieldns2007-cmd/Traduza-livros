import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import type { Metadata } from "next";
import { loadBook } from "@/lib/api";
import { store } from "@/lib/storage";
import { reviewChapter } from "@/lib/review";
import { isActive } from "@/lib/format";
import { Reader } from "@/components/review/reader";
import { PUBLIC_MODE } from "@/lib/mode";
import { PublicReview } from "@/components/public/loaders";

type Props = { params: Promise<{ id: string; n: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  if (PUBLIC_MODE) return { title: "Revisar" };
  const meta = await loadBook((await params).id);
  return { title: meta ? `Revisar · ${meta.translatedTitle || meta.title}` : "Revisar" };
}

export default async function ReviewPage({ params }: Props) {
  const { id, n } = await params;
  if (PUBLIC_MODE) return <PublicReview id={id} n={n} />;
  await connection();
  const meta = await loadBook(id);
  if (!meta) notFound();
  const index = Number(n) - 1;
  if (!Number.isInteger(index) || index < 0) redirect(`/livros/${id}/revisar/1`);
  if (index >= meta.chapters.length) redirect(`/livros/${id}/revisar/${meta.chapters.length}`);
  const chapter = meta.chapters[index];
  const content = await store.readDoc(id, chapter.docId);

  return (
    <Reader
      bookId={id}
      bookTitle={meta.translatedTitle || meta.title}
      targetLanguage={meta.targetLanguage}
      sourceLanguage={meta.sourceLanguage ?? meta.detectedLanguage ?? null}
      chapters={meta.chapters.map((c) => ({
        id: c.id,
        title: c.title,
        translatedTitle: c.translatedTitle,
        done: c.status === "done",
        started: c.translatedSegments > 0,
      }))}
      index={index}
      chapter={reviewChapter(meta, chapter, content)}
      translating={isActive(meta.status)}
    />
  );
}
