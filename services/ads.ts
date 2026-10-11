/**
 * Qual anúncio cada página mostra (só no servidor).
 *
 * As páginas recebem apenas o AdConfig já resolvido — nunca as configurações
 * inteiras, que também guardam as chaves dos serviços. Na versão pública não
 * há anúncios (nem painel para configurá-los).
 */
import { cookies } from "next/headers";
import { ADMIN_COOKIE } from "@/lib/auth";
import { PUBLIC_MODE } from "@/lib/mode";
import { readSettings } from "@/lib/storage";
import { resolveAd, type AdConfig, type AdPlacement } from "@/lib/ads";
import { adminProtected, isAdminToken } from "@/services/admin/access";

/**
 * O dono, logado no painel, não vê os anúncios do Google: clicar ou gerar
 * visualizações no próprio anúncio é proibido pelo AdSense. Sem senha do
 * painel não dá para saber quem é o dono — aí todos veem.
 */
async function isOwnerBrowser(): Promise<boolean> {
  if (!(await adminProtected())) return false;
  return isAdminToken((await cookies()).get(ADMIN_COOKIE)?.value);
}

/** Os anúncios de vários lugares de uma página, lendo as configurações uma vez só. */
export async function adsFor<P extends AdPlacement>(placements: readonly P[]): Promise<Record<P, AdConfig | null>> {
  const out = Object.fromEntries(placements.map((p) => [p, null])) as Record<P, AdConfig | null>;
  if (PUBLIC_MODE) return out;
  const ads = (await readSettings()).ads;
  let owner: boolean | undefined;
  for (const p of placements) {
    const ad = resolveAd(ads, p);
    if (ad?.kind === "adsense" && (owner ??= await isOwnerBrowser())) continue;
    out[p] = ad;
  }
  return out;
}

/** O anúncio de um lugar, ou null quando não deve aparecer nada. */
export async function adFor(placement: AdPlacement): Promise<AdConfig | null> {
  return (await adsFor([placement]))[placement];
}
