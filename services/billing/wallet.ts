/**
 * Carteira de créditos de uma conta.
 *
 * Créditos ficam em “lotes” com validade (boas-vindas, mensais do plano,
 * pacotes comprados); o consumo usa primeiro o lote que vence antes.
 *
 * Uma tradução nunca consome sem limite:
 *   1. reserva   — antes de começar, separa os créditos estimados (ou só o
 *                  que a pessoa tem, se ela escolher traduzir parte);
 *   2. captura   — a cada lote traduzido, desconta pelas palavras salvas;
 *   3. liberação — ao terminar/pausar, devolve o que sobrou da reserva.
 * Se a reserva acaba, a tradução pausa (tudo que foi traduzido fica salvo).
 *
 * Guardada em data/billing/wallet.json (no navegador, no IndexedDB). Para
 * vários usuários num servidor, troque o WalletStore por um banco — a lógica
 * não muda.
 */
import path from "node:path";
import { config } from "@/lib/config";
import { readJson, writeAtomic } from "@/lib/storage";
import { KeyedMutex } from "@/utils/async";
import { CREDIT, PACKS, planById, type PlanId } from "@/lib/billing/catalog";

export type GrantSource = "welcome" | "monthly" | "pack" | "subscription" | "adjust";

export interface CreditLot {
  id: string;
  source: GrantSource;
  milli: number;
  grantedAt: string;
  /** ISO; sem validade quando ausente */
  expiresAt?: string;
}

export interface LedgerEntry {
  id: string;
  at: string;
  kind: "grant" | "charge" | "expire";
  /** efeito no saldo, em milésimos (negativo = consumo) */
  milli: number;
  source?: GrantSource;
  bookId?: string;
  runId?: string;
  /** id do pagamento/assinatura no meio de pagamento (evita creditar duas vezes) */
  externalId?: string;
  note?: string;
}

export interface Reservation {
  bookId: string;
  milli: number;
  capturedMilli: number;
  at: string;
}

export interface Wallet {
  version: 1;
  plan: PlanId;
  planSince: string;
  lots: CreditLot[];
  reservations: Record<string, Reservation>;
  welcomeGranted: boolean;
  /** mês (AAAA-MM) em que os créditos mensais já entraram */
  monthlyGrantedFor?: string;
  previews: { day: string; count: number };
  ledger: LedgerEntry[];
}

export class WalletError extends Error {
  constructor(
    message: string,
    readonly code: "insufficient" | "preview_limit",
    readonly availableMilli = 0,
  ) {
    super(message);
    this.name = "WalletError";
  }
}

const mutex = new KeyedMutex();
const file = () => path.join(config.dataDir, "billing", "wallet.json");
const MAX_LEDGER = 500;

function month(d = new Date()) {
  return d.toISOString().slice(0, 7);
}

function endOfMonthPlus(months: number, d = new Date()): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1 + months, 1)).toISOString();
}

function newId(prefix: string) {
  return `${prefix}_${globalThis.crypto.randomUUID().slice(0, 12)}`;
}

function blank(): Wallet {
  return {
    version: 1,
    plan: "free",
    planSince: new Date().toISOString(),
    lots: [],
    reservations: {},
    welcomeGranted: false,
    previews: { day: "", count: 0 },
    ledger: [],
  };
}

function log(w: Wallet, e: Omit<LedgerEntry, "id" | "at">) {
  w.ledger.push({ id: newId("le"), at: new Date().toISOString(), ...e });
  if (w.ledger.length > MAX_LEDGER) w.ledger.splice(0, w.ledger.length - MAX_LEDGER);
}

function addLot(w: Wallet, source: GrantSource, milli: number, expiresAt?: string, extra: Partial<LedgerEntry> = {}) {
  if (milli <= 0) return;
  w.lots.push({ id: newId("lot"), source, milli, grantedAt: new Date().toISOString(), expiresAt });
  log(w, { kind: "grant", milli, source, ...extra });
}

/** Vencimentos, boas-vindas e créditos do mês — aplicados sempre que a carteira é lida. */
function refresh(w: Wallet, now = new Date()) {
  for (const lot of w.lots) {
    if (lot.expiresAt && Date.parse(lot.expiresAt) <= now.getTime() && lot.milli > 0) {
      log(w, { kind: "expire", milli: -lot.milli, source: lot.source });
      lot.milli = 0;
    }
  }
  w.lots = w.lots.filter((l) => l.milli > 0);
  const plan = planById(w.plan);
  if (!w.welcomeGranted) {
    w.welcomeGranted = true;
    addLot(w, "welcome", plan.welcomeCredits * CREDIT.milli, endOfMonthPlus(11, now), { note: "Créditos de boas-vindas" });
  }
  if (w.monthlyGrantedFor !== month(now)) {
    w.monthlyGrantedFor = month(now);
    addLot(w, "monthly", plan.monthlyCredits * CREDIT.milli, endOfMonthPlus(plan.rolloverMonths, now), { note: `Créditos do plano ${plan.name}` });
  }
}

/** Saldo livre (já descontadas as reservas em andamento), em milésimos. */
export function availableMilli(w: Wallet): number {
  const lots = w.lots.reduce((n, l) => n + l.milli, 0);
  const held = Object.values(w.reservations).reduce((n, r) => n + (r.milli - r.capturedMilli), 0);
  return Math.max(0, lots - held);
}

