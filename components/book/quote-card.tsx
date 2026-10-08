"use client";

import Link from "next/link";
import { formatNumber } from "@/lib/format";
import { credits } from "@/lib/money";

export interface QuoteInfo {
  billing: "byok" | "hosted" | "none";
  quality: { id: string; label: string; per1k: number };
  words: number;
  credits: number;
}

export interface WalletInfo {
  mode: "off" | "preview" | "enforce";
  plan: { id: string; name: string; qualities?: string[] };
  available: number;
}

/** A qualidade escolhida não está no plano (só vale quando os créditos estão ativos). */
function outOfPlan(quote: QuoteInfo, wallet: WalletInfo) {
  return wallet.mode === "enforce" && quote.billing === "hosted" && !!wallet.plan.qualities && !wallet.plan.qualities.includes(quote.quality.id);
}

/**
 * Estimativa antes de traduzir: quantas palavras faltam e quanto isso consome.
 * Discreta quando está tudo bem; clara (sem susto) quando faltam créditos.
 */
export function QuoteCard({
  title,
  quote,
  wallet,
  serviceLabel,
  partial,
  onPartial,
}: {
  title?: string;
  quote: QuoteInfo | null;
  wallet: WalletInfo | null;
  serviceLabel: string;
  partial: boolean;
  onPartial: (v: boolean) => void;
}) {
  if (!quote || !wallet || quote.billing === "none" || !quote.words) return null;
  const locked = outOfPlan(quote, wallet);
  const short = !locked && wallet.mode === "enforce" && quote.billing === "hosted" && wallet.available < quote.credits;
  const coverWords = Math.floor((wallet.available * 1000) / quote.quality.per1k);

  return (
    <div className="mt-4 rounded-2xl border border-rule px-4 py-4 sm:px-5" aria-live="polite">
      <p className="label">Estimativa</p>
      <p className="mt-2 text-[0.9375rem] text-ink">
        {title && <span className="serif italic">{title}</span>}
        {title && <span className="text-muted"> · </span>}
        <span className="num">{formatNumber(quote.words)}</span> palavras a traduzir
      </p>

      {quote.billing === "byok" ? (
        <p className="mt-1 text-[0.875rem] text-ok">Com a sua chave gratuita do {serviceLabel} · não consome créditos</p>
      ) : (
        <>
          <p className="mt-1 text-[0.9375rem] text-ink">
            <span className="serif text-[1.25rem]">≈ {credits(quote.credits)}</span>
            <span className="text-[0.8125rem] text-muted">
              {" "}
              · qualidade {quote.quality.label} ({quote.quality.per1k} por mil palavras)
            </span>
          </p>
          <p className="mt-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[0.8125rem] text-muted">
            <span>
              Plano {wallet.plan.name} · saldo <span className="num text-ink-2">{credits(wallet.available)}</span>
            </span>
            <Link href="/planos" className="link text-ink-2 hover:text-ink">
              Ver planos
            </Link>
          </p>
          {wallet.mode === "preview" && (
            <p className="mt-2 text-[0.75rem] leading-relaxed text-muted">Beta: nenhum crédito é descontado por enquanto.</p>
          )}
          {locked && (
            <div className="mt-3 rounded-xl bg-paper-2 px-4 py-3">
              <p className="text-[0.9375rem] text-ink">
                A qualidade {quote.quality.label} não faz parte do plano {wallet.plan.name}.
              </p>
              <Link href="/planos" className="link mt-2 inline-block text-[0.875rem] text-ink">
                Ver planos
              </Link>
            </div>
          )}
          {short && (
            <div className="mt-3 rounded-xl bg-accent-soft/60 px-4 py-3">
              <p className="text-[0.9375rem] font-medium text-ink">Você precisa de {credits(quote.credits)} para traduzir este livro.</p>
              {wallet.available > 0 ? (
                <>
                  <p className="mt-1 text-[0.8125rem] text-ink-2">
                    Com os seus {credits(wallet.available)} dá para traduzir cerca de {formatNumber(coverWords)} palavras agora — e continuar depois,
                    do mesmo ponto.
                  </p>
                  <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-[0.875rem] text-ink">
                    <input
                      type="checkbox"
                      checked={partial}
                      onChange={(e) => onPartial(e.target.checked)}
                      className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
                    />
                    Traduzir só o que meus créditos cobrem
                  </label>
                </>
              ) : (
                <p className="mt-1 text-[0.8125rem] text-ink-2">Seu saldo acabou. O que já foi traduzido continua salvo.</p>
              )}
              <Link href="/planos" className="link mt-3 inline-block text-[0.875rem] text-ink">
                Comprar créditos
              </Link>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** A escolha pode começar? (sem créditos suficientes, só com “traduzir o que cobre”) */
export function quoteAllows(quote: QuoteInfo | null, wallet: WalletInfo | null, partial: boolean) {
  if (!quote || !wallet || wallet.mode !== "enforce" || quote.billing !== "hosted") return true;
  if (outOfPlan(quote, wallet)) return false;
  if (wallet.available >= quote.credits) return true;
  return partial && wallet.available > 0;
}
