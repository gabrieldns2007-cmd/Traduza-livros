"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import { OPERATIONS, priceFor, SERVICE_LEVELS, type ServiceLevelId } from "@/lib/billing/pricing";
import { brl } from "@/lib/money";
import { Check } from "@/components/ui/icons";
import styles from "./edition-configurator.module.css";

const MIN_WORDS = 5_000;
const MAX_WORDS = 300_000;
const STEP = 5_000;
/** página de um livro impresso comum */
const WORDS_PER_PAGE = 300;

/** Tipos de livro: o toque leva ao tamanho típico; o controle deslizante mostra em qual faixa você está. */
const BOOK_KINDS = [
  { id: "conto", label: "Conto", words: 10_000, upTo: 40_000 },
  { id: "romance", label: "Romance", words: 80_000, upTo: 120_000 },
  { id: "longo", label: "Livro longo", words: 150_000, upTo: Infinity },
] as const;

const pages = (words: number) => Math.max(10, Math.round(words / WORDS_PER_PAGE / 10) * 10);
const thousands = (words: number) => `${(words / 1000).toLocaleString("pt-BR")} mil`;

function Step({ n, kicker, title, children }: { n: number; kicker: string; title: string; children: ReactNode }) {
  return (
    <div className="border-t border-rule pt-7">
      <p className="label">
        <span className="num text-accent">{n}</span>
        <span className="mx-1.5 text-rule-strong">/</span>
        {kicker}
      </p>
      <h3 className="serif mt-2 text-[1.5rem] leading-[1.15] tracking-[-0.015em] text-ink text-balance sm:text-[1.75rem]">{title}</h3>
      {children}
    </div>
  );
}

/**
 * “Monte a sua edição”: o tipo de livro, o tamanho e o tipo de tradução —
 * com o valor estimado sempre à vista antes do botão. O cálculo é o mesmo
 * da tela de confirmação (`priceFor`).
 *
 * `action` é o botão final (enviar o livro), vindo da página.
 */
