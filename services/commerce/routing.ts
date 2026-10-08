/**
 * Qual serviço de IA traduz cada tipo de tradução — decisão interna, o cliente
 * nunca escolhe nem vê. A ordem vem do painel administrativo.
 *
 * Regras de custo (as mesmas de sempre):
 *  - serviços gratuitos (chave do dono, nível grátis) são usados em ordem; se a
 *    cota de um acabou, passa para o próximo gratuito;
 *  - um serviço pago só entra se o administrador o colocou na lista daquele tipo
 *    (ex.: Literária → Anthropic) — e o preço do pedido cobre esse custo;
 *  - nunca há troca de um gratuito para um pago que não esteja na lista.
 */
import { providerConfigs, type ProviderConfig } from "@/lib/config";
import type { Settings } from "@/lib/storage";
import { isFreeProvider, quotaFor } from "@/services/quota/usage";

export type LevelId = "padrao" | "literaria";

export const DEFAULT_ROUTING: Record<LevelId, string[]> = {
  padrao: ["gemini", "github", "groq"],
  literaria: ["anthropic"],
};

export function routingFor(level: LevelId, s: Settings): string[] {
  const list = s.routing?.[level];
  return list && list.length ? list : DEFAULT_ROUTING[level];
}

export type Route = { ok: true; provider: ProviderConfig } | { ok: false; retryAt?: number; reason: "no_provider" | "quota" | "not_offered" };

/** Escolhe o serviço para um tipo de tradução, pulando os excluídos e os sem cota. */
export async function routeProvider(level: LevelId, s: Settings, exclude: Set<string> = new Set()): Promise<Route> {
  if (level === "literaria" && !s.offerLiteraria) return { ok: false, reason: "not_offered" };
  const configs = providerConfigs(s);
  let retryAt: number | undefined;
  let sawQuota = false;
  for (const id of routingFor(level, s)) {
    if (exclude.has(id)) continue;
    const cfg = configs.find((c) => c.id === id);
    if (!cfg?.available || cfg.billing === "none") continue;
    if (isFreeProvider(id)) {
      const q = await quotaFor(id, cfg.model);
      if (q.exhaustedUntil) {
        sawQuota = true;
        const t = Date.parse(q.exhaustedUntil);
        retryAt = retryAt === undefined ? t : Math.min(retryAt, t);
        continue;
      }
    }
    return { ok: true, provider: cfg };
  }
  return { ok: false, retryAt, reason: sawQuota ? "quota" : "no_provider" };
}

/** Tipos de tradução que podem ser vendidos agora (há algum serviço configurado para eles). */
export function levelOffered(level: LevelId, s: Settings): boolean {
  if (level === "literaria" && !s.offerLiteraria) return false;
  const configs = providerConfigs(s);
  return routingFor(level, s).some((id) => configs.find((c) => c.id === id)?.available);
}
