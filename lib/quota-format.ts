/** Texto curto dos “créditos grátis de hoje” (usado no navegador). */
export interface QuotaInfo {
  used: number;
  remaining: number | null;
  limit: number | null;
  approximate: boolean;
  exhaustedUntil: string | null;
}

/** “às 04:00” ou “amanhã às 04:00”, no horário de quem está vendo. */
export function whenBack(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const today = new Date(now).toDateString();
  const tomorrow = new Date(now + 864e5).toDateString();
  if (d.toDateString() === today) return `hoje às ${time}`;
  if (d.toDateString() === tomorrow) return `amanhã às ${time}`;
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function quotaText(q: QuotaInfo | null | undefined): { text: string; tone: "ok" | "low" | "out" } | null {
  if (!q) return null;
  if (q.exhaustedUntil) return { text: `Cota de hoje esgotada · volta ${whenBack(q.exhaustedUntil)}`, tone: "out" };
  if (q.remaining !== null && q.limit !== null) {
    const pre = q.approximate ? "cerca de " : "";
    return {
      text: `${pre}${q.remaining} de ${q.limit} pedidos grátis restantes hoje`,
      tone: q.remaining <= Math.max(2, q.limit * 0.15) ? "low" : "ok",
    };
  }
  return { text: q.used ? `${q.used} ${q.used === 1 ? "pedido usado" : "pedidos usados"} hoje` : "Nenhum pedido usado hoje", tone: "ok" };
}
