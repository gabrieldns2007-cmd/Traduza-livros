"use client";

import { useState } from "react";
import type { BookView } from "@/lib/api";
import { chapterLabel, formatDuration, formatNumber } from "@/lib/format";
import { ProgressBar } from "@/components/ui/progress-bar";
import { Button } from "@/components/ui/button";

function headline(book: BookView): { title: string; sub?: string; detail?: string } {
  const activeIdx = book.chapters.map((c, i) => (book.activeChapterIds.includes(c.id) ? i : -1)).filter((i) => i >= 0);
  const first = activeIdx.length ? book.chapters[activeIdx[0]] : null;
  const firstTitle = first ? chapterLabel(first.title) : "";
  // o nome do capítulo só aparece se disser algo além do número
  const detail = first && !/^Capítulo [IVXLCDM\d]+$/i.test(firstTitle) ? firstTitle : undefined;
  switch (book.status) {
    case "queued":
      return book.queuePosition > 0
        ? { title: "Na fila.", sub: "Outro livro está sendo traduzido. Este começa logo em seguida." }
        : { title: "Estamos preparando sua tradução.", sub: "Só um instante." };
    case "analyzing":
      return { title: "Conhecendo o livro.", sub: "Personagens, lugares, tom e estilo — para manter tudo consistente até o fim." };
    case "translating": {
      if (book.percent >= 90) return { title: "Quase lá.", detail };
      if (!activeIdx.length) return { title: "Traduzindo…" };
      const nums = activeIdx.map((i) => i + 1);
      const title =
        nums.length === 1
          ? `Traduzindo o capítulo ${nums[0]}.`
          : `Traduzindo os capítulos ${nums.slice(0, -1).join(", ")} e ${nums[nums.length - 1]}.`;
      return { title, detail };
    }
    case "paused":
      return { title: "Tradução pausada.", sub: "Continue quando quiser, de onde parou." };
    case "error":
      return { title: "A tradução parou.", sub: book.error };
    default:
      return { title: "" };
  }
}

export function ProgressPanel({ book, onAction }: { book: BookView; onAction: (a: "pause" | "resume") => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const h = headline(book);
  const doneChapters = book.chapters.filter((c) => c.status === "done").length;
  const running = book.status === "queued" || book.status === "analyzing" || book.status === "translating";

  const run = async (a: "pause" | "resume") => {
    setBusy(true);
    try {
      await onAction(a);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-live="polite">
      <div className="flex items-end justify-between gap-6">
        <div className="min-w-0">
          <h2 className="serif text-[1.6rem] leading-tight tracking-[-0.015em] text-ink text-balance sm:text-[1.9rem]">{h.title}</h2>
          {h.detail && <p className="serif mt-1.5 truncate text-[1.0625rem] text-ink-2 italic">{h.detail}</p>}
          {h.sub && <p className={`mt-1.5 text-[0.9375rem] leading-snug ${book.status === "error" ? "text-accent" : "text-ink-2"}`}>{h.sub}</p>}
        </div>
        <p className="serif num shrink-0 text-[2.6rem] leading-none font-[350] tracking-[-0.03em] text-ink sm:text-[3.4rem]">
          {Math.floor(book.percent)}
          <span className="text-[0.5em] text-muted">%</span>
        </p>
      </div>

      <ProgressBar value={book.percent} active={running} className="mt-6" />

      <dl className="mt-6 grid grid-cols-3 gap-4 border-b border-rule pb-7">
        <div>
          <dt className="label">Palavras</dt>
          <dd className="serif num mt-1 text-[1.25rem] text-ink">{formatNumber(book.progress.translatedWords)}</dd>
          <dd className="num text-[0.8125rem] text-muted">de {formatNumber(book.totals.words)}</dd>
        </div>
        <div>
          <dt className="label">Faltam</dt>
          <dd className="serif num mt-1 text-[1.25rem] text-ink">{running ? formatDuration(book.eta) : "—"}</dd>
          <dd className="text-[0.8125rem] text-muted">{running ? "estimativa" : book.status === "paused" ? "em pausa" : "parado"}</dd>
        </div>
        <div>
          <dt className="label">Capítulos</dt>
          <dd className="serif num mt-1 text-[1.25rem] text-ink">{doneChapters}</dd>
          <dd className="num text-[0.8125rem] text-muted">de {book.chapters.length}</dd>
        </div>
      </dl>

      <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
        {running ? (
          <Button variant="secondary" onClick={() => run("pause")} disabled={busy} className="h-10 px-5 text-[0.875rem]">
            Pausar
          </Button>
        ) : (
          <Button onClick={() => run("resume")} disabled={busy}>
            {book.status === "error" ? "Tentar de novo" : "Continuar tradução"}
          </Button>
        )}
        {running && <p className="text-[0.8125rem] text-muted">Pode fechar esta página — a tradução continua no servidor.</p>}
      </div>

      {book.isDemo && (
        <p className="mt-6 rounded-xl bg-paper-2 px-4 py-3 text-[0.8125rem] leading-relaxed text-ink-2">
          <strong className="font-medium text-ink">Modo demonstração:</strong> o texto está sendo copiado sem tradução. Configure um provedor de IA
          para traduzir de verdade.
        </p>
      )}
    </section>
  );
}
