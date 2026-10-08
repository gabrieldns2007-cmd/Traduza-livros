/**
 * “Créditos grátis de hoje”: quanto já foi usado de cada serviço gratuito e
 * quando a cota volta. Não envolve dinheiro — só ajuda a escolher o serviço.
 *
 * Os limites oficiais mudam e nem sempre são publicados; quando o serviço
 * informa o restante (cabeçalhos de limite), usamos o número dele; senão,
 * uma estimativa marcada como aproximada.
 */
import path from "node:path";
import { config, FREE_PROVIDERS, type FreeProviderId } from "@/lib/config";
import { readJson, writeAtomic } from "@/lib/storage";
import { KeyedMutex } from "@/utils/async";
import { nextPacificMidnight } from "@/services/translation/llm/gemini";

interface ProviderUsage {
  /** dia da contagem (no fuso em que o serviço zera a cota) */
  day: string;
  requests: number;
  tokens: number;
  /** cota esgotada até este instante (ms) */
  exhaustedUntil?: number;
  /** restante/limite informados pelo próprio serviço, quando houver */
  reported?: { remaining: number; limit: number; at: number };
}

/** chave: “serviço|modelo” — cada modelo tem a sua própria cota gratuita */
type UsageFile = Record<string, ProviderUsage>;
const keyOf = (provider: FreeProviderId, model: string) => `${provider}|${model}`;

/** Estimativas de pedidos por dia no nível gratuito (fontes não oficiais; podem mudar). */
const ESTIMATED_DAILY: Record<string, number> = {
  "gemini-3.8-flash": 20,
  "openai/gpt-4.1": 50,
  "openai/gpt-4.1-mini": 150,
};

const mutex = new KeyedMutex();
const file = () => path.join(config.dataDir, "usage.json");

function dayOf(provider: FreeProviderId, now = Date.now()): string {
  // Gemini zera à meia-noite do Pacífico; os outros contam em janelas de 24 h (usamos o dia UTC)
  const tz = provider === "gemini" ? "America/Los_Angeles" : "UTC";
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
}

function fresh(provider: FreeProviderId, u: ProviderUsage | undefined, now = Date.now()): ProviderUsage {
  const day = dayOf(provider, now);
  if (!u || u.day !== day)
    return { day, requests: 0, tokens: 0, exhaustedUntil: u?.exhaustedUntil && u.exhaustedUntil > now ? u.exhaustedUntil : undefined };
  if (u.exhaustedUntil && u.exhaustedUntil <= now) return { ...u, exhaustedUntil: undefined };
  return u;
}

async function update(provider: FreeProviderId, model: string, fn: (u: ProviderUsage) => void) {
  await mutex.run("usage", async () => {
    const all = (await readJson<UsageFile>(file())) ?? {};
    const u = fresh(provider, all[keyOf(provider, model)]);
    fn(u);
    all[keyOf(provider, model)] = u;
    await writeAtomic(file(), JSON.stringify(all, null, 1));
  });
}

export function isFreeProvider(id: string): id is FreeProviderId {
  return (FREE_PROVIDERS as readonly string[]).includes(id);
}

export async function recordRequest(
  provider: FreeProviderId,
  model: string,
  usage: { inputTokens: number; outputTokens: number },
  reported?: { remaining: number; limit: number },
) {
  await update(provider, model, (u) => {
    u.requests++;
    u.tokens += usage.inputTokens + usage.outputTokens;
    if (reported) u.reported = { ...reported, at: Date.now() };
  });
}

export async function recordExhausted(provider: FreeProviderId, model: string, retryAt?: number) {
  const until = retryAt ?? (provider === "gemini" ? nextPacificMidnight() : Date.now() + 60 * 60 * 1000);
  await update(provider, model, (u) => {
    u.exhaustedUntil = until;
  });
}

export interface QuotaView {
  /** pedidos feitos hoje por este app */
  used: number;
  /** pedidos restantes (do serviço, ou estimados); null quando não dá para saber */
  remaining: number | null;
  limit: number | null;
  /** o número vem de uma estimativa, não do serviço */
  approximate: boolean;
  /** esgotado até (ISO), se a cota acabou */
  exhaustedUntil: string | null;
}

export async function quotaFor(provider: FreeProviderId, model: string): Promise<QuotaView> {
  const all = (await readJson<UsageFile>(file())) ?? {};
  const u = fresh(provider, all[keyOf(provider, model)]);
  const exhaustedUntil = u.exhaustedUntil ? new Date(u.exhaustedUntil).toISOString() : null;
  // número informado pelo serviço há pouco tempo vale mais que a estimativa
  if (u.reported && Date.now() - u.reported.at < 6 * 3600 * 1000) {
    return { used: u.requests, remaining: exhaustedUntil ? 0 : u.reported.remaining, limit: u.reported.limit, approximate: false, exhaustedUntil };
  }
  const limit = ESTIMATED_DAILY[model] ?? null;
  return {
    used: u.requests,
    remaining: exhaustedUntil ? 0 : limit === null ? null : Math.max(0, limit - u.requests),
    limit,
    approximate: true,
    exhaustedUntil,
  };
}

export async function allQuotas(models: Partial<Record<FreeProviderId, string>>): Promise<Partial<Record<FreeProviderId, QuotaView>>> {
  const out: Partial<Record<FreeProviderId, QuotaView>> = {};
  for (const id of FREE_PROVIDERS) if (models[id]) out[id] = await quotaFor(id, models[id]!);
  return out;
}