export function EditionConfigurator({ literariaAvailable, action }: { literariaAvailable: boolean; action?: ReactNode }) {
  const [words, setWords] = useState(80_000);
  const [level, setLevel] = useState<ServiceLevelId>("padrao");

  const kind = BOOK_KINDS.find((k) => words <= k.upTo) ?? BOOK_KINDS[BOOK_KINDS.length - 1];
  const fill = ((words - MIN_WORDS) / (MAX_WORDS - MIN_WORDS)) * 100;
  const chosen = SERVICE_LEVELS.find((l) => l.id === level) ?? SERVICE_LEVELS[0];
  const available = (id: ServiceLevelId) => id === "padrao" || literariaAvailable;

  return (
    <div className="space-y-10">
      {/* ---------- 1. o livro ---------- */}
      <Step n={1} kicker="O livro" title="Que tipo de livro você está traduzindo?">
        <div className="mt-5 grid grid-cols-3 gap-2" role="radiogroup" aria-label="Tipo de livro">
          {BOOK_KINDS.map((k) => {
            const sel = k.id === kind.id;
            return (
              <button
                key={k.id}
                type="button"
                role="radio"
                aria-checked={sel}
                onClick={() => setWords(k.words)}
                className={`flex min-h-[4.5rem] flex-col items-center justify-center rounded-2xl border px-2 py-3 text-center transition-[background-color,border-color,color,transform] duration-200 ease-[var(--ease-out-soft)] active:scale-[0.97] ${
                  sel ? "border-ink bg-ink text-paper" : "border-rule text-ink hover:border-rule-strong hover:bg-paper-2 active:bg-paper-3"
                }`}
              >
                <span className="text-[0.9375rem] leading-tight font-medium">{k.label}</span>
                <span className={`num mt-1 text-[0.75rem] leading-tight ${sel ? "text-paper/65" : "text-muted"}`}>≈ {pages(k.words)} páginas</span>
              </button>
            );
          })}
        </div>

        <div className="mt-8">
          <div className="flex items-baseline justify-between gap-4">
            <p className="text-ink">
              <span className="serif num text-[2.25rem] leading-none tracking-[-0.02em]">{words.toLocaleString("pt-BR")}</span>
              <span className="ml-2 text-[0.9375rem] text-ink-2">palavras</span>
            </p>
            <p className="num text-[0.875rem] text-muted">≈ {pages(words)} páginas</p>
          </div>
          <input
            type="range"
            min={MIN_WORDS}
            max={MAX_WORDS}
            step={STEP}
            value={words}
            onChange={(e) => setWords(Number(e.target.value))}
            className={`${styles.range} mt-3`}
            style={{ "--fill": `${fill}%` } as CSSProperties}
            aria-label="Tamanho do livro, em palavras"
            aria-valuetext={`${words.toLocaleString("pt-BR")} palavras, cerca de ${pages(words)} páginas`}
          />
          <div className="num mt-1 flex justify-between text-[0.75rem] text-muted">
            <span>{thousands(MIN_WORDS)}</span>
            <span>{thousands(MAX_WORDS)} palavras</span>
          </div>
        </div>
      </Step>

      {/* ---------- 2. a tradução ---------- */}
      <Step n={2} kicker="A tradução" title="Como você quer a tradução?">
        <div className="mt-5 space-y-3" role="radiogroup" aria-label="Tipo de tradução">
          {SERVICE_LEVELS.map((l) => {
            const on = available(l.id);
            const sel = on && l.id === level;
            return (
              <button
                key={l.id}
                type="button"
                role="radio"
                aria-checked={sel}
                aria-disabled={!on}
                onClick={() => on && setLevel(l.id)}
                className={`relative flex w-full items-start gap-4 rounded-[1.25rem] border px-5 py-5 text-left transition-[background-color,border-color,box-shadow,transform] duration-200 ease-[var(--ease-out-soft)] ${
                  sel
                    ? "border-ink bg-paper shadow-[0_0_0_1px_var(--ink),0_12px_32px_-20px_rgba(0,0,0,0.5)]"
                    : on
                      ? "border-rule hover:border-rule-strong hover:bg-paper-2 active:scale-[0.99] active:bg-paper-3"
                      : "cursor-not-allowed border-dashed border-rule-strong"
                }`}
              >
                <span
                  aria-hidden
                  className={`mt-[0.2rem] flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors duration-200 ${
                    sel ? "border-ink bg-ink text-paper" : on ? "border-rule-strong" : "border-rule"
                  }`}
                >
                  {sel && <Check className="h-3.5 w-3.5" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className={`text-[1.0625rem] font-medium ${on ? "text-ink" : "text-ink-2"}`}>Tradução {l.label}</span>
                    {on ? (
                      <span className="serif num shrink-0 text-[1.375rem] leading-none text-ink">{brl(priceFor(words, l.id))}</span>
                    ) : (
                      <span className="shrink-0 rounded-full bg-accent-soft px-2.5 py-1 text-[0.75rem] leading-none font-medium text-accent">
                        Em breve
                      </span>
                    )}
                  </span>
                  <span className={`mt-1.5 block text-[0.9375rem] leading-relaxed ${on ? "text-ink-2" : "text-muted"}`}>{l.description}</span>
                </span>
              </button>
            );
          })}
        </div>
      </Step>

      {/* ---------- 3. a edição ---------- */}
      <div className="rounded-[1.5rem] bg-paper-2 px-5 pt-6 pb-6 sm:px-7 sm:pt-7">
        <p className="label">
          <span className="num text-accent">3</span>
          <span className="mx-1.5 text-rule-strong">/</span>
          Sua nova edição
        </p>
        <p className="serif mt-3 text-[1.5rem] leading-tight tracking-[-0.01em] text-ink">{kind.label} em português</p>
        <p className="num mt-1 text-[0.875rem] leading-relaxed text-muted">
          {words.toLocaleString("pt-BR")} palavras · Tradução {chosen.label} · EPUB e PDF
        </p>

        <div className="mt-5 border-t border-rule pt-4">
          <div className="flex items-baseline justify-between gap-4">
            <p className="text-[1rem] text-ink">Seu orçamento</p>
            <p className="serif num shrink-0 text-[2.5rem] leading-none tracking-[-0.025em] text-ink" aria-live="polite">
              <span key={`${level}-${kind.id}`} className={styles.settle}>
                {brl(priceFor(words, chosen.id))}
              </span>
            </p>
          </div>
          <p className="mt-2 text-[0.8125rem] leading-relaxed text-muted">
            Calculado pelo tamanho do livro, a partir de {brl(OPERATIONS.minimumBrl)}.
          </p>
        </div>

        {action && <div className="mt-6 [&_button]:w-full">{action}</div>}

        <p className="mt-4 text-center text-[0.8125rem] leading-relaxed text-muted">
          Você vê o valor exato antes de continuar.
          <br />
          Sem assinatura · Sem cobranças recorrentes
        </p>
      </div>
    </div>
  );
}
