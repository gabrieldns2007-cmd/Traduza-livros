"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export type FaqEntry = { question: string; answer: ReactNode };

/**
 * Acordeão das perguntas frequentes. Fechado, é só uma lista limpa de
 * perguntas; tocar numa abre a resposta logo abaixo (e fecha a que estava
 * aberta), tocar de novo recolhe. A animação é só CSS: a altura vem de
 * grid-template-rows 0fr → 1fr, sem medir nada em JavaScript.
 */
export function FaqAccordion({ items }: { items: FaqEntry[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const baseId = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  // Setas, Home e End passeiam entre as perguntas (padrão de acordeão do WAI-ARIA).
  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    const last = items.length - 1;
    const targets: Record<string, number> = { ArrowDown: i === last ? 0 : i + 1, ArrowUp: i === 0 ? last : i - 1, Home: 0, End: last };
    const next = targets[e.key];
    if (next === undefined) return;
    e.preventDefault();
    buttons.current[next]?.focus();
  }

  return (
    <div className="border-b border-rule transition-[border-color] duration-200 has-[>[data-open]:last-child]:border-transparent">
      {items.map(({ question, answer }, i) => {
        const isOpen = open === i;
        const qid = `${baseId}q${i}`;
        const aid = `${baseId}a${i}`;
        return (
          <div
            key={question}
            data-open={isOpen ? "" : undefined}
            className="group/faq border-t border-rule py-1 transition-[border-color] duration-200 data-open:border-transparent [[data-open]+&]:border-transparent"
          >
            <div className="-mx-3 rounded-[1.125rem] transition-colors duration-200 ease-out group-data-open/faq:bg-paper-2">
              <h3>
                <button
                  ref={(el) => {
                    buttons.current[i] = el;
                  }}
                  id={qid}
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={aid}
                  onClick={() => setOpen(isOpen ? null : i)}
                  onKeyDown={(e) => onKeyDown(e, i)}
                  className="group/btn flex min-h-[3.25rem] w-full select-none items-center justify-between gap-4 rounded-[1.125rem] px-3 py-3 text-left text-[1rem] leading-snug font-[450] tracking-[-0.005em] text-ink transition-colors duration-200 ease-out hover:bg-paper-2 focus-visible:outline-offset-0 active:bg-paper-3"
                >
                  <span>{question}</span>
                  <span
                    aria-hidden
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-rule-strong text-ink-2 transition-[background-color,border-color,color,transform] duration-[260ms] ease-out-soft group-hover/btn:border-ink group-hover/btn:text-ink group-data-open/faq:rotate-45 group-data-open/faq:border-ink group-data-open/faq:bg-ink group-data-open/faq:text-paper motion-reduce:transition-none"
                  >
                    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
                      <path d="M6 1.5v9M1.5 6h9" />
                    </svg>
                  </span>
                </button>
              </h3>
              <div
                id={aid}
                role="region"
                aria-labelledby={qid}
                inert={!isOpen}
                className={`grid transition-[grid-template-rows,opacity,visibility] duration-[240ms] ease-out-soft motion-reduce:transition-none ${
                  isOpen ? "visible grid-rows-[1fr] opacity-100" : "invisible grid-rows-[0fr] opacity-0"
                }`}
              >
                <div className="min-h-0 overflow-hidden">
                  <p
                    className={`px-3 pr-14 pb-5 text-[0.9375rem] leading-relaxed text-ink-2 transition-transform duration-[240ms] ease-out-soft motion-reduce:transition-none ${
                      isOpen ? "translate-y-0" : "-translate-y-1"
                    }`}
                  >
                    {answer}
                  </p>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
