import type JSZip from "jszip";
import { fail, loadBook } from "@/lib/api";
import { store } from "@/lib/storage";
import { findZipFile, openZip } from "@/services/parsing/epub-package";

type Ctx = { params: Promise<{ id: string; path: string[] }> };

const TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

// cache pequeno de pacotes abertos (capas na lista de livros, imagens na revisão)
const g = globalThis as unknown as { __versoZips?: Map<string, Promise<JSZip>> };
const zips = (g.__versoZips ??= new Map());

async function zipFor(id: string) {
  let z = zips.get(id);
  if (!z) {
    z = store.readFile(id, "source.epub").then((b) => openZip(new Uint8Array(b)));
    zips.set(id, z);
    if (zips.size > 4) zips.delete(zips.keys().next().value!);
    z.catch(() => zips.delete(id));
  }
  return z;
}

/** Serve apenas imagens de dentro do EPUB, com cabeçalhos que impedem execução de conteúdo. */
export async function GET(_req: Request, { params }: Ctx) {
  const { id, path } = await params;
  const meta = await loadBook(id);
  if (!meta) return fail("Livro não encontrado.", 404);
  const filePath = path.map((p) => decodeURIComponent(p)).join("/");
  if (filePath.includes("..")) return fail("Caminho inválido.", 400);
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const type = TYPES[ext];
  if (!type) return fail("Tipo de arquivo não permitido.", 415);
  const zip = await zipFor(id);
  const file = findZipFile(zip, filePath);
  if (!file) return fail("Imagem não encontrada.", 404);
  const data = await file.async("uint8array");
  return new Response(new Blob([data as BlobPart]), {
    headers: {
      "content-type": type,
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
    },
  });
}
