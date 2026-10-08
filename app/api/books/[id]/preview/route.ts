import { fail, json, loadBook } from "@/lib/api";
import { store } from "@/lib/storage";
import { renderSafeHtml } from "@/lib/markup";

/** Trecho da prévia grátis: original e tradução, lado a lado (HTML seguro). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const meta = await loadBook((await params).id);
  if (!meta) return fail("Livro não encontrado.", 404);
  const p = meta.preview;
  if (!p) return json({ preview: null, pairs: [] });
  const content = await store.readDoc(meta.id, p.docId);
  const chapter = meta.chapters.find((c) => c.id === p.chapterId);
  const pairs = content.segments.slice(p.start, p.end).map((s) => ({
    i: s.i,
    role: s.role,
    src: renderSafeHtml(s.src, content.tags),
    out: s.out !== undefined ? renderSafeHtml(s.out, content.tags) : null,
  }));
  return json({ preview: p, chapterTitle: chapter?.title ?? "", pairs });
}
