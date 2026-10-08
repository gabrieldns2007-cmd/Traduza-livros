import { z } from "zod";
import { fail, json, loadBook } from "@/lib/api";
import { store } from "@/lib/storage";
import { markupFromEdit, renderSafeHtml, type EditedNode } from "@/lib/markup";
import { reviewChapter } from "@/lib/review";
import { countWords } from "@/utils/text";
import { toPlainText } from "@/lib/markup";
import { jobRunner, recountProgress } from "@/services/processing/job-runner";

type Ctx = { params: Promise<{ id: string; chapterId: string }> };

async function load(params: Ctx["params"]) {
  const { id, chapterId } = await params;
  const meta = await loadBook(id);
  const chapter = meta?.chapters.find((c) => c.id === chapterId);
  return { id, meta, chapter };
}

export async function GET(_req: Request, { params }: Ctx) {
  const { id, meta, chapter } = await load(params);
  if (!meta || !chapter) return fail("Capítulo não encontrado.", 404);
  const content = await store.readDoc(id, chapter.docId);
  return json({ chapter: reviewChapter(meta, chapter, content) });
}

const Node: z.ZodType<EditedNode> = z.lazy(() =>
  z.object({
    x: z.string().max(20000).optional(),
    k: z.number().int().nonnegative().optional(),
    f: z.enum(["em", "strong"]).optional(),
    br: z.literal(true).optional(),
    c: z.array(Node).max(500).optional(),
  }),
);

const Patch = z.object({
  edits: z
    .array(z.object({ i: z.number().int().nonnegative(), nodes: z.array(Node).max(2000) }))
    .min(1)
    .max(200),
});

/** Salva edições manuais de parágrafos. */
export async function PATCH(request: Request, { params }: Ctx) {
  const { id, meta, chapter } = await load(params);
  if (!meta || !chapter) return fail("Capítulo não encontrado.", 404);
  const parsed = Patch.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("Edição inválida.");

  const saved = await store.updateDoc(id, chapter.docId, (content) => {
    const out: { i: number; outHtml: string }[] = [];
    for (const edit of parsed.data.edits) {
      if (edit.i < chapter.start || edit.i >= chapter.end) continue;
      const seg = content.segments[edit.i];
      if (!seg) continue;
      const markup = markupFromEdit(edit.nodes, content.tags);
      if (!toPlainText(markup).trim() && countWords(toPlainText(seg.src)) > 0) continue; // não aceita apagar tudo
      seg.out = markup;
      seg.edited = true;
      delete seg.failed;
      out.push({ i: seg.i, outHtml: renderSafeHtml(markup, content.tags) });
    }
    return out;
  });
  await store.update(id, (m) => {
    m.contentVersion++;
  });
  await recountProgress(id);
  await store.clearExports(id);
  return json({ saved });
}

/** Retraduz o capítulo (mantém os parágrafos editados à mão). */
export async function POST(request: Request, { params }: Ctx) {
  const { id, meta, chapter } = await load(params);
  if (!meta || !chapter) return fail("Capítulo não encontrado.", 404);
  const body = (await request.json().catch(() => ({}))) as { action?: string };
  if (body.action !== "retranslate") return fail("Ação desconhecida.");
  await store.updateDoc(id, chapter.docId, (content) => {
    for (const s of content.segments.slice(chapter.start, chapter.end)) {
      if (s.edited) continue;
      delete s.out;
      delete s.failed;
    }
  });
  await store.update(id, (m) => {
    const c = m.chapters.find((x) => x.id === chapter.id)!;
    c.status = "pending";
    if (m.status === "done" || m.status === "error") m.status = "paused";
  });
  await recountProgress(id);
  await store.clearExports(id);
  const fresh = (await store.get(id))!;
  if (fresh.status === "paused") await jobRunner.start(id);
  return json({ ok: true });
}
