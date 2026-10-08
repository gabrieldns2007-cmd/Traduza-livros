import { Check } from "./icons";

const STEPS = ["Enviar", "Prévia grátis", "Traduzir e baixar"];

/**
 * Passos 1-2-3: Enviar → Prévia grátis → Traduzir e baixar.
 * `current` é o passo em andamento (1 a 3); `done` marca o último como concluído.
 */
export function Steps({ current, done = false, className = "" }: { current: 1 | 2 | 3; done?: boolean; className?: string }) {
  return (
    <ol className={`flex items-center justify-between gap-2 sm:justify-start ${className}`} aria-label="Etapas">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const complete = n < current || (done && n === current);
        const active = n === current && !done;
        return (
          <li
            key={label}
            className="flex flex-none items-center gap-1.5 sm:flex-1 sm:gap-2 sm:last:flex-none"
            aria-current={active ? "step" : undefined}
          >
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[0.75rem] transition-colors ${
                complete ? "bg-ink text-paper" : active ? "border border-accent text-accent" : "border border-rule-strong text-muted"
              }`}
            >
              {complete ? <Check className="h-3.5 w-3.5" /> : <span className="num">{n}</span>}
            </span>
            <span className={`text-[0.75rem] whitespace-nowrap sm:text-[0.8125rem] ${active ? "text-ink" : complete ? "text-ink-2" : "text-muted"}`}>
              {label}
            </span>
            {n < STEPS.length && <span className={`hidden h-px min-w-4 flex-1 sm:block ${complete ? "bg-ink-2" : "bg-rule"}`} aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}
