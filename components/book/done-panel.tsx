"use client";

import { useState } from "react";
import Link from "next/link";
import type { BookView } from "@/lib/api";
import { api } from "@/lib/client";
import { languageLabel } from "@/lib/languages";
import { ButtonLink } from "@/components/ui/button";
import { ArrowRight, Download } from "@/components/ui/icons";

export function DonePanel({ book, onChange, onRetry }: { book: BookView; onChange: (b: BookView) => void; onRetry: () => Promise<void> }) {
  const failed = book.chapters.reduce((s, c) => s + c.failedSegments, 0);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(book.translatedTitle || book.title);
  const [pdfState, setPdfState] = useState<"idle" | "loading" | "error">("idle");
  const [pdfError, setPdfError] = useState("");

  const saveTitle = async () => {
    const { book: b } = await api<{ book: BookView }>(`/api/books/${book.id}`, { method: "PATCH", json: { translatedTitle: title } });
    onChange(b);
    setEditing(false);
  };

  // o PDF leva alguns segundos para ser gerado: mostra o andamento e trata erros
  const downloadPdf = async () => {
    setPdfState("loading");
    setPdfError("");
    try {
      const res = await fetch(`/api/books/${book.id}/export/pdf`);
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Não foi possível gerar o PDF.");
      const blob = await res.blob();
      const name = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get("content-disposition") ?? "")?.[1];
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name ? decodeURIComponent(name) : "livro.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setPdfState("idle");
    } catch (err) {
      setPdfError((err as Error).message);
      setPdfState("error");
    }
  };

  return (
    <section className="rise">
      <h2 className="serif text-[1.9rem] leading-tight tracking-[-0.02em] text-ink sm:text-[2.2rem]">
        Seu livro está pronto<span className="text-accent">.</span>
      </h2>

      <div className="mt-7 border-y border-rule py-6">
        {editing ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="block flex-1">
              <span className="label">Título da tradução</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="serif mt-1.5 w-full border-b border-ink bg-transparent py-1.5 text-[1.4rem] text-ink outline-none"
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && saveTitle()}
              />
            </label>
            <div className="flex gap-2">
              <button onClick={saveTitle} className="rounded-full bg-ink px-4 py-2 text-[0.875rem] text-paper">
                Salvar
              </button>
              <button onClick={() => setEditing(false)} className="px-3 py-2 text-[0.875rem] text-muted">
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="serif text-[1.45rem] leading-snug text-ink">{book.translatedTitle || book.title}</p>
              <p className="mt-0.5 text-[0.9375rem] text-ink-2">{languageLabel(book.targetLanguage)}</p>
            </div>
            <button onClick={() => setEditing(true)} className="link shrink-0 text-[0.8125rem] text-muted hover:text-ink">
              Editar título
            </button>
          </div>
        )}
      </div>

      <div className="mt-7 flex flex-col gap-3 sm:flex-row">
        <ButtonLink href={`/api/books/${book.id}/export/epub`} download className="w-full sm:w-auto">
          <Download /> Baixar EPUB
        </ButtonLink>
        <button
          onClick={downloadPdf}
          disabled={pdfState === "loading"}
          className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full border border-rule-strong px-7 text-[0.9375rem] font-medium text-ink transition-colors hover:border-ink disabled:opacity-60 sm:w-auto"
        >
          <Download /> {pdfState === "loading" ? "Gerando PDF…" : "Baixar PDF"}
        </button>
      </div>
      {pdfState === "error" && <p className="mt-3 text-[0.875rem] text-accent">{pdfError}</p>}

      <Link href={`/livros/${book.id}/revisar/1`} className="group mt-7 inline-flex items-center gap-2 text-[1rem] text-ink">
        <span className="serif text-[1.15rem] italic">Revisar tradução</span>
        <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
      </Link>

      {failed > 0 && (
        <div className="mt-7 rounded-xl bg-accent-soft/60 px-4 py-3 text-[0.875rem] leading-relaxed text-ink-2">
          {failed === 1 ? "Um trecho não pôde ser traduzido" : `${failed} trechos não puderam ser traduzidos`} e {failed === 1 ? "ficou" : "ficaram"}{" "}
          no idioma original.{" "}
          <button onClick={onRetry} className="link font-medium text-ink">
            Tentar novamente
          </button>
        </div>
      )}

      <p className="mt-8 text-[0.8125rem] leading-relaxed text-muted">
        <span className="text-ink-2">Para ler no Kindle:</span> envie o EPUB pelo app Kindle no celular (Compartilhar → Kindle) ou em{" "}
        <a href="https://www.amazon.com/sendtokindle" target="_blank" rel="noreferrer" className="link">
          amazon.com/sendtokindle
        </a>
        . O arquivo funciona também no Apple Books, Kobo e Google Play Livros.
      </p>
    </section>
  );
}
