/** Barra de progresso fina, com brilho discreto enquanto está ativa. */
export function ProgressBar({
  value,
  active = false,
  thick = false,
  className = "",
}: {
  value: number;
  active?: boolean;
  /** barra mais grossa (acompanhamento do cliente) */
  thick?: boolean;
  className?: string;
}) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div
      className={`relative ${thick ? "h-2.5" : "h-[3px]"} w-full overflow-hidden rounded-full bg-rule ${className}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v)}
    >
      <div className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-700 ease-out" style={{ width: `${v}%` }}>
        {active && v > 2 && <div className="shimmer absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/45 to-transparent" />}
      </div>
    </div>
  );
}
