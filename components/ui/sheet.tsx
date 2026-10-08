"use client";

import { useEffect, type ReactNode } from "react";
import { Close } from "./icons";

/**
 * Painel inferior (celular) / lateral (desktop). Não ocupa a tela inteira:
 * no celular sobe até ~78% da altura, com o conteúdo de trás ainda visível.
 */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={title}>
      <button aria-label="Fechar" className="fade-in absolute inset-0 bg-ink/25 backdrop-blur-[1px]" onClick={onClose} />
      <div className="sheet-in absolute inset-x-0 bottom-0 flex max-h-[78dvh] flex-col rounded-t-[1.25rem] bg-paper shadow-[0_-12px_40px_rgba(0,0,0,0.12)] sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-[24rem] sm:rounded-[1.25rem]">
        <div className="mx-auto mt-2.5 h-1 w-9 rounded-full bg-rule-strong sm:hidden" />
        <div className="flex items-center justify-between px-5 pt-3 pb-2">
          <span className="label">{title}</span>
          <button onClick={onClose} className="-mr-2 rounded-full p-2 text-muted hover:text-ink" aria-label="Fechar">
            <Close />
          </button>
        </div>
        <div className="pb-safe overflow-y-auto overscroll-contain px-2">{children}</div>
      </div>
    </div>
  );
}
