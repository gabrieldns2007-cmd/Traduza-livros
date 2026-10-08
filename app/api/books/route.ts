import { config } from "@/lib/config";
import { fail, json, summaryOf } from "@/lib/api";
import { store, readSettings } from "@/lib/storage";
import { findLanguage } from "@/lib/languages";
import { importBook, ImportError } from "@/services/parsing/import-book";
import { jobRunner } from "@/services/processing/job-runner";

export async function GET() {
  await jobRunner.init();
  const books = await store.list();
  return json({ books: books.map(summaryOf) });
}

/** Envio de um livro (multipart: file, targetLanguage?, sourceLanguage?). */
export async function POST(request: Request) {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > config.maxUploadBytes + 1024 * 1024) {
    return fail(`O arquivo é maior que o limite de ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB.`, 413);
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail("Não foi possível ler o envio. Tente novamente.");
  }
  const file = form.get("file");
  if (!(file instanceof File)) return fail("Nenhum arquivo enviado.");
  if (file.size === 0) return fail("O arquivo está vazio.");
  if (file.size > config.maxUploadBytes) {
    return fail(`O arquivo é maior que o limite de ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB.`, 413);
  }
  if (!/\.(epub|pdf)$/i.test(file.name)) return fail("Envie um arquivo .epub ou .pdf.");

  const settings = await readSettings();
  const target = findLanguage(String(form.get("targetLanguage") ?? ""))?.code ?? settings.targetLanguage;
  const sourceRaw = String(form.get("sourceLanguage") ?? "");
  const source = sourceRaw && sourceRaw !== "auto" ? (findLanguage(sourceRaw)?.code ?? null) : null;

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const meta = await importBook(bytes, { fileName: file.name.slice(0, 200), targetLanguage: target, sourceLanguage: source });
    await store.update(meta.id, (m) => {
      m.options = { dialogueStyle: settings.dialogueStyle, deepContext: settings.deepContext, instructions: settings.instructions || undefined };
    });
    return json({ book: summaryOf((await store.get(meta.id))!) }, 201);
  } catch (err) {
    if (err instanceof ImportError) return fail(err.message, 422);
    console.error("[upload] falha ao importar", err);
    return fail("Não conseguimos ler este livro. O arquivo pode estar corrompido ou protegido por DRM.", 422);
  }
}
