import { z } from "zod";
import { fail, json, loadBook, viewOf } from "@/lib/api";
import { store } from "@/lib/storage";
import { findLanguage } from "@/lib/languages";
import { jobRunner } from "@/services/processing/job-runner";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const meta = await loadBook((await params).id);
  if (!meta) return fail("Livro não encontrado.", 404);
  return json({ book: viewOf(meta) });
}

const Patch = z.object({
  translatedTitle: z.string().trim().min(1).max(300).optional(),
  targetLanguage: z.string().max(20).optional(),
  sourceLanguage: z.string().max(20).nullable().optional(),
  options: z
    .object({
      instructions: z.string().max(4000).optional(),
      dialogueStyle: z.enum(["target", "source"]).optional(),
      deepContext: z.boolean().optional(),
    })
    .optional(),
});

export async function PATCH(request: Request, { params }: Ctx) {
  const id = (await params).id;
  const meta = await loadBook(id);
  if (!meta) return fail("Livro não encontrado.", 404);
  const parsed = Patch.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("Dados inválidos.");
  const body = parsed.data;
  const canChangeLanguages = meta.status === "ready" || meta.progress.translatedSegments === 0;
  const updated = await store.update(id, (m) => {
    if (body.translatedTitle) m.translatedTitle = body.translatedTitle;
    if (canChangeLanguages && body.targetLanguage) m.targetLanguage = findLanguage(body.targetLanguage)?.code ?? m.targetLanguage;
    if (canChangeLanguages && body.sourceLanguage !== undefined) {
      m.sourceLanguage = body.sourceLanguage && body.sourceLanguage !== "auto" ? (findLanguage(body.sourceLanguage)?.code ?? null) : null;
    }
    if (body.options) m.options = { ...m.options, ...body.options, instructions: body.options.instructions?.trim() || m.options.instructions };
  });
  if (body.translatedTitle) await store.clearExports(id);
  return json({ book: viewOf(updated) });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const id = (await params).id;
  const meta = await loadBook(id);
  if (!meta) return fail("Livro não encontrado.", 404);
  await jobRunner.stop(id);
  await store.remove(id);
  return json({ ok: true });
}
