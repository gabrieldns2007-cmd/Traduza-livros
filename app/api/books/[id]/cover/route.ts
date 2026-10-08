import { fail, loadBook } from "@/lib/api";
import { assetUrl } from "@/lib/review";

/** Redireciona para a imagem de capa do EPUB (se houver). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const meta = await loadBook((await params).id);
  if (!meta?.cover) return fail("Sem capa.", 404);
  return Response.redirect(new URL(assetUrl(meta.id, meta.cover), request.url), 302);
}
