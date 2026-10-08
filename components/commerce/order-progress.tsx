"use client";

import { useEffect, useState } from "react";
import type { BookView } from "@/lib/api";
import { brl } from "@/lib/money";
import { whenBack } from "@/lib/quota-format";
import { ProgressBar } from "@/components/ui/progress-bar";
import { StageTrack } from "@/components/ui/stage-track";
import { Button } from "@/components/ui/button";
import { Check } from "@/components/ui/icons";

/** Etapa atual: 0 Livro · 1 Processando · 2 Traduzindo · 3 Revisando · 4 Pronto. */
export function stageOf(book: BookView): number {
  if (book.status === "done") return 4;
  if (book.status === "translating" && book.review && !book.review.finishedAt) return 3;
  if (book.status === "translating") return 2;
  if (book.status === "queued" || book.status === "analyzing") return 1;
  return book.progress.translatedWords > 0 ? 2 : 1;
}

function headline(book: BookView, stage: number, now: number | null): { title: string; sub?: string } {
  switch (book.status) {
    case "queued":
      return book.queuePosition > 0
        ? { title: "Sua tradução está na fila.", sub: "Ela começa assim que o livro anterior terminar." }
        : { title: "Estamos preparando sua tradução." };
    case "analyzing":
      return { title: "Estamos preparando sua tradução.", sub: "Lendo o livro para manter nomes, termos e estilo iguais do começo ao fim." };
    case "translating":
      return stage === 3
        ? { title: "Revisando sua tradução.", sub: "Conferindo se todos os trechos foram traduzidos." }
        : { title: "Seu livro está sendo traduzido." };
    case "paused":
      if (book.stopCode === "waiting")
        return {
          title: "Sua tradução está na fila.",
          sub: `Ela continua sozinha ${book.resumeAt && now !== null ? whenBack(book.resumeAt, now) : "em breve"}. Você não precisa fazer nada.`,
        };
      if (book.stopCode === "unavailable")
        return {
          title: "Tradução pausada por um instante.",
          sub: "Ela continua do mesmo ponto assim que possível. Tudo o que já foi traduzido está salvo.",
        };
      return { title: "Tradução pausada.", sub: "Tudo o que já foi traduzido está salvo. Toque em Continuar para seguir do mesmo ponto." };
    case "error":
      return { title: "A tradução parou.", sub: "Tudo o que já foi traduzido está salvo. Toque em Continuar para tentar de novo." };
    default:
      return { title: "" };
  }
}

function remaining(eta: number | null): string | null {
  if (eta == null) return null;
  if (eta < 60) return "Falta menos de 1 minuto.";
  const min = Math.round(eta / 60);
  if (min < 60) return `Faltam cerca de ${min} min.`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `Faltam cerca de ${h} h${m ? ` ${m} min` : ""}.`;
}

/** Hora atual só no navegador (evita diferença entre servidor e cliente). */
function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * Acompanhamento do cliente depois da compra: em que etapa está, quanto falta
 * e em que capítulo — sem nada técnico. Pode fechar a página: a tradução
 * continua no servidor e o progresso está aqui quando voltar.
 */
export function OrderProgress({ book, onResume }: { book: BookView; onResume: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const now = useNow();
  const stage = stageOf(book);
  const h = headline(book, stage, now);
  const running = book.status === "queued" || book.status === "analyzing" || book.status === "translating";
  const stopped = book.status === "paused" || book.status === "error";
  const total = book.chapters.length;
  const activeIdx = book.chapters.findIndex((c) => book.activeChapterIds.includes(c.id));
  const chapter = activeIdx >= 0 ? activeIdx + 1 : book.resumeIndex >= 0 ? book.resumeIndex + 1 : total;
  const showChapter = stage >= 2 && total > 1;
  const order = book.order?.status === "paid" ? book.order : null;
  const eta = running && stage === 2 ? remaining(book.eta) : null;

  const resume = async () => {
    setBusy(true);
    setError("");
    try {
      await onResume();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-live="polite">
      {order && (
        <p className="mb-6 flex items-center gap-2 text-[0.875rem] text-ink-2">
          <Check className="h-4 w-4 text-ok" />
          {order.payment === "beta" ? "Pedido confirmado · grátis durante o beta" : `Pagamento confirmado · ${brl(order.priceBrl)}`}
        </p>
      )}

      <StageTrack current={stage} paused={stopped} />

      <div className="mt-8 rounded-[1.25rem] border border-rule px-5 py-6 sm:px-7">
        <h2 className="serif text-[1.6rem] leading-tight tracking-[-0.015em] text-ink text-balance sm:text-[1.9rem]">{h.title}</h2>
        {h.sub && <p className="mt-1.5 text-[0.9375rem] leading-snug text-ink-2">{h.sub}</p>}

        <div className="mt-6 flex items-end justify-between gap-4">
          <p className="serif num text-[3.25rem] leading-none font-[350] tracking-[-0.03em] text-ink">
            {Math.floor(book.percent)}
            <span className="text-[0.5em] text-muted">%</span>
          </p>
          {showChapter && (
            <p className="num pb-1 text-right text-[0.9375rem] text-ink-2">
              Capítulo {Math.min(chapter, total)} de {total}
            </p>
          )}
        </div>
        <ProgressBar value={book.percent} active={running} thick className="mt-4" />
        {eta && <p className="mt-3 text-[0.875rem] text-muted">{eta}</p>}
      </div>

      {stopped ? (
        <div className="mt-6">
          <Button onClick={resume} disabled={busy} className="w-full sm:w-auto">
            {busy ? "Continuando…" : book.stopCode === "waiting" ? "Tentar agora" : "Continuar tradução"}
          </Button>
          {error && (
            <p className="mt-3 text-[0.875rem] text-accent" role="alert">
              {error}
            </p>
          )}
        </div>
      ) : (
        <p className="mt-5 text-[0.875rem] leading-relaxed text-muted">
          Pode fechar esta página: a tradução continua sem você. Volte quando quiser para acompanhar ou baixar o livro.
        </p>
      )}
    </section>
  );
}
