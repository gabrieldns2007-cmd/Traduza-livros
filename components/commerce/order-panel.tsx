"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { BookView } from "@/lib/api";
import { api } from "@/lib/client";
import { LANGUAGES, languageLabel } from "@/lib/languages";
import { formatNumber } from "@/lib/format";
import { brl } from "@/lib/money";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ArrowRight, Check, Chevron, Pencil } from "@/components/ui/icons";
import { SampleView } from "./sample-view";

export interface Offer {
  title: string;
  author?: string;
  sourceLanguage: string | null;
  detectedLanguage: string | null;
  targetLanguage: string;
  words: number;
  totalWords: number;
  chapters: number;
  levels: { id: "padrao" | "literaria"; label: string; description: string; priceBrl: number; available: boolean }[];
  order: { id: string; level: string; priceBrl: number; status: string; words: number; payment: "beta" | "provider" | null; paidAt?: string } | null;
  checkout: { mode: "beta" | "live"; payments: boolean };
}

/** O que a nova edição traz — escrito como resultado. */
export const INCLUDED = [
  "O livro inteiro traduzido",
  "Capítulos e sumário organizados",
  "A formatação do original",
  "EPUB para leitores digitais",
  "PDF com cara de livro",
  "Revisão online, parágrafo a parágrafo",
  "Arquivos para baixar quando quiser",
];

/**
 * Passo “Confirmar”: o livro está pronto para ser traduzido. A pessoa confere
 * idiomas, escolhe o tipo de tradução (já com o valor), pode ler uma amostra
 * grátis, vê o que a nova edição traz e toca em “Começar tradução” — com o
 * valor no próprio botão. Nada técnico aparece aqui.
 */
