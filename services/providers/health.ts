/**
 * Saúde de cada serviço de IA (disjuntor), compartilhada por todos os livros e
 * guardada em DATA_DIR/health.json — sobrevive a reinícios do servidor.
 *
 * Chave: “serviço|modelo”. Regras:
 *  - falha passageira (servidor fora do ar, rede, limite por minuto) que sobrou
 *    depois das novas tentativas do processador: o serviço descansa 1 minuto;
 *    a partir de 3 seguidas o disjuntor abre: 2 min, depois 4, 8… até 60 min;
 *  - falha da CONTA, que não passa sozinha (chave recusada, modelo indisponível
 *    ou que exige plano pago, região bloqueada): fecha por 6 h, ou até o dono
 *    salvar uma chave ou um modelo novo para o serviço. Um pedido recusado só
 *    daquela vez (400, ex.: o modelo não conseguiu escrever o JSON) não é da
 *    conta: conta como falha passageira (não tira o serviço de todos os livros);
 *  - o serviço pediu para esperar (Retry-After): a espera é no mínimo essa;
 *  - quando a espera termina, o próximo pedido é um teste (meio aberto): se der
 *    certo, tudo volta ao normal; se falhar, abre de novo por mais tempo;
 *  - qualquer resposta que volta inteira fecha o disjuntor e zera a contagem.
 *
 * Cota esgotada não passa por aqui (fica em usage.json, com a hora em que volta).
 */
import path from "node:path";
import { config } from "@/lib/config";
import { readJson, writeAtomic } from "@/lib/storage";
import { KeyedMutex } from "@/utils/async";

/** espera mínima depois de qualquer falha: quem acabou de falhar nunca é escolhido de novo na hora */
export const MIN_COOLDOWN_MS = 60_000;
/** falhas passageiras seguidas que abrem o disjuntor */
export const OPEN_AFTER = 3;
const FIRST_OPEN_MS = 2 * 60_000;
const MAX_OPEN_MS = 60 * 60_000;
/** chave/modelo recusados: só volta a tentar depois disso (ou com chave/modelo novos) */
export const FATAL_OPEN_MS = 6 * 3600_000;
/**
 * Nenhuma espera gravada (aqui e na cota, em usage.json) vale mais que isto ao ser
 * lida: um relógio errado ou um arquivo estranho nunca prende um serviço para sempre.
 */
export const MAX_BLOCK_MS = 35 * 24 * 3600_000;

/** Códigos de falha da conta (só eles fecham o serviço por 6 h): chave recusada; modelo indisponível, pago ou fora da região. */
const ACCOUNT_CODES: readonly string[] = ["auth", "model"];

/** A falha é da conta (chave, modelo, plano pago, região) — e não só deste pedido? */
export function isAccountFailure(failure: { code: string; fatal: boolean }): boolean {
  return failure.fatal && ACCOUNT_CODES.includes(failure.code);
}

export type HealthState = "closed" | "cooldown" | "open" | "half_open";

interface Entry {
  /** falhas passageiras seguidas */
  consecutive: number;
  /** quantas vezes o disjuntor abriu seguidas (dobra a espera) */
  opens: number;
  /** não usar antes disto (ms) */
  blockedUntil?: number;
  /** "transient": passageira (ou só daquele pedido); "fatal": chave/modelo/plano/região recusados */
  kind?: "transient" | "fatal";
  /** código e mensagem da última falha (só para o painel) */
  code?: string;
  lastError?: string;
  at: number;
}

type HealthFile = Record<string, Entry>;

export interface HealthView {
  provider: string;
  model: string;
  state: HealthState;
  /** volta a ser usado a partir de (ISO), se estiver bloqueado */
  blockedUntil: string | null;
  consecutive: number;
  kind: "transient" | "fatal" | null;
  code: string | null;
  lastError: string | null;
  at: string;
}

const mutex = new KeyedMutex();
const file = () => path.join(config.dataDir, "health.json");
const keyOf = (provider: string, model: string) => `${provider}|${model}`;

async function readAll(): Promise<HealthFile> {
  try {
    return (await readJson<HealthFile>(file())) ?? {};
  } catch {
    // arquivo corrompido: começa do zero (só perde o histórico de falhas)
    return {};
  }
}

async function change(fn: (all: HealthFile) => boolean) {
  await mutex.run("health", async () => {
    const all = await readAll();
    if (fn(all)) await writeAtomic(file(), JSON.stringify(all, null, 1));
  });
}

