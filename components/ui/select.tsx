import type { ComponentProps } from "react";
import { Chevron } from "./icons";

/** Select nativo (ótimo no celular), com aparência editorial: só uma linha embaixo. */
export function Select({ label, hint, className = "", children, ...props }: ComponentProps<"select"> & { label: string; hint?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="label">{label}</span>
      <span className="relative mt-1.5 block">
        <select
          className="serif w-full appearance-none truncate border-b border-rule-strong bg-transparent py-2 pr-8 text-[1.3rem] leading-tight text-ink transition-colors outline-none hover:border-ink focus:border-ink disabled:opacity-50"
          {...props}
        >
          {children}
        </select>
        <Chevron className="pointer-events-none absolute top-1/2 right-0.5 h-4 w-4 -translate-y-1/2 text-muted" />
      </span>
      {hint && <span className="mt-1.5 block text-[0.8125rem] text-muted">{hint}</span>}
    </label>
  );
}
