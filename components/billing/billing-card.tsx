"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/client";
import { credits } from "@/lib/money";
import { LinkPending } from "@/components/ui/pending";

interface Summary {
  mode: "off" | "preview" | "enforce";
  plan: { id: string; name: string; monthlyCredits: number };
  available: number;
  reserved: number;
  expiring: { credits: number; at: string }[];
  recent: { at: string; kind: string; credits: number; note?: string }[];
}

const KIND: Record<string, string> = { grant: "Entrada", charge: "Tradução", expire: "Vencimento" };

/** Plano e créditos: saldo, o que vence e os últimos movimentos. */
export function BillingCard() {
  const [data, setData] = useState<Summary | null | undefined>(undefined);

  useEffect(() => {
    api<{ wallet: Summary | null }>("/api/billing")
      .then((d) => setData(d.wallet))
      .catch(() => setData(null));
  }, []);

  if (data === undefined) return <div className="h-24 animate-pulse rounded-2xl bg-paper-2" aria-label="Carregando" />;
  if (data === null) return null;

  const next = data.expiring[0];
  return (
    <div>
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-[0.875rem] text-muted">Plano {data.plan.name}</p>
          <p className="serif num mt-1 text-[2rem] leading-none text-ink">{credits(data.available)}</p>
          {data.reserved > 0 && <p className="mt-1 text-[0.8125rem] text-muted">{credits(data.reserved)} reservados para traduções em andamento</p>}
        </div>
        <Link href="/planos" className="link mb-1 inline-flex shrink-0 items-center gap-1.5 text-[0.875rem] text-ink-2 hover:text-ink">
          Ver planos
          <LinkPending />
        </Link>
      </div>
      <p className="mt-3 text-[0.8125rem] leading-relaxed text-muted">
        1 crédito = 1.000 palavras na qualidade Padrão.
        {data.plan.monthlyCredits > 0 && ` Todo mês entram ${credits(data.plan.monthlyCredits)}.`}
        {next && next.credits > 0 && ` ${credits(next.credits)} vencem em ${new Date(next.at).toLocaleDateString("pt-BR")}.`}
        {data.mode === "preview" && " Beta: nenhum crédito é descontado por enquanto."}
      </p>
      {data.recent.length > 0 && (
        <ul className="mt-4 divide-y divide-rule border-y border-rule">
          {data.recent.slice(0, 5).map((e, i) => (
            <li key={i} className="flex items-baseline justify-between gap-4 py-2.5 text-[0.875rem]">
              <span className="min-w-0 truncate text-ink-2">
                {KIND[e.kind] ?? e.kind}
                {e.note && <span className="text-muted"> · {e.note}</span>}
              </span>
              <span className={`num shrink-0 ${e.credits < 0 ? "text-ink" : "text-ok"}`}>
                {e.credits > 0 ? "+" : ""}
                {e.credits.toLocaleString("pt-BR")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