export function OrderPanel({ book, onChange }: { book: BookView; onChange: (b: BookView) => void }) {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [level, setLevel] = useState<"padrao" | "literaria">("padrao");
  const [source, setSource] = useState(book.sourceLanguage ?? "auto");
  const [target, setTarget] = useState(book.targetLanguage);
  const [editLangs, setEditLangs] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [dialogueStyle, setDialogueStyle] = useState(book.options.dialogueStyle);
  const [instructions, setInstructions] = useState(book.options.instructions ?? "");
  const [busy, setBusy] = useState<"" | "order" | "sample">("");
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    api<{ offer: Offer }>(`/api/books/${book.id}/offer`)
      .then(({ offer: o }) => {
        if (!alive) return;
        setOffer(o);
        if (o.order?.level === "literaria" && o.levels.find((l) => l.id === "literaria")?.available) setLevel("literaria");
      })
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [book.id]);

  const setup = { sourceLanguage: source, targetLanguage: target, options: { dialogueStyle, instructions } };

  // um toque: trava o preço no pedido e confirma. No beta a tradução começa na hora;
  // com pagamentos, vai para a página do meio de pagamento.
  const order = async () => {
    setBusy("order");
    setError("");
    try {
      await api(`/api/books/${book.id}/order`, { method: "POST", json: { level, ...setup } });
      const r = await api<{ started: boolean; checkoutUrl?: string; book: BookView }>(`/api/books/${book.id}/order/confirm`, { method: "POST" });
      if (r.checkoutUrl) {
        window.location.href = r.checkoutUrl;
        return;
      }
      onChange(r.book);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setError((err as Error).message);
      setBusy("");
    }
  };

  const sample = async () => {
    setBusy("sample");
    setError("");
    try {
      const { book: b } = await api<{ book: BookView }>(`/api/books/${book.id}/translate`, { method: "POST", json: { action: "preview", ...setup } });
      if (b) onChange(b);
      requestAnimationFrame(() => document.getElementById("amostra")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  };

  if (!offer) {
    if (error) return <p className="text-[0.9375rem] text-accent">{error}</p>;
    return <div className="h-72 animate-pulse rounded-[1.25rem] bg-paper-2" aria-label="Carregando" />;
  }

  const chosen = offer.levels.find((l) => l.id === level) ?? offer.levels[0];
  const beta = offer.checkout.mode === "beta";
  const canPay = beta || offer.checkout.payments;
  const sampleState = book.preview?.status;
  const detected = offer.detectedLanguage;
  const sourceLabel = source === "auto" ? languageLabel(detected, "Idioma original") : languageLabel(source);

  return (
    <section className="rise">
      <h2 className="serif text-[1.75rem] leading-tight tracking-[-0.015em] text-ink text-balance sm:text-[2rem]">
        Tudo pronto para a sua nova edição.
      </h2>

      {/* ---------- o livro ---------- */}
      <div className="mt-6 rounded-[1.25rem] border border-rule px-5 py-5 sm:px-6">
        <p className="serif text-[1.25rem] leading-snug text-ink">{offer.title}</p>
        {offer.author && <p className="serif text-[1rem] text-ink-2 italic">{offer.author}</p>}
        <div className="mt-4 flex items-center justify-between gap-4 border-t border-rule pt-3">
          <p className="min-w-0 text-[0.9375rem] text-ink">
            {sourceLabel} <span className="text-muted">→</span> {languageLabel(target)}
          </p>
          <button
            type="button"
            onClick={() => setEditLangs((v) => !v)}
            aria-expanded={editLangs}
            className={`relative inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[0.8125rem] font-medium transition-[background-color,border-color,color,transform] duration-200 ease-out before:absolute before:-inset-1 before:content-[''] active:scale-[0.96] ${
              editLangs
                ? "border-ink bg-ink text-paper hover:bg-ink/88"
                : "border-rule-strong text-ink-2 hover:border-ink hover:bg-paper-2 hover:text-ink active:bg-paper-3"
            }`}
          >
            {editLangs ? <Check className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
            {editLangs ? "Pronto" : "Alterar"}
          </button>
        </div>
        {editLangs && (
          <div className="rise mt-4 grid gap-5 sm:grid-cols-2">
            <Select
              label="Idioma do livro"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              hint={detected ? `Detectamos: ${languageLabel(detected)}` : undefined}
            >
              <option value="auto">Detectar automaticamente</option>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </Select>
            <Select label="Traduzir para" value={target} onChange={(e) => setTarget(e.target.value)} hint={detected ? " " : undefined}>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </Select>
          </div>
        )}
        <p className="num mt-2 text-[0.875rem] text-muted">
          {formatNumber(offer.words)} palavras{offer.words < offer.totalWords ? " a traduzir" : ""} · {offer.chapters} capítulos
        </p>
      </div>

      {/* ---------- tipo de tradução ---------- */}
      <p className="label mt-8">Escolha a tradução</p>
      <div className="mt-3 space-y-2.5" role="radiogroup" aria-label="Tipo de tradução">
        {offer.levels.map((l) => {
          const sel = l.id === level;
          return (
            <button
              key={l.id}
              type="button"
              role="radio"
              aria-checked={sel}
              disabled={!l.available}
              onClick={() => setLevel(l.id)}
              className={`flex w-full items-start gap-3.5 rounded-[1.25rem] border px-4 py-4 text-left transition-[background-color,border-color,box-shadow,transform] duration-200 ease-out disabled:cursor-not-allowed sm:px-5 ${
                sel
                  ? "border-ink shadow-[0_0_0_1px_var(--ink)]"
                  : l.available
                    ? "border-rule hover:border-rule-strong hover:bg-paper-2 active:scale-[0.99] active:bg-paper-3"
                    : "border-dashed border-rule-strong"
              }`}
            >
              <span
                aria-hidden
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors duration-200 ${
                  sel ? "border-ink bg-ink text-paper" : l.available ? "border-rule-strong" : "border-rule"
                }`}
              >
                {sel && <Check className="h-3.5 w-3.5" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-3">
                  <span className={`text-[1rem] font-medium ${l.available ? "text-ink" : "text-ink-2"}`}>Tradução {l.label}</span>
                  {l.available ? (
                    <span className="serif num shrink-0 text-[1.1875rem] leading-none text-ink">{brl(l.priceBrl)}</span>
                  ) : (
                    <span className="shrink-0 rounded-full bg-accent-soft px-2.5 py-1 text-[0.75rem] leading-none font-medium text-accent">
                      Em breve
                    </span>
                  )}
                </span>
                <span className={`mt-1 block text-[0.875rem] leading-relaxed ${l.available ? "text-ink-2" : "text-muted"}`}>{l.description}</span>
              </span>
            </button>
          );
        })}
      </div>

      {/* ---------- amostra grátis: ver o resultado antes de decidir ---------- */}
      <div id="amostra" className="scroll-mt-20">
        {!sampleState && (
          <div className="mt-6 rounded-[1.25rem] border border-rule px-5 py-5 sm:flex sm:items-center sm:justify-between sm:gap-6 sm:px-6">
            <div>
              <p className="serif text-[1.25rem] leading-snug text-ink">Quer ler antes de decidir?</p>
              <p className="mt-1 text-[0.875rem] leading-relaxed text-ink-2">Um trecho do começo do livro, já traduzido, com o original ao lado.</p>
            </div>
            <Button variant="secondary" onClick={sample} disabled={!!busy} className="mt-4 w-full sm:mt-0 sm:w-auto sm:shrink-0">
              {busy === "sample" ? "Preparando a amostra…" : "Ver uma amostra grátis"}
            </Button>
          </div>
        )}
        <SampleView book={book} />
      </div>

      {/* ---------- total, incluído e ação ---------- */}
      <div className="mt-8 rounded-[1.25rem] bg-paper-2 px-5 py-5 sm:px-6">
        <p className="label">Sua nova edição</p>
        <div className="mt-2 flex items-baseline justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[1rem] text-ink">Tradução {chosen.label}</p>
            <p className="mt-0.5 text-[0.8125rem] text-muted">{languageLabel(target)} · EPUB e PDF</p>
          </div>
          <span className="serif num shrink-0 text-[1.875rem] leading-none text-ink">{brl(chosen.priceBrl)}</span>
        </div>
        <ul className="mt-4 grid gap-x-4 gap-y-1.5 border-t border-rule pt-4 sm:grid-cols-2">
          {INCLUDED.map((item) => (
            <li key={item} className="flex items-center gap-2.5 text-[0.9375rem] text-ink-2">
              <Check className="h-4 w-4 shrink-0 text-ok" />
              {item}
            </li>
          ))}
        </ul>
      </div>

      {beta && (
        <p className="mt-4 text-[0.9375rem] leading-relaxed text-ink-2">
          <strong className="font-medium text-ink">Grátis durante o beta.</strong> Enquanto o Verso está em testes, sua tradução sai sem custo.
        </p>
      )}
      <Button onClick={order} size="lg" disabled={!!busy || !chosen.available || !canPay || sampleState === "running"} className="mt-5 w-full">
        {busy === "order"
          ? "Um instante…"
          : !canPay
            ? "Pagamentos em breve"
            : beta
              ? "Começar tradução — grátis no beta"
              : `Começar tradução · ${brl(chosen.priceBrl)}`}
        {busy !== "order" && canPay && <ArrowRight />}
      </Button>
      <p className="mt-3 text-center text-[0.8125rem] leading-relaxed text-muted">
        {beta
          ? "A tradução começa assim que você confirmar."
          : canPay
            ? "O valor é pago na próxima etapa. Sem assinatura."
            : "Estamos preparando os pagamentos. Volte em breve."}
      </p>
      <p className="mt-1 text-center text-[0.8125rem] leading-relaxed text-muted">
        Ao continuar, você concorda com os{" "}
        <Link href="/termos" className="link">
          Termos de uso
        </Link>{" "}
        e a{" "}
        <Link href="/privacidade" className="link">
          Política de privacidade
        </Link>
        .
      </p>

      {/* ---------- preferências ---------- */}
      <div className="mt-8 border-t border-rule">
        <button
          type="button"
          onClick={() => setPrefsOpen((v) => !v)}
          className="flex w-full items-center justify-between py-4 text-left text-[0.9375rem] text-ink-2 hover:text-ink"
          aria-expanded={prefsOpen}
        >
          <span>
            Preferências de tradução <span className="text-muted">(opcional)</span>
          </span>
          <Chevron className={`h-4 w-4 transition-transform duration-300 ${prefsOpen ? "rotate-180" : ""}`} />
        </button>
        {prefsOpen && (
          <div className="rise space-y-6 pb-6">
            <div>
              <span className="label">Diálogos</span>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {(
                  [
                    ["target", "Padrão do idioma", "Ex.: travessão nos diálogos em português"],
                    ["source", "Como no original", "Mantém aspas, só ajusta o estilo"],
                  ] as const
                ).map(([v, title, desc]) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setDialogueStyle(v)}
                    className={`rounded-xl border px-4 py-3 text-left transition-colors ${dialogueStyle === v ? "border-ink" : "border-rule hover:border-rule-strong"}`}
                  >
                    <span className="block text-[0.9375rem] text-ink">{title}</span>
                    <span className="mt-0.5 block text-[0.8125rem] text-muted">{desc}</span>
                  </button>
                ))}
              </div>
            </div>
            <label className="block">
              <span className="label">Pedidos para o tradutor</span>
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={3}
                placeholder="Ex.: use “você”, nunca “tu”. Mantenha os nomes dos lugares em inglês."
                className="serif mt-2 w-full resize-y rounded-xl border border-rule bg-transparent px-4 py-3 text-[1.0625rem] leading-relaxed text-ink placeholder:text-muted/80 focus:border-ink-2 focus:outline-none"
              />
            </label>
          </div>
        )}
      </div>
      {error && (
        <p className="mt-4 text-center text-[0.9375rem] text-accent" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
