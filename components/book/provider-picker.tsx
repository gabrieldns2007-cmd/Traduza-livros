"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/client";
import { quotaText, type QuotaInfo } from "@/lib/quota-format";
import { QuoteCard, quoteAllows, type QuoteInfo, type WalletInfo } from "./quote-card";

export interface ProviderOption {
  id: string;
  label: string;
  model: string;
  available: boolean;
  paid: boolean;
  hint?: string;
  estimate: { low: number; high: number; known: boolean } | null;
  quota: QuotaInfo | null;
  quote: QuoteInfo | null;
}

export interface ProviderChoice {
  providerId: string;
  /** usuário confirmou que entende que pode haver custo */
  confirmCost: boolean;
  /** serviço utilizável (gratuito, ou pago com confirmação) — basta para a prévia grátis */
  ready: boolean;
  /** há créditos para traduzir (ou a pessoa escolheu traduzir só o que o saldo cobre) */
  creditsOk: boolean;
  /** créditos insuficientes: traduzir só o que o saldo cobre */
  partial: boolean;
}

function usd(v: number) {
  return v < 0.01 ? "menos de US$ 0,01" : `US$ ${v.toFixed(2).replace(".", ",")}`;
}

/**
 * Escolha do provedor antes de começar/continuar. O gratuito vem marcado;
 * um provedor pago mostra “Esta tradução pode gerar custos”, a estimativa e
 * só libera o botão depois da confirmação explícita.
 */
export function ProviderPicker({ bookId, onChange }: { bookId: string; onChange: (c: ProviderChoice) => void }) {
  const [options, setOptions] = useState<ProviderOption[] | null>(null);
  const [walletInfo, setWalletInfo] = useState<WalletInfo | null>(null);
  const [title, setTitle] = useState("");
  const [partial, setPartial] = useState(false);
  const [selected, setSelected] = useState<string>("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    api<{ defaultId: string; title: string; providers: ProviderOption[]; wallet: WalletInfo | null }>(`/api/books/${bookId}/providers`)
      .then((d) => {
        if (!alive) return;
        setOptions(d.providers);
        setWalletInfo(d.wallet);
        setTitle(d.title);
        // padrão sempre gratuito e com cota; o servidor já considera o serviço anterior do livro
        setSelected(d.defaultId);
      })
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [bookId]);

  const current = options?.find((p) => p.id === selected);
  useEffect(() => {
    if (!current) return;
    onChange({
      providerId: current.id,
      confirmCost: confirmed,
      partial,
      ready: current.available && (!current.paid || confirmed),
      creditsOk: quoteAllows(current.quote, walletInfo, partial),
    });
  }, [current, confirmed, partial, walletInfo, onChange]);

  if (error) return <p className="text-[0.875rem] text-accent">{error}</p>;
  if (!options) return <div className="h-24 animate-pulse rounded-xl bg-paper-2" aria-label="Carregando provedores" />;

  const visible = options;
  return (
    <div>
      <span className="label">Provedor</span>
      <div className="mt-2 space-y-2" role="radiogroup" aria-label="Provedor de tradução">
        {visible.map((p) => {
          const isSel = p.id === selected;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={isSel}
              disabled={!p.available}
              onClick={() => {
                setSelected(p.id);
                setConfirmed(false);
                setPartial(false);
              }}
              className={`flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left transition-colors active:bg-paper-2 disabled:cursor-not-allowed ${isSel ? "border-ink" : "border-rule hover:border-rule-strong"} ${!p.available ? "opacity-60" : ""}`}
            >
              <span
                className={`mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${isSel ? "border-ink bg-ink" : "border-rule-strong"}`}
              >
                {isSel && <span className="h-1.5 w-1.5 rounded-full bg-paper" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="text-[0.9375rem] text-ink">{p.label}</span>
                  <span className={`shrink-0 text-[0.75rem] ${p.paid ? "text-accent" : "text-ok"}`}>{p.paid ? "Pago" : "Gratuito"}</span>
                </span>
                <span className="mt-0.5 block text-[0.8125rem] text-muted">{p.available ? p.model : p.hint}</span>
                {(() => {
                  const q = quotaText(p.quota);
                  return q ? (
                    <span
                      className={`mt-0.5 block text-[0.8125rem] ${q.tone === "out" ? "text-accent" : q.tone === "low" ? "text-ink-2" : "text-ok"}`}
                    >
                      {q.text}
                    </span>
                  ) : null;
                })()}
              </span>
            </button>
          );
        })}
      </div>

      {current?.available && (
        <QuoteCard
          title={title}
          quote={current.quote}
          wallet={walletInfo}
          serviceLabel={current.label.replace(/ Free$/, "")}
          partial={partial}
          onPartial={setPartial}
        />
      )}

      {current && !current.available && !current.paid && (
        <p className="mt-3 text-[0.8125rem] text-ink-2">
          Para usar o {current.label} de graça,{" "}
          <Link href="/configuracoes" className="link text-ink">
            adicione a chave em Ajustes
          </Link>
          .
        </p>
      )}

      {current?.available && current.quota?.exhaustedUntil && (
        <p className="mt-3 text-[0.8125rem] leading-relaxed text-accent">
          A cota gratuita deste serviço acabou por hoje. Escolha outro serviço gratuito acima ou continue quando a cota voltar.
        </p>
      )}

      {current && !current.paid && current.available && current.id !== "demo" && (
        <p className="mt-3 text-[0.8125rem] leading-relaxed text-muted">
          Gratuito, sem cartão. Se a cota do dia acabar, a tradução pausa e você continua depois ou com outro serviço gratuito — nunca muda sozinha
          para um serviço pago.{current.id === "gemini" && " No nível gratuito o Google pode usar o texto enviado para melhorar os produtos dele."}
        </p>
      )}

      {current?.paid && current.available && (
        <div className="rise mt-3 rounded-xl bg-accent-soft/60 px-4 py-3">
          <p className="text-[0.9375rem] font-medium text-ink">Esta tradução pode gerar custos.</p>
          {current.estimate?.known ? (
            <p className="mt-1 text-[0.8125rem] text-ink-2">
              Estimativa para o que falta traduzir: {usd(current.estimate.low)} a {usd(current.estimate.high)} (cobrado pela{" "}
              {current.label.split(" ")[0]}).
            </p>
          ) : (
            <p className="mt-1 text-[0.8125rem] text-ink-2">Não temos uma estimativa para este modelo.</p>
          )}
          <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-[0.875rem] text-ink">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
            />
            Entendo que pode haver cobrança e quero usar este provedor.
          </label>
        </div>
      )}
    </div>
  );
}
