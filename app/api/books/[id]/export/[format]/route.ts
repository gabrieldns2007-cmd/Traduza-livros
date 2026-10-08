import { fail, loadBook } from "@/lib/api";
import { store } from "@/lib/storage";
import { slugify } from "@/utils/text";
import { shortHash } from "@/utils/hash";
import { buildTranslatedEpub } from "@/services/export/epub-export";
import { buildTranslatedPdf, PdfExportError } from "@/services/export/pdf-export";

type Ctx = { params: Promise<{ id: string; format: string }> };

export const maxDuration = 300;

export async function GET(_req: Request, { params }: Ctx) {
  const { id, format } = await params;
  if (format !== "epub" && format !== "pdf") return fail("Formato desconhecido.", 404);
  const meta = await loadBook(id);
  if (!meta) return fail("Livro não encontrado.", 404);

  const version = shortHash(`${meta.updatedAt}|${meta.contentVersion}|${meta.translatedTitle ?? ""}`);
  const cacheName = `exports/${format}-${version}.${format}`;

  let data: Uint8Array;
  if (await store.exists(id, cacheName)) {
    data = new Uint8Array(await store.readFile(id, cacheName));
  } else {
    try {
      data = format === "epub" ? await buildTranslatedEpub(meta) : await buildTranslatedPdf(meta);
    } catch (err) {
      if (err instanceof PdfExportError) return fail(err.message, 422);
      console.error(`[export] falha ao gerar ${format}`, err);
      return fail("Não foi possível gerar o arquivo. Tente novamente.", 500);
    }
    await store.clearExports(id);
    await store.writeFile(id, cacheName, data);
  }

  const title = meta.translatedTitle || meta.title;
  const ascii = `${slugify(title)}-${meta.targetLanguage}.${format}`;
  const pretty = `${title.replace(/[\\/:*?"<>|]+/g, " ").trim()} (${meta.targetLanguage}).${format}`;
  return new Response(new Blob([data as BlobPart]), {
    headers: {
      "content-type": format === "epub" ? "application/epub+zip" : "application/pdf",
      "content-length": String(data.byteLength),
      "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(pretty)}`,
      "cache-control": "no-store",
    },
  });
}