/** Desconta dos lotes, primeiro os que vencem antes. */
function consume(w: Wallet, milli: number) {
  const lots = [...w.lots].sort((a, b) => (a.expiresAt ?? "9999").localeCompare(b.expiresAt ?? "9999"));
  let left = milli;
  for (const lot of lots) {
    if (left <= 0) break;
    const take = Math.min(lot.milli, left);
    lot.milli -= take;
    left -= take;
  }
  w.lots = w.lots.filter((l) => l.milli > 0);
}

async function mutate<T>(fn: (w: Wallet) => T | Promise<T>): Promise<T> {
  return mutex.run("wallet", async () => {
    const w = (await readJson<Wallet>(file())) ?? blank();
    refresh(w);
    const result = await fn(w);
    await writeAtomic(file(), JSON.stringify(w, null, 1));
    return result;
  });
}

export const wallet = {
  /** Lê a carteira (aplicando vencimentos e créditos do mês). */
  read(): Promise<Wallet> {
    return mutate((w) => structuredClone(w));
  },

  /**
   * Reserva créditos para uma execução. Com `partial`, reserva o que houver
   * (no mínimo `minMilli`); sem, exige o valor inteiro.
   */
  reserve(runId: string, bookId: string, milli: number, opts: { partial?: boolean; minMilli?: number } = {}): Promise<number> {
    return mutate((w) => {
      const free = availableMilli(w);
      const amount = opts.partial ? Math.min(free, milli) : milli;
      if (free < milli && !opts.partial) {
        throw new WalletError(`Você precisa de ${Math.ceil(milli / CREDIT.milli)} créditos para traduzir este livro.`, "insufficient", free);
      }
      if (amount <= 0 || amount < (opts.minMilli ?? 1)) {
        throw new WalletError("Seus créditos acabaram.", "insufficient", free);
      }
      w.reservations[runId] = { bookId, milli: amount, capturedMilli: 0, at: new Date().toISOString() };
      return amount;
    });
  },

  /** Desconta o consumo real (até o limite da reserva). Devolve quanto foi descontado. */
  capture(runId: string, milli: number): Promise<number> {
    return mutate((w) => {
      const r = w.reservations[runId];
      if (!r || milli <= 0) return 0;
      const take = Math.min(milli, r.milli - r.capturedMilli);
      r.capturedMilli += take;
      consume(w, take);
      return take;
    });
  },

  /** Fecha a reserva: registra o total cobrado e devolve o resto ao saldo. */
  release(runId: string, note?: string): Promise<number> {
    return mutate((w) => {
      const r = w.reservations[runId];
      if (!r) return 0;
      delete w.reservations[runId];
      if (r.capturedMilli > 0) log(w, { kind: "charge", milli: -r.capturedMilli, bookId: r.bookId, runId, note });
      return r.capturedMilli;
    });
  },

  /** Reservas de execuções que não estão mais rodando (ex.: servidor reiniciou). */
  releaseStale(activeRunIds: Set<string>): Promise<void> {
    return mutate((w) => {
      for (const [runId, r] of Object.entries(w.reservations)) {
        if (activeRunIds.has(runId)) continue;
        delete w.reservations[runId];
        if (r.capturedMilli > 0) log(w, { kind: "charge", milli: -r.capturedMilli, bookId: r.bookId, runId, note: "fechada após reinício" });
      }
    });
  },

  /** Conta uma prévia do dia; lança erro acima do limite do plano. */
  notePreview(): Promise<void> {
    return mutate((w) => {
      const plan = planById(w.plan);
      const day = new Date().toISOString().slice(0, 10);
      if (w.previews.day !== day) w.previews = { day, count: 0 };
      if (w.previews.count >= plan.previewsPerDay) {
        throw new WalletError(`Você já usou as ${plan.previewsPerDay} prévias grátis de hoje. Amanhã tem mais.`, "preview_limit");
      }
      w.previews.count++;
    });
  },

  /**
   * Credita um pagamento/assinatura/ajuste. Idempotente por `externalId`:
   * o mesmo aviso do meio de pagamento nunca credita duas vezes.
   */
  grant(source: GrantSource, credits: number, opts: { externalId?: string; validityMonths?: number; note?: string } = {}): Promise<boolean> {
    return mutate((w) => {
      if (opts.externalId && w.ledger.some((e) => e.externalId === opts.externalId)) return false;
      const expiresAt = opts.validityMonths !== undefined ? endOfMonthPlus(opts.validityMonths) : undefined;
      const milli = Math.round(credits * CREDIT.milli);
      // eventos sem créditos (ex.: início de assinatura) também ficam no extrato, para não serem aplicados duas vezes
      if (milli <= 0) log(w, { kind: "grant", milli: 0, source, externalId: opts.externalId, note: opts.note });
      else addLot(w, source, milli, expiresAt, { externalId: opts.externalId, note: opts.note });
      return true;
    });
  },

  /** Troca de plano (vale a partir do próximo crédito mensal). */
  setPlan(plan: PlanId): Promise<void> {
    return mutate((w) => {
      if (w.plan === plan) return;
      w.plan = plan;
      w.planSince = new Date().toISOString();
      // o crédito mensal do novo plano entra já
      w.monthlyGrantedFor = undefined;
      refresh(w);
    });
  },
};

export function packById(id: string) {
  return PACKS.find((p) => p.id === id);
}
