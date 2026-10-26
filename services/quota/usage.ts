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
import { MAX_BLOCK_MS } from "@/services/providers/health";

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

/**
 * Chave: “serviço|modelo” — no Gemini e no Groq, cada modelo tem a sua própria cota
 * gratuita. Na Cloudflare (Neurons do dia) e na Mistral (cota do mês do modo Free), a
 * cota é da CONTA, para todos os modelos: a chave é só o serviço (trocar de modelo
 * não traz a cota de volta).
 */
type UsageFile = Record<string, ProviderUsage>;
const ACCOUNT_QUOTA: readonly FreeProviderId[] = ["cloudflare", "mistral"];
const keyOf = (provider: FreeProviderId, model: string) => (ACCOUNT_QUOTA.includes(provider) ? provider : `${provider}|${model}`);

/** A anotação deste serviço/modelo (lê também a chave antiga, “serviço|modelo”, das contas da Cloudflare e da Mistral). */
function entryOf(all: UsageFile, provider: FreeProviderId, model: string): ProviderUsage | undefined {
  return all[keyOf(provider, model)] ?? all[`${provider}|${model}`];
}

/** Estimativas de pedidos por dia no nível gratuito (fontes não oficiais; podem mudar). */
const ESTIMATED_DAILY: Record<string, number> = {
  "gemini-3.8-flash": 20,
};

const mutex = new KeyedMutex();
const file = () => path.join(config.dataDir, "usage.json");

/** Meia-noite UTC seguinte (a cota diária da Cloudflare volta nessa hora: 21h em Brasília). */
export function nextUtcMidnight(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** Dia 1º do mês seguinte, meia-noite UTC (a cota mensal do modo Free da Mistral). */
export function nextMonthUtc(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** Quando a cota volta, se o serviço não disse. */
function defaultCooldown(provider: FreeProviderId, now = Date.now()): number {
  if (provider === "gemini") return nextPacificMidnight(now);
  if (provider === "cloudflare") return nextUtcMidnight(now);
  if (provider === "mistral") return nextMonthUtc(now);
  return now + 60 * 60 * 1000;
}

function dayOf(provider: FreeProviderId, now = Date.now()): string {
  // Gemini zera à meia-noite do Pacífico; os outros contam em janelas de 24 h (usamos o dia UTC)
  const tz = provider === "gemini" ? "America/Los_Angeles" : "UTC";
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
}

function fresh(provider: FreeProviderId, u: ProviderUsage | undefined, now = Date.now()): ProviderUsage {
  const day = dayOf(provider, now);
  // espera gravada absurda (relógio errado, arquivo estranho): no máximo MAX_BLOCK_MS a partir de agora
  const until = u?.exhaustedUntil && u.exhaustedUntil > now ? Math.min(u.exhaustedUntil, now + MAX_BLOCK_MS) : undefined;
  if (!u || u.day !== day) return { day, requests: 0, tokens: 0, exhaustedUntil: until };
  return u.exhaustedUntil === until ? u : { ...u, exhaustedUntil: until };
}

async function update(provider: FreeProviderId, model: string, fn: (u: ProviderUsage) => void) {
  await mutex.run("usage", async () => {
    const all = (await readJson<UsageFile>(file())) ?? {};
    const u = fresh(provider, entryOf(all, provider, model));
    fn(u);
    // a chave antiga (por modelo) de uma cota da conta sai: fica só a nova
    if (ACCOUNT_QUOTA.includes(provider)) delete all[`${provider}|${model}`];
    all[keyOf(provider, model)] = u;
    await writeAtomic(file(), JSON.stringify(all, null, 1));
  });
}

/**
 * O dono salvou uma chave ou conta nova para o serviço: a cota esgotada anotada
 * era da conta antiga e deixa de valer (se a nova também estiver sem cota, o
 * primeiro pedido anota de novo).
 */
export async function clearExhausted(provider: FreeProviderId) {
  await mutex.run("usage", async () => {
    const all = (await readJson<UsageFile>(file())) ?? {};
    let changed = false;
    for (const [key, u] of Object.entries(all)) {
      if ((key === provider || key.startsWith(`${provider}|`)) && u.exhaustedUntil) {
        delete u.exhaustedUntil;
        changed = true;
      }
    }
    if (changed) await writeAtomic(file(), JSON.stringify(all, null, 1));
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

/**
 * Anota que a cota acabou. `minMs`: espera mínima (quem acabou de falhar não volta
 * na mesma hora, mesmo que o serviço diga “tente já”). Nunca encurta uma espera já anotada.
 */
export async function recordExhausted(provider: FreeProviderId, model: string, retryAt?: number, opts: { minMs?: number } = {}) {
  const now = Date.now();
  const until = Math.max(retryAt ?? defaultCooldown(provider, now), now + (opts.minMs ?? 0));
  await update(provider, model, (u) => {
    u.exhaustedUntil = Math.min(Math.max(u.exhaustedUntil ?? 0, until), now + MAX_BLOCK_MS);
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
  const u = fresh(provider, entryOf(all, provider, model));
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
