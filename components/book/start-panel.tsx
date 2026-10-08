"use client";

import { useState } from "react";
import type { BookView } from "@/lib/api";
import { api } from "@/lib/client";
import { LANGUAGES, languageLabel } from "@/lib/languages";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "@/components/ui/icons";
import { formatNumber } from "@/lib/format";

/** Livro enviado mas ainda não iniciado. */
export function StartPanel({ book, onStarted }: { book: BookView; onStarted: (b: BookView) => void }) {
  const [source, setSource] = useState(book.sourceLanguage ?? "auto");
  const [target, setTarget] = useState(book.targetLanguage);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const start = async () => {
    setBusy(true);
    setError("");
    try {
      const { book: b } = await api<{ book: BookView }>(`/api/books/${book.id}/translate`, {
        method: "POST",
        json: { action: "start", sourceLanguage: source, targetLanguage: target },
      });
      onStarted(b);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rise">
      <p className="num text-[0.875rem] text-muted">
        {book.chapters.length} capítulos · {formatNumber(book.totals.words)} palavras
      </p>
      <div className="mt-7 grid gap-7 sm:grid-cols-[1fr_auto_1fr] sm:items-end sm:gap-5">
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
      <Button onClick={start} disabled={busy} className="mt-9 w-full sm:w-auto">
        {busy ? "Começando…" : "Começar tradução"} {!busy && <ArrowRight />}
      </Button>
      {error && <p className="mt-4 text-[0.9375rem] text-accent">{error}</p>}
    </section>
  );
}
