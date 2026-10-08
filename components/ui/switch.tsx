"use client";

export function Switch({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-start justify-between gap-6 py-1 text-left"
    >
      <span>
        <span className="block text-[0.9375rem] text-ink">{label}</span>
        {description && <span className="mt-0.5 block text-[0.8125rem] leading-snug text-muted">{description}</span>}
      </span>
      <span className={`relative mt-0.5 inline-flex h-6 w-10 shrink-0 rounded-full transition-colors ${checked ? "bg-ink" : "bg-rule-strong"}`}>
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-paper shadow-sm transition-transform duration-200 ${checked ? "translate-x-[1.125rem]" : "translate-x-0.5"}`}
        />
      </span>
    </button>
  );
}
