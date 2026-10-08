import { Check } from "./icons";

export const TRANSLATION_STAGES = ["Livro", "Processando", "Traduzindo", "Revisando", "Pronto"];

/**
 * Etapas da tradução depois da compra: Livro → Processando → Traduzindo →
 * Revisando → Pronto. `current` é o índice da etapa em andamento (0 a 4);
 * `paused` deixa a etapa atual em cinza; `done` marca todas.
 */
export function StageTrack({
  current,
  paused = false,
  done = false,
  className = "",
}: {
  current: number;
  paused?: boolean;
  done?: boolean;
  className?: string;
}) {
  return (
    <ol className={`grid grid-cols-5 ${className}`} aria-label="Etapas da tradução">
      {TRANSLATION_STAGES.map((label, i) => {
        const complete = done || i < current;
        const active = !done && i === current;
        return (
          <li key={label} className="relative flex flex-col items-center text-center" aria-current={active ? "step" : undefined}>
            {i > 0 && <span className={`absolute top-[11px] right-1/2 h-px w-full ${complete || active ? "bg-ink-2" : "bg-rule"}`} aria-hidden />}
            <span
              className={`relative z-10 flex h-[23px] w-[23px] items-center justify-center rounded-full transition-colors ${
                complete
                  ? "bg-ink text-paper"
                  : active
                    ? paused
                      ? "border border-rule-strong bg-paper"
                      : "border-2 border-accent bg-paper"
                    : "border border-rule-strong bg-paper"
              }`}
            >
              {complete ? (
                <Check className="h-3 w-3" />
              ) : active && !paused ? (
                <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
              ) : null}
            </span>
            <span
              className={`mt-2 text-[0.6875rem] leading-tight sm:text-[0.8125rem] ${active ? "font-medium text-ink" : complete ? "text-ink-2" : "text-muted"}`}
            >
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
