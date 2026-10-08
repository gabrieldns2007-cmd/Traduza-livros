"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { BookView } from "@/lib/api";
import { chapterLabel, formatDuration, formatNumber } from "@/lib/format";
import { ProgressBar } from "@/components/ui/progress-bar";
import { Button } from "@/components/ui/button";
import { ProviderPicker, type ProviderChoice } from "./provider-picker";
import { PUBLIC_MODE } from "@/lib/mode";

/** [102, 103, 104, 110, 111] → ["102 a 104", "110", "111"] */
function ranges(nums: number[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < nums.length;) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    if (j - i >= 2) out.push(`${nums[i]} a ${nums[j]}`);
    else for (let k = i; k <= j; k++) out.push(`${nums[k]}`);
    i = j + 1;
  }
  return out;
}

function seconds(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
}

/** O que está acontecendo agora, para a pessoa saber que não travou. */
function activityText(book: BookView, now: number | null): string | undefined {
  const a = book.activity;
  // o relógio só existe no navegador (evita diferença entre servidor e cliente)
  if (!a || now === null) return undefined;
  const name = book.provider?.id === "gemini" ? "Gemini" : (PROVIDER_LABEL[book.provider?.id ?? ""] ?? "serviço");
  if (a.kind === "waiting" && a.until) {
    return `Aguardando o limite por minuto do ${name}. Continua sozinho em ${seconds(Date.parse(a.until) - now)}.`;
  }
  const sent = `Pedido enviado ao ${name} há ${seconds(now - Date.parse(a.since))}.`;
  return a.chapters && a.chapters > 1
    ? `${sent} ${a.chapters} capítulos curtos vão juntos neste pedido; o progresso aparece quando ele responder.`
    : `${sent} O progresso aparece quando ele responder.`;
}

/** Hora atual, atualizada a cada segundo enquanto houver atividade. */
function useNow(ticking: boolean): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  return now;
}

