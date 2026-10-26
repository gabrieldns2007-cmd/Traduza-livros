/**
 * Qual serviço de IA traduz cada tipo de tradução — decisão interna, o cliente
 * nunca escolhe nem vê. A ordem vem do painel administrativo.
 *
 * Duas modalidades que nunca se misturam:
 *  - Grátis (id "padrao"): só serviços de nível gratuito de verdade, em rodízio
 *    automático — se a cota de um acabou ou ele está com falhas, passa para o
 *    próximo; se todos estão fora, espera e continua sozinha. Nunca cai num pago;
 *  - Literária: só os serviços pagos da lista dela (ex.: Anthropic), cobertos
 *    pelo preço do pedido. Nunca usa um gratuito.
 */
import { providerConfigs, type ProviderConfig } from "@/lib/config";
import type { Settings } from "@/lib/storage";
import { isFreeProvider, quotaFor } from "@/services/quota/usage";
import { blockedUntil } from "@/services/providers/health";

export type LevelId = "padrao" | "literaria";

/** "free": só serviços gratuitos · "paid": só serviços pagos. */
export type Modality = "free" | "paid";

export const MODALITY: Record<LevelId, Modality> = { padrao: "free", literaria: "paid" };

export function modalityOf(level: LevelId): Modality {
  return MODALITY[level];
}

/** O serviço pertence a esta modalidade? (grátis: gratuito e nunca pago; paga: só pago) */
export function fitsModality(cfg: Pick<ProviderConfig, "free" | "paid">, modality: Modality): boolean {
  return modality === "free" ? cfg.free && !cfg.paid : cfg.paid;
}

export const DEFAULT_ROUTING: Record<LevelId, string[]> = {
  // o GitHub Models foi encerrado (30/07/2026); se ainda estiver numa lista salva, é pulado
  padrao: ["gemini", "groq", "cloudflare", "mistral"],
  literaria: ["anthropic"],
};

export function routingFor(level: LevelId, s: Settings): string[] {
  const list = s.routing?.[level];
  return list && list.length ? list : DEFAULT_ROUTING[level];
}

export type Route =
  /** `preferred`: escolhido só por ser o `prefer` (não é o primeiro da lista que está pronto agora) */
  { ok: true; provider: ProviderConfig; preferred?: boolean } | { ok: false; retryAt?: number; reason: "no_provider" | "quota" | "not_offered" };

/**
 * Escolhe o serviço para um tipo de tradução: só os da modalidade dele, pulando
 * os excluídos, os sem cota e os com o disjuntor aberto (falhas recentes).
 * `prefer`: quem começou o próximo capítulo pela metade (mesma voz até o fim
 * do capítulo), se puder ser usado agora. Sem nenhum, devolve a hora mais
 * cedo em que um deles volta (cota ou disjuntor) — contando também os
 * excluídos para o livro, que voltam a valer quando o bloqueio deles acaba.
 */
export async function routeProvider(level: LevelId, s: Settings, exclude: Set<string> = new Set(), prefer?: string): Promise<Route> {
  if (level === "literaria" && !s.offerLiteraria) return { ok: false, reason: "not_offered" };
  const modality = modalityOf(level);
  const configs = providerConfigs(s);
  let retryAt: number | undefined;
  let sawWait = false;
  const usable: ProviderConfig[] = [];
  const wait = (t: number) => {
    sawWait = true;
    retryAt = retryAt === undefined ? t : Math.min(retryAt, t);
  };
  for (const id of routingFor(level, s)) {
    const cfg = configs.find((c) => c.id === id);
    if (!cfg?.available || cfg.retired || cfg.billing === "none") continue;
    // a Grátis nunca usa um pago; a Literária nunca usa um gratuito
    if (!fitsModality(cfg, modality)) continue;
    if (isFreeProvider(id)) {
      const q = await quotaFor(id, cfg.model);
      if (q.exhaustedUntil) {
        wait(Date.parse(q.exhaustedUntil));
        continue;
      }
    }
    const blocked = await blockedUntil(id, cfg.model);
    if (blocked) {
      wait(blocked);
      continue;
    }
    // falhou de vez para este livro (sem bloqueio anotado para todos): fica de fora até o próximo start()
    if (exclude.has(id)) continue;
    usable.push(cfg);
  }
  const chosen = usable.find((c) => c.id === prefer) ?? usable[0];
  if (chosen) return { ok: true, provider: chosen, ...(chosen !== usable[0] ? { preferred: true } : {}) };
  return { ok: false, retryAt, reason: sawWait ? "quota" : "no_provider" };
}

/** Tipos de tradução que podem ser vendidos agora (há algum serviço da modalidade configurado). */
export function levelOffered(level: LevelId, s: Settings): boolean {
  if (level === "literaria" && !s.offerLiteraria) return false;
  const configs = providerConfigs(s);
  return routingFor(level, s).some((id) => {
    const c = configs.find((x) => x.id === id);
    return Boolean(c?.available && !c.retired && c.billing !== "none" && fitsModality(c, modalityOf(level)));
  });
}

/** Ids que não cabem na modalidade do tipo (o painel não pode salvar uma lista assim). */
export function foreignIds(level: LevelId, ids: string[], s?: Settings): string[] {
  const configs = providerConfigs(s);
  return ids.filter((id) => {
    const c = configs.find((x) => x.id === id);
    // id desconhecido aqui (ex.: um serviço só do servidor próprio na versão pública): fica de fora sem erro
    return c && !c.retired && !fitsModality(c, modalityOf(level));
  });
}
