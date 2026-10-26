"use client";

import { useEffect, useState } from "react";
import type { BookView } from "@/lib/api";
import { api } from "@/lib/client";
import { brl } from "@/lib/money";
import { formatNumber } from "@/lib/format";
import { whenBack } from "@/lib/quota-format";
import { ProgressBar } from "@/components/ui/progress-bar";
import { StageTrack } from "@/components/ui/stage-track";
import { Button } from "@/components/ui/button";
import { Check } from "@/components/ui/icons";
import type { Offer } from "./order-panel";

/** Etapa atual: 0 Livro · 1 Processando · 2 Traduzindo · 3 Revisando · 4 Pronto. */
export function stageOf(book: BookView): number {
  if (book.status === "done") return 4;
  if (book.status === "translating" && book.review && !book.review.finishedAt) return 3;
  if (book.status === "translating") return 2;
  if (book.status === "queued" || book.status === "analyzing") return 1;
  return book.progress.translatedWords > 0 ? 2 : 1;
}

/** É a tradução Grátis (livros antigos sem tipo: pelo pedido)? */
export function isFreeBook(book: Pick<BookView, "level" | "order">): boolean {
  return (book.level ?? book.order?.level) === "padrao";
}

/** Quando continua: “hoje às 14:05”, “amanhã às 04:00”, “em 21/10, 04:00” — ou “em instantes”, se já passou da hora. */
function whenText(iso: string, now: number): string {
  if (Date.parse(iso) <= now) return "em instantes";
  const w = whenBack(iso, now);
  return /^(hoje|amanhã)/.test(w) ? w : `em ${w}`;
}

function headline(book: BookView, stage: number, now: number | null): { title: string; sub?: string } {
  const free = isFreeBook(book);
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
      // Grátis à espera dos serviços gratuitos: diz quando vamos tentar de novo — nunca promete que vai dar certo
      if (free && (book.stopCode === "waiting" || book.stopCode === "unavailable")) {
        const when = book.stopCode === "waiting" && book.resumeAt && now !== null ? whenText(book.resumeAt, now) : null;
        return {
          title: "Sua tradução está aguardando.",
          sub: `A tradução grátis está aguardando os serviços gratuitos ficarem disponíveis. ${
            when ? `Vamos tentar de novo ${when}.` : "Vamos tentar de novo sozinhos, em breve."
          } Todo o progresso está salvo.`,
        };
      }
      if (book.stopCode === "waiting")
        return {
          title: "Sua tradução está na fila.",
          sub: `Ela continua sozinha ${book.resumeAt && now !== null ? whenText(book.resumeAt, now) : "em breve"}. Você não precisa fazer nada.`,
        };
      if (book.stopCode === "unavailable")
        return {
          title: "Tradução pausada por um instante.",
          sub: "Tudo o que já foi traduzido está salvo. Toque em Continuar para seguir do mesmo ponto.",
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
 * Grátis à espera: a Literária para o que falta, se ela estiver à venda (e der
 * para pagar). Só informa o valor — a troca passa pelo pedido, com confirmação.
 */
function useUpgradeOffer(book: BookView, enabled: boolean) {
  const [offer, setOffer] = useState<{ words: number; priceBrl: number; beta: boolean } | null>(null);
  const translated = book.progress.translatedWords;
  useEffect(() => {
    if (!enabled) return setOffer(null);
    let alive = true;
    api<{ offer: Offer }>(`/api/books/${book.id}/offer`)
      .then(({ offer: o }) => {
        if (!alive) return;
        const paid = o.levels.find((l) => !l.free && l.available);
        const canPay = o.checkout.mode === "beta" || o.checkout.payments;
        setOffer(paid && canPay && paid.words > 0 ? { words: paid.words, priceBrl: paid.priceBrl, beta: o.checkout.mode === "beta" } : null);
      })
      .catch(() => alive && setOffer(null));
    return () => {
      alive = false;
    };
  }, [book.id, enabled, translated]);
  return offer;
}

/**
 * Acompanhamento do cliente depois da compra: em que etapa está, quanto falta
 * e em que capítulo — sem nada técnico. Pode fechar a página: a tradução
 * continua no servidor e o progresso está aqui quando voltar.
 *
 * Grátis à espera dos serviços gratuitos: diz quando continua (se soubermos) e,
 * se a Literária estiver à venda, oferece — sem pressa e com o mesmo peso de
 * “Tentar agora” — traduzir o restante nela (`onUpgrade` abre o pedido).
 */
export function OrderProgress({ book, onResume, onUpgrade }: { book: BookView; onResume: () => Promise<void>; onUpgrade?: () => void }) {
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
  const freeWaiting = book.status === "paused" && isFreeBook(book) && (book.stopCode === "waiting" || book.stopCode === "unavailable");
  const upgrade = useUpgradeOffer(book, freeWaiting && Boolean(onUpgrade));

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
          {order.payment === "free"
            ? "Tradução grátis confirmada"
            : order.payment === "beta"
              ? "Pedido confirmado · grátis durante o beta"
              : `Pagamento confirmado · ${brl(order.priceBrl)}`}
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
          {/* Grátis à espera: ela segue sozinha, então “Tentar agora” não é a ação principal */}
          <Button onClick={resume} disabled={busy} variant={freeWaiting ? "secondary" : "primary"} className="w-full sm:w-auto">
            {busy ? "Continuando…" : book.stopCode === "waiting" || freeWaiting ? "Tentar agora" : "Continuar tradução"}
          </Button>
          {error && (
            <p className="mt-3 text-[0.875rem] text-accent" role="alert">
              {error}
            </p>
          )}
          {freeWaiting && upgrade && onUpgrade && (
            <div className="mt-6 border-t border-rule pt-5">
              <p className="text-[0.9375rem] font-medium text-ink">Prefere não esperar?</p>
              <p className="mt-1 text-[0.875rem] leading-relaxed text-ink-2">
                {upgrade.beta
                  ? `A tradução Literária traduz as ${formatNumber(upgrade.words)} palavras que faltam, sem custo durante o beta.`
                  : `A tradução Literária, paga, traduz as ${formatNumber(upgrade.words)} palavras que faltam por ${brl(upgrade.priceBrl)}.`}{" "}
                O que já foi traduzido fica como está. Você confere tudo antes de confirmar.
              </p>
              {/* rótulo longo: quebra em duas linhas numa tela estreita (320 px), em vez de vazar do botão */}
              <Button variant="secondary" onClick={onUpgrade} className="mt-4 min-h-12 w-full !h-auto py-3 text-center !whitespace-normal sm:w-auto">
                Traduzir o restante na Literária
              </Button>
            </div>
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