/** Até quando a entrada bloqueia (ms), com o teto de MAX_BLOCK_MS a partir de agora; null se já pode ser usado. */
function untilOf(e: Entry | undefined, now: number): number | null {
  return e?.blockedUntil && e.blockedUntil > now ? Math.min(e.blockedUntil, now + MAX_BLOCK_MS) : null;
}

function stateOf(e: Entry | undefined, now: number): HealthState {
  if (!e) return "closed";
  if (untilOf(e, now)) return e.consecutive >= OPEN_AFTER || e.kind === "fatal" ? "open" : "cooldown";
  // a espera acabou depois de abrir: o próximo pedido é um teste
  if (e.consecutive >= OPEN_AFTER || e.kind === "fatal") return "half_open";
  return "closed";
}

/** Até quando este serviço/modelo não deve ser usado (ms), ou null se pode ser usado agora. */
export async function blockedUntil(provider: string, model: string, now = Date.now()): Promise<number | null> {
  return untilOf((await readAll())[keyOf(provider, model)], now);
}

/** Uma resposta voltou: fecha o disjuntor (só grava se havia algo anotado). */
export async function recordSuccess(provider: string, model: string) {
  await change((all) => {
    if (!all[keyOf(provider, model)]) return false;
    delete all[keyOf(provider, model)];
    return true;
  });
}

/**
 * Anota uma falha que sobrou depois das novas tentativas. Da conta (chave, modelo,
 * plano pago, região) fecha por 6 h; qualquer outra, por 1 minuto ou mais
 * (disjuntor) — e nunca menos que o `retryAt` pedido pelo serviço (Retry-After).
 * Devolve até quando o serviço fica bloqueado (ms).
 */
export async function recordFailure(
  provider: string,
  model: string,
  failure: { code: string; fatal: boolean; message?: string; retryAt?: number },
  now = Date.now(),
): Promise<number> {
  let until = now + MIN_COOLDOWN_MS;
  await change((all) => {
    const key = keyOf(provider, model);
    const e: Entry = all[key] ?? { consecutive: 0, opens: 0, at: now };
    e.at = now;
    e.code = failure.code;
    e.lastError = failure.message?.slice(0, 300);
    if (isAccountFailure(failure)) {
      e.kind = "fatal";
      until = now + FATAL_OPEN_MS;
    } else {
      e.kind = "transient";
      e.consecutive++;
      if (e.consecutive >= OPEN_AFTER) {
        // abre (ou reabre, depois de um teste que falhou) por mais tempo a cada vez
        e.opens++;
        until = now + Math.min(FIRST_OPEN_MS * 2 ** (e.opens - 1), MAX_OPEN_MS);
      }
    }
    // o serviço disse quando voltar (Retry-After): não tenta antes disso (com o teto)
    if (failure.retryAt && failure.retryAt > until) until = Math.min(failure.retryAt, now + MAX_BLOCK_MS);
    e.blockedUntil = Math.min(Math.max(e.blockedUntil && e.blockedUntil > now ? e.blockedUntil : 0, until), now + MAX_BLOCK_MS);
    until = e.blockedUntil;
    all[key] = e;
    return true;
  });
  return until;
}

/** O dono salvou chave, conta ou modelo novos para o serviço: esquece as falhas dele. */
export async function clearProvider(provider: string) {
  await change((all) => {
    let changed = false;
    for (const key of Object.keys(all)) {
      if (key.startsWith(`${provider}|`)) {
        delete all[key];
        changed = true;
      }
    }
    return changed;
  });
}

/** Estado de todos os serviços com falhas anotadas (painel). */
export async function snapshot(now = Date.now()): Promise<HealthView[]> {
  const all = await readAll();
  return Object.entries(all).map(([key, e]) => {
    const [provider, ...rest] = key.split("|");
    const until = untilOf(e, now);
    return {
      provider,
      model: rest.join("|"),
      state: stateOf(e, now),
      blockedUntil: until ? new Date(until).toISOString() : null,
      consecutive: e.consecutive,
      kind: e.kind ?? null,
      code: e.code ?? null,
      lastError: e.lastError ?? null,
      at: new Date(e.at).toISOString(),
    };
  });
}

/** Estado de um serviço/modelo (painel). */
export async function healthOf(provider: string, model: string, now = Date.now()): Promise<HealthView | null> {
  return (await snapshot(now)).find((h) => h.provider === provider && h.model === model) ?? null;
}
