"use client";

import { useEffect, useState } from "react";
import type { BookView } from "@/lib/api";
import { api } from "@/lib/client";
import { LANGUAGES, languageLabel } from "@/lib/languages";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "@/components/ui/icons";
import { formatNumber } from "@/lib/format";
import { ProviderPicker, type ProviderChoice } from "./provider-picker";

interface PreviewData {
  chapterTitle: string;
  pairs: { i: number; role: string; src: string; out: string | null }[];
}

const SERVICE: Record<string, string> = { gemini: "Gemini", github: "GitHub Models", groq: "Groq", demo: "Demonstração" };

/**
 * Livro enviado e ainda não iniciado — passo 2: prévia grátis.
 * Um trecho do primeiro capítulo é traduzido para a pessoa avaliar antes de
 * gastar a cota no livro todo. O trecho fica salvo e conta no progresso.
 */
export function StartPanel({ book, onStarted }: { book: BookView; onStarted: (b: BookView) => void }) {
  const [source, setSource] = useState(book.sourceLanguage ?? "auto");
  const [target, setTarget] = useState(book.targetLanguage);
  const [busy, setBusy] = useState<"" | "preview" | "start">("");
  const [error, setError] = useState("");
  const [choice, setChoice] = useState<ProviderChoice | null>(null);
  const [data, setData] = useState<PreviewData | null>(null);
  const preview = book.preview;

  // carrega o trecho quando a prévia termina
  useEffect(() => {
    if (preview?.status !== "done") return setData(null);
    let alive = true;
    api<PreviewData>(`/api/books/${book.id}/preview`)
      .then((d) => alive && setData(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [book.id, preview?.status, preview?.at]);

  const send = async (action: "preview" | "start") => {
    setBusy(action);
    setError("");
    try {
      const { book: b } = await api<{ book: BookView }>(`/api/books/${book.id}/translate`, {
        method: "POST",
        json: {
          action,
          sourceLanguage: source,
          targetLanguage: target,
          providerId: choice?.providerId,
          confirmCost: choice?.confirmCost,
          partial: choice?.partial,
        },
      });
      if (b) onStarted(b);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  };

  const running = preview?.status === "running";
  const done = preview?.status === "done";

  return (
    <section className="rise">
      <p className="num text-[0.875rem] text-muted">
        {book.chapters.length} capítulos · {formatNumber(book.totals.words)} palavras
      </p>

      {/* ---------- prévia ---------- */}
      {running && (
        <div className="mt-7 rounded-2xl border border-rule px-5 py-5" aria-live="polite">
          <p className="serif text-[1.35rem] leading-tight text-ink">Traduzindo a prévia…</p>
          <p className="mt-1.5 text-[0.875rem] text-ink-2">
            {book.activity?.kind === "waiting"
              ? `Aguardando o limite por minuto do ${SERVICE[preview.provider.id] ?? "serviço"}. Continua sozinho.`
              : `Um trecho do começo do livro, com o ${SERVICE[preview.provider.id] ?? "serviço escolhido"}. Leva de alguns segundos a um minuto.`}
          </p>
          <div className="mt-5 space-y-2.5" aria-hidden>
            <div className="h-3 w-11/12 animate-pulse rounded bg-paper-2" />
            <div className="h-3 w-full animate-pulse rounded bg-paper-2" />
            <div className="h-3 w-4/5 animate-pulse rounded bg-paper-2" />
          </div>
        </div>
      )}

      {preview?.status === "error" && (
        <div className="mt-7 rounded-2xl bg-accent-soft/60 px-5 py-4">
          <p className="text-[0.9375rem] font-medium text-ink">A prévia não deu certo.</p>
          <p className="mt-1 text-[0.875rem] text-ink-2">{preview.error}</p>
        </div>
      )}

      {done && data && (
        <div className="mt-7">
          <div className="flex items-baseline justify-between gap-3">
            <p className="label">Prévia grátis</p>
            <p className="text-[0.75rem] text-muted">
              {SERVICE[preview.provider.id] ?? preview.provider.id} · {preview.provider.model}
            </p>
          </div>
          {data.chapterTitle && <p className="serif mt-1 text-[1.0625rem] text-ink-2 italic">{data.chapterTitle}</p>}
          <div className="mt-4 divide-y divide-rule overflow-hidden rounded-2xl border border-rule">
            {data.pairs.map((p) => (
              <div key={p.i} className="grid gap-2 px-4 py-4 sm:grid-cols-2 sm:gap-6 sm:px-5">
                <div
                  lang={book.sourceLanguage ?? book.detectedLanguage ?? undefined}
                  className={`text-[0.875rem] leading-relaxed text-muted ${p.role === "heading" ? "font-medium" : ""}`}
                  dangerouslySetInnerHTML={{ __html: p.src }}
                />
                {p.out !== null ? (
                  <div
                    lang={book.targetLanguage}
                    className={`serif text-[1.0625rem] leading-relaxed text-ink ${p.role === "heading" ? "font-medium" : ""}`}
                    dangerouslySetInnerHTML={{ __html: p.out }}
                  />
                ) : (
                  <p className="text-[0.875rem] text-accent">Este trecho não foi traduzido.</p>
                )}
              </div>
            ))}
          </div>
          <p className="mt-3 text-[0.8125rem] leading-relaxed text-muted">
            Este trecho já fica salvo e não será traduzido de novo. Gostou? Traduza o livro todo — ou refaça a prévia com outro serviço.
          </p>
        </div>
      )}

      {/* ---------- idiomas ---------- */}
      <div className="mt-8 grid gap-7 sm:grid-cols-[1fr_auto_1fr] sm:items-end sm:gap-5">
        <Select
          label="Idioma original"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          hint={book.detectedLanguage ? `Detectamos: ${languageLabel(book.detectedLanguage)}` : undefined}
        >
          <option value="auto">Detectar automaticamente</option>
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </Select>
        <ArrowRight className="mx-auto hidden h-5 w-5 text-muted sm:mb-3 sm:block" />
        <Select label="Traduzir para" value={target} onChange={(e) => setTarget(e.target.value)} hint={book.detectedLanguage ? " " : undefined}>
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </Select>
      </div>

      <div className="mt-8">
        <ProviderPicker bookId={book.id} onChange={setChoice} />
      </div>

      {/* ---------- ações ---------- */}
      <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
        {done ? (
          <>
            <Button onClick={() => send("start")} disabled={!!busy || running || !choice?.ready || !choice.creditsOk} className="w-full sm:w-auto">
              {busy === "start" ? "Começando…" : "Traduzir o livro todo"} {busy !== "start" && <ArrowRight />}
            </Button>
            <button
              onClick={() => send("preview")}
              disabled={!!busy || running || !choice?.ready}
              className="link py-2 text-center text-[0.875rem] text-ink-2 hover:text-ink disabled:opacity-50 sm:text-left"
            >
              {busy === "preview" ? "Pedindo…" : "Refazer a prévia"}
            </button>
          </>
        ) : (
          <>
            <Button onClick={() => send("preview")} disabled={!!busy || running || !choice?.ready} className="w-full sm:w-auto">
              {busy === "preview"
                ? "Pedindo…"
                : running
                  ? "Traduzindo a prévia…"
                  : preview?.status === "error"
                    ? "Tentar a prévia de novo"
                    : "Ver prévia grátis"}
              {!busy && !running && <ArrowRight />}
            </Button>
            <button
              onClick={() => send("start")}
              disabled={!!busy || running || !choice?.ready || !choice.creditsOk}
              className="link py-2 text-center text-[0.875rem] text-ink-2 hover:text-ink disabled:opacity-50 sm:text-left"
            >
              {busy === "start" ? "Começando…" : "Pular a prévia e traduzir tudo"}
            </button>
          </>
        )}
      </div>
      {!done && !running && (
        <p className="mt-3 text-[0.8125rem] leading-relaxed text-muted">
          A prévia traduz só um trecho do começo do livro (um pedido) para você avaliar a qualidade antes de usar a cota no livro todo.
        </p>
      )}
      {error && <p className="mt-4 text-[0.9375rem] text-accent">{error}</p>}
    </section>
  );
}
