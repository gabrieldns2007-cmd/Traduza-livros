/** Ícones de traço fino, desenhados para combinar com a tipografia. */
type P = { className?: string };
const s = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export const ArrowRight = ({ className = "h-4 w-4" }: P) => (
  <svg viewBox="0 0 20 20" className={className} aria-hidden {...s}>
    <path d="M4 10h12M11 5l5 5-5 5" />
  </svg>
);
export const ArrowLeft = ({ className = "h-4 w-4" }: P) => (
  <svg viewBox="0 0 20 20" className={className} aria-hidden {...s}>
    <path d="M16 10H4M9 5l-5 5 5 5" />
  </svg>
);
export const Check = ({ className = "h-4 w-4" }: P) => (
  <svg viewBox="0 0 20 20" className={className} aria-hidden {...s}>
    <path d="M4.5 10.5l3.5 3.5 7.5-8" />
  </svg>
);
export const Chevron = ({ className = "h-4 w-4" }: P) => (
  <svg viewBox="0 0 20 20" className={className} aria-hidden {...s}>
    <path d="M5.5 8l4.5 4.5L14.5 8" />
  </svg>
);
export const Plus = ({ className = "h-4 w-4" }: P) => (
  <svg viewBox="0 0 20 20" className={className} aria-hidden {...s}>
    <path d="M10 4.5v11M4.5 10h11" />
  </svg>
);
export const Close = ({ className = "h-4 w-4" }: P) => (
  <svg viewBox="0 0 20 20" className={className} aria-hidden {...s}>
    <path d="M5 5l10 10M15 5L5 15" />
  </svg>
);
export const Contents = ({ className = "h-5 w-5" }: P) => (
  <svg viewBox="0 0 20 20" className={className} aria-hidden {...s}>
    <path d="M3.5 5.5h1M7.5 5.5h9M3.5 10h1M7.5 10h9M3.5 14.5h1M7.5 14.5h9" />
  </svg>
);
export const Pencil = ({ className = "h-4 w-4" }: P) => (
  <svg viewBox="0 0 20 20" className={className} aria-hidden {...s}>
    <path d="M12.5 4.5l3 3L7 16H4v-3z" />
  </svg>
);
export const Download = ({ className = "h-4 w-4" }: P) => (
  <svg viewBox="0 0 20 20" className={className} aria-hidden {...s}>
    <path d="M10 3.5v9M6 9l4 4 4-4M4 16.5h12" />
  </svg>
);
export const Dots = ({ className = "h-5 w-5" }: P) => (
  <svg viewBox="0 0 20 20" className={className} aria-hidden fill="currentColor">
    <circle cx="5" cy="10" r="1.3" />
    <circle cx="10" cy="10" r="1.3" />
    <circle cx="15" cy="10" r="1.3" />
  </svg>
);
export const Columns = ({ className = "h-4 w-4" }: P) => (
  <svg viewBox="0 0 20 20" className={className} aria-hidden {...s}>
    <path d="M3.5 4.5h5.5v11H3.5zM11 4.5h5.5v11H11z" />
  </svg>
);
