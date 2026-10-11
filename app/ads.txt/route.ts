import { PUBLIC_MODE } from "@/lib/mode";
import { readSettings } from "@/lib/storage";
import { adsTxt } from "@/lib/ads";

/**
 * /ads.txt: diz ao Google que o código do editor salvo no painel pode vender
 * anúncios neste site. Existe assim que o código é salvo — mesmo com os
 * anúncios desligados, para o Google poder aprovar o site antes.
 */
export async function GET() {
  const body = PUBLIC_MODE ? null : adsTxt((await readSettings()).ads);
  if (!body) return new Response("Não encontrado.\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" } });
}
