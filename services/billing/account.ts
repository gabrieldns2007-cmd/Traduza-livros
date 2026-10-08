/** Resumo da carteira para as telas (plano, saldo, últimos movimentos). */
import { billingMode, type BillingMode } from "@/lib/billing/mode";
import { CREDIT, planById } from "@/lib/billing/catalog";
import { availableMilli, wallet } from "./wallet";

export interface WalletSummary {
  mode: BillingMode;
  plan: { id: string; name: string; monthlyCredits: number; qualities: string[] };
  available: number;
  reserved: number;
  /** próximos vencimentos (créditos, data) */
  expiring: { credits: number; at: string }[];
  recent: { at: string; kind: string; credits: number; note?: string; bookId?: string }[];
}

export async function walletSummary(): Promise<WalletSummary | null> {
  const mode = billingMode();
  if (mode === "off") return null;
  const w = await wallet.read();
  const plan = planById(w.plan);
  const reserved = Object.values(w.reservations).reduce((n, r) => n + r.milli - r.capturedMilli, 0);
  return {
    mode,
    plan: { id: plan.id, name: plan.name, monthlyCredits: plan.monthlyCredits, qualities: plan.qualities },
    available: Math.floor(availableMilli(w) / CREDIT.milli),
    reserved: Math.ceil(reserved / CREDIT.milli),
    expiring: w.lots
      .filter((l) => l.expiresAt)
      .sort((a, b) => a.expiresAt!.localeCompare(b.expiresAt!))
      .slice(0, 3)
      .map((l) => ({ credits: Math.floor(l.milli / CREDIT.milli), at: l.expiresAt! })),
    recent: w.ledger
      .slice(-12)
      .reverse()
      .map((e) => ({ at: e.at, kind: e.kind, credits: Math.round((e.milli / CREDIT.milli) * 10) / 10, note: e.note, bookId: e.bookId })),
  };
}
