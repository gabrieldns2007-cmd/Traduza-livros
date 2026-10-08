"use client";

import { useLinkStatus } from "next/link";

/** Indicador mínimo dentro de um <Link>: aparece no instante do toque, enquanto a página abre. */
export function LinkPending({ className = "" }: { className?: string }) {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden
      className={`inline-block h-1.5 w-1.5 rounded-full bg-accent transition-opacity duration-150 ${pending ? "pulse-dot opacity-100" : "opacity-0"} ${className}`}
    />
  );
}
