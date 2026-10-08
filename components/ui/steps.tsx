import { Check } from "./icons";

const STEPS = ["Enviar", "Prévia grátis", "Traduzir e baixar"];

/** Etapas da compra de uma tradução (Verso de servidor próprio). */
export const COMMERCE_STEPS = ["Enviar", "Confirmar", "Tradução", "Baixar"];

/**
 * Etapas do processo (padrão: Enviar → Prévia grátis → Traduzir e baixar).
 * `current` é a etapa em andamento (a partir de 1); `done` marca a última como concluída.
 */
export function Steps({
  current,
  done = false,
  className = "",
  steps = STEPS,
}: {
  current: number;
  done?: boolean;
  className?: string;
  steps?: string[];
}) {
  return (
    <ol className={`flex items-center justify-between gap-2 sm:justify-start ${className}`} aria-label="Etapas">
      {steps.map((label, i) => {
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
            {n < steps.length && <span className={`hidden h-px min-w-4 flex-1 sm:block ${complete ? "bg-ink-2" : "bg-rule"}`} aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}
