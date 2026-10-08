import { z } from "zod";
import { randomId as randomUUID } from "@/utils/id";
import { fail, json, loadBook } from "@/lib/api";
import { store } from "@/lib/storage";
import { normalizeTerm } from "@/services/glossary/glossary";

type Ctx = { params: Promise<{ id: string }> };
const Type = z.enum(["character", "place", "organization", "term", "other"]);

export async function GET(_req: Request, { params }: Ctx) {
  const id = (await params).id;
  if (!(await loadBook(id))) return fail("Livro não encontrado.", 404);
  return json({ entries: await store.readGlossary(id) });
}

const Create = z.object({
  term: z.string().trim().min(1).max(120),
  translation: z.string().trim().min(1).max(200),
  type: Type.default("term"),
  note: z.string().trim().max(300).optional(),
});

export async function POST(request: Request, { params }: Ctx) {
  const id = (await params).id;
  if (!(await loadBook(id))) return fail("Livro não encontrado.", 404);
  const parsed = Create.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("Preencha o termo e a tradução.");
  const entries = await store.updateGlossary(id, (list) => {
    const key = normalizeTerm(parsed.data.term);
    const existing = list.find((e) => normalizeTerm(e.term) === key);
    if (existing) Object.assign(existing, parsed.data, { origin: "user" });
    else list.unshift({ id: randomUUID().slice(0, 8), ...parsed.data, note: parsed.data.note || undefined, origin: "user" });
    return list;
  });
  return json({ entries });
}

const Update = z.object({
  id: z.string().max(40),
  term: z.string().trim().min(1).max(120).optional(),
  translation: z.string().trim().min(1).max(200).optional(),
  type: Type.optional(),
  note: z.string().trim().max(300).optional(),
});

export async function PATCH(request: Request, { params }: Ctx) {
  const id = (await params).id;
  if (!(await loadBook(id))) return fail("Livro não encontrado.", 404);
  const parsed = Update.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("Dados inválidos.");
  const { id: entryId, ...changes } = parsed.data;
  const entries = await store.updateGlossary(id, (list) => {
    const e = list.find((x) => x.id === entryId);
    if (e) Object.assign(e, changes, { origin: "user" });
    return list;
  });
  return json({ entries });
}

export async function DELETE(request: Request, { params }: Ctx) {
  const id = (await params).id;
  if (!(await loadBook(id))) return fail("Livro não encontrado.", 404);
  const entryId = new URL(request.url).searchParams.get("entry");
  const entries = await store.updateGlossary(id, (list) => {
    const idx = list.findIndex((x) => x.id === entryId);
    if (idx >= 0) list.splice(idx, 1);
    return list;
  });
  return json({ entries });
}
