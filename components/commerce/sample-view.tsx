"use client";

import { useEffect, useState } from "react";
import type { BookView } from "@/lib/api";
import { api } from "@/lib/client";

interface SampleData {
  chapterTitle: string;
  pairs: { i: number; role: string; src: string; out: string | null }[];
}

const SHOWN = 5;

/** Amostra grátis: um trecho do começo do livro, original e tradução lado a lado. */
export function SampleView({ book }: { book: BookView }) {
  const [data, setData] = useState<SampleData | null>(null);
  const [all, setAll] = useState(false);
  const sample = book.preview;

  useEffect(() => {
    if (sample?.status !== "done") return setData(null);
    let alive = true;
    api<SampleData>(`/api/books/${book.id}/preview`)
      .then((d) => alive && setData(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [book.id, sample?.status, sample?.at]);

  if (!sample) return null;

  if (sample.status === "running")
    return (
      <div className="mt-7 rounded-2xl border border-rule px-5 py-5" aria-live="polite">
        <p className="serif text-[1.25rem] leading-tight text-ink">Preparando sua amostra…</p>
        <p className="mt-1.5 text-[0.875rem] text-ink-2">Um trecho do começo do livro. Leva de alguns segundos a um minuto.</p>
        <div className="mt-5 space-y-2.5" aria-hidden>
          <div className="h-3 w-11/12 animate-pulse rounded bg-paper-2" />
          <div className="h-3 w-full animate-pulse rounded bg-paper-2" />
          <div className="h-3 w-4/5 animate-pulse rounded bg-paper-2" />
        </div>
      </div>
    );

  if (sample.status === "error")
    return (
      <p className="mt-7 rounded-2xl bg-paper-2 px-5 py-4 text-[0.9375rem] text-ink-2">
        Não foi possível preparar a amostra agora. Você pode tentar de novo mais tarde — ou seguir com a tradução.
      </p>
    );

  if (!data) return null;
  return (
    <div className="mt-8">
      <p className="label">Amostra grátis</p>
      {data.chapterTitle && <p className="serif mt-1 text-[1.0625rem] text-ink-2 italic">{data.chapterTitle}</p>}
      <div className="mt-4 divide-y divide-rule overflow-hidden rounded-2xl border border-rule">
        {(all ? data.pairs : data.pairs.slice(0, SHOWN)).map((p) => (
          <div key={p.i} className="grid gap-2 px-4 py-4 sm:grid-cols-2 sm:gap-6 sm:px-5">
            <div
              lang={book.sourceLanguage ?? book.detectedLanguage ?? undefined}
              className={`text-[0.875rem] leading-relaxed text-muted ${p.role === "heading" ? "font-medium" : ""}`}
              dangerouslySetInnerHTML={{ __html: p.src }}
            />
            {p.out !== null && (
              <div
                lang={book.targetLanguage}
                className={`serif text-[1.0625rem] leading-relaxed text-ink ${p.role === "heading" ? "font-medium" : ""}`}
                dangerouslySetInnerHTML={{ __html: p.out }}
              />
            )}
          </div>
        ))}
      </div>
      {!all && data.pairs.length > SHOWN && (
        <button onClick={() => setAll(true)} className="link mt-3 block text-[0.875rem] text-ink-2 hover:text-ink">
          Ver o trecho todo ({data.pairs.length} parágrafos)
        </button>
      )}
      <p className="mt-3 text-[0.8125rem] leading-relaxed text-muted">Assim fica o seu livro. O trecho da amostra já entra na tradução completa.</p>
    </div>
  );
}
