import { connection } from "next/server";
import type { Metadata } from "next";
import { PUBLIC_MODE } from "@/lib/mode";
import { PublicLibrary } from "@/components/public/loaders";
import { LibraryPageView } from "@/components/library/library-page-view";

export const metadata: Metadata = { title: "Meus livros" };

export default async function LibraryPage() {
  if (PUBLIC_MODE) return <PublicLibrary />;
  await connection();
  const { store } = await import("@/lib/storage");
  const { summaryOf } = await import("@/lib/api");
  const { jobRunner } = await import("@/services/processing/job-runner");
  await jobRunner.init();
  const { cookies } = await import("next/headers");
  const { visibleTo, OWNER_COOKIE } = await import("@/services/commerce/ownership");
  const { ADMIN_COOKIE } = await import("@/lib/auth");
  const jar = await cookies();
  // cada cliente vê só os livros deste navegador; o administrador vê todos
  const books = (await visibleTo(await store.list(), jar.get(OWNER_COOKIE)?.value, jar.get(ADMIN_COOKIE)?.value)).map(summaryOf);
  return <LibraryPageView books={books} />;
}