function headline(book: BookView, now: number | null): { title: string; sub?: string; detail?: string } {
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
      const parts = ranges(activeIdx.map((i) => i + 1));
      const title =
        parts.length === 1 && !parts[0].includes(" ")
          ? `Traduzindo o capítulo ${parts[0]}.`
          : `Traduzindo os capítulos ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} e ${parts[parts.length - 1]}`}.`;
      return { title, detail, sub: activityText(book, now) };
    }
    case "paused":
      if (book.stopCode === "wallet")
        return { title: "Seus créditos acabaram.", sub: "O que já foi traduzido está salvo. Adicione créditos para continuar do mesmo ponto." };
      if (book.stopCode === "margin") return { title: "Tradução pausada para revisão.", sub: book.error };
      if (book.stopCode === "quota")
        return {
          title: "Limite gratuito atingido.",
          sub: "A tradução pode ser continuada quando a cota estiver disponível — ou agora, com outro serviço gratuito escolhido abaixo. Tudo está salvo.",
        };
      return book.stopCode === "credits"
        ? { title: "Tradução pausada: sem créditos.", sub: book.error }
        : { title: "Tradução pausada.", sub: book.error ?? "Continue quando quiser, de onde parou." };
    case "error":
      return { title: "A tradução parou.", sub: book.error };
    default:
      return { title: "" };
  }
}

const STATUS_TEXT: Record<string, string> = {
  queued: "Na fila",
  analyzing: "Preparando",
  translating: "Traduzindo",
  paused: "Pausado",
  done: "Concluído",
  error: "Erro",
  ready: "Não iniciado",
};

const PROVIDER_LABEL: Record<string, string> = {
  gemini: "Gemini Free",
  github: "GitHub Models",
  groq: "Groq",
  anthropic: "Anthropic",
  openai: "OpenAI",
  demo: "Demonstração",
};

export function ProgressPanel({
  book,
  onAction,
}: {
  book: BookView;
  onAction: (a: "pause" | "resume", extra?: { providerId?: string; confirmCost?: boolean; partial?: boolean }) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [choice, setChoice] = useState<ProviderChoice | null>(null);
  const now = useNow(Boolean(book.activity));
  const h = headline(book, now);
  const doneChapters = book.chapters.filter((c) => c.status === "done").length;
  const running = book.status === "queued" || book.status === "analyzing" || book.status === "translating";

  const run = async (a: "pause" | "resume") => {
    setBusy(true);
    setError("");
    try {
      await onAction(
        a,
        a === "resume" && choice ? { providerId: choice.providerId, confirmCost: choice.confirmCost, partial: choice.partial } : undefined,
      );
    } catch (err) {
      setError((err as Error).message);
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
          {h.sub && (
            <p className={`mt-1.5 text-[0.9375rem] leading-snug ${book.status === "error" || book.stopCode ? "text-accent" : "text-ink-2"}`}>
              {h.sub}
            </p>
          )}
          {book.status === "paused" && book.stopCode === "wallet" && (
            <Link href="/planos" className="link mt-2 inline-block text-[0.9375rem] text-ink">
              Ver planos e créditos
            </Link>
          )}
        </div>
        <p className="serif num shrink-0 text-[2.6rem] leading-none font-[350] tracking-[-0.03em] text-ink sm:text-[3.4rem]">
          {Math.floor(book.percent)}
          <span className="text-[0.5em] text-muted">%</span>
        </p>
      </div>

      <ProgressBar value={book.percent} active={running} className="mt-6" />

      <dl className="mt-6 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <div>
          <dt className="label">Provedor</dt>
          <dd className="mt-0.5 text-[0.9375rem] text-ink">{book.provider ? (PROVIDER_LABEL[book.provider.id] ?? book.provider.id) : "—"}</dd>
        </div>
        <div className="min-w-0">
          <dt className="label">Modelo</dt>
          <dd className="mt-0.5 truncate text-[0.9375rem] text-ink">{book.provider?.model ?? "—"}</dd>
        </div>
        <div>
          <dt className="label">Progresso</dt>
          <dd className="num mt-0.5 text-[0.9375rem] text-ink">
            {doneChapters} / {book.chapters.length} capítulos
          </dd>
        </div>
        <div>
          <dt className="label">Status</dt>
          <dd className={`mt-0.5 text-[0.9375rem] ${book.status === "error" ? "text-accent" : "text-ink"}`}>
            {STATUS_TEXT[book.status] ?? book.status}
          </dd>
        </div>
      </dl>

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

      {!running && (
        <div className="mt-7">
          <ProviderPicker bookId={book.id} onChange={setChoice} />
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
        {running ? (
          <Button variant="secondary" onClick={() => run("pause")} disabled={busy} className="h-10 px-5 text-[0.875rem]">
            Pausar
          </Button>
        ) : (
          <Button onClick={() => run("resume")} disabled={busy || !choice?.ready || !choice.creditsOk}>
            {busy ? "Continuando…" : "Continuar tradução"}
          </Button>
        )}
        {!running && book.resumeIndex >= 0 && (
          <p className="text-[0.8125rem] leading-snug text-muted">
            {book.doneChapters} de {book.chapters.length} capítulos salvos. Continua do capítulo {book.resumeIndex + 1}
            {book.chapters[book.resumeIndex].translatedSegments > 0 ? " (a partir do trecho onde parou)" : ""} — nada será traduzido de novo.
          </p>
        )}
        {running && (
          <p className="text-[0.8125rem] text-muted">
            {PUBLIC_MODE
              ? "Deixe o Verso aberto enquanto traduz. Se fechar, a tradução continua de onde parou quando você voltar."
              : "Pode fechar esta página — a tradução continua no servidor."}
          </p>
        )}
      </div>
      {error && (
        <p className="mt-3 text-[0.875rem] text-accent" role="alert">
          {error}
        </p>
      )}

      {book.isDemo && (
        <p className="mt-6 rounded-xl bg-paper-2 px-4 py-3 text-[0.8125rem] leading-relaxed text-ink-2">
          <strong className="font-medium text-ink">Modo demonstração:</strong> o texto está sendo copiado sem tradução. Configure um provedor de IA
          para traduzir de verdade.
        </p>
      )}
    </section>
  );
}
