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
import { ArrowRight, Check, Chevron } from "@/components/ui/icons";
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

export const INCLUDED = [
  "Tradução do livro",
  "Organização dos capítulos",
  "Formatação preservada",
  "EPUB",
  "PDF",
  "Revisão da tradução",
  "Download do arquivo final",
];

/**
 * Passo “Confirmar”: o livro está pronto para ser traduzido. A pessoa confere
 * idiomas, escolhe o tipo de tradução (já com o preço), vê o que está incluído
 * e toca em “Pagar e traduzir”. Nada técnico aparece aqui — só o livro, o
 * idioma e o preço.
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
        Seu livro está pronto para tradução.
      </h2>

      {/* ---------- o livro ---------- */}
      <div className="mt-6 rounded-[1.25rem] border border-rule px-5 py-5 sm:px-6">
        <p className="serif text-[1.25rem] leading-snug text-ink">{offer.title}</p>
        {offer.author && <p className="serif text-[1rem] text-ink-2 italic">{offer.author}</p>}
        <div className="mt-4 flex items-baseline justify-between gap-4 border-t border-rule pt-3">
          <p className="text-[0.9375rem] text-ink">
            {sourceLabel} <span className="text-muted">→</span> {languageLabel(target)}
          </p>
          <button onClick={() => setEditLangs((v) => !v)} className="link shrink-0 text-[0.8125rem] text-muted hover:text-ink">
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
              className={`flex w-full items-start gap-3 rounded-2xl border px-4 py-4 text-left transition-colors active:bg-paper-2 disabled:cursor-not-allowed disabled:opacity-55 sm:px-5 ${sel ? "border-ink" : "border-rule hover:border-rule-strong"}`}
            >
              <span
                className={`mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${sel ? "border-ink bg-ink" : "border-rule-strong"}`}
              >
                {sel && <span className="h-1.5 w-1.5 rounded-full bg-paper" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="text-[1rem] font-medium text-ink">Tradução {l.label}</span>
                  <span className="serif num shrink-0 text-[1.125rem] text-ink">{l.available ? brl(l.priceBrl) : "Em breve"}</span>
                </span>
                <span className="mt-0.5 block text-[0.875rem] leading-relaxed text-muted">{l.description}</span>
              </span>
            </button>
          );
        })}
      </div>

      {/* ---------- amostra grátis ---------- */}
      <div id="amostra" className="scroll-mt-20">
        <SampleView book={book} />
      </div>

      {/* ---------- total, incluído e ação ---------- */}
      <div className="mt-8 rounded-[1.25rem] bg-paper-2 px-5 py-5 sm:px-6">
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-[1rem] text-ink">Tradução completa</span>
          <span className="serif num text-[1.75rem] leading-none text-ink">{brl(chosen.priceBrl)}</span>
        </div>
        <p className="label mt-5">Incluído</p>
        <ul className="mt-2.5 grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
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
          <strong className="font-medium text-ink">Grátis durante o beta.</strong> Enquanto o Verso está em testes, você não paga nada.
        </p>
      )}
      <Button onClick={order} disabled={!!busy || !chosen.available || !canPay || sampleState === "running"} className="mt-5 h-14 w-full text-[1rem]">
        {busy === "order"
          ? "Um instante…"
          : !canPay
            ? "Pagamentos em breve"
            : beta
              ? "Traduzir grátis"
              : `Pagar e traduzir · ${brl(chosen.priceBrl)}`}
        {busy !== "order" && canPay && <ArrowRight />}
      </Button>
      <p className="mt-3 text-center text-[0.8125rem] leading-relaxed text-muted">
        {beta
          ? "A tradução começa assim que você confirmar."
          : canPay
            ? "Pagamento único, sem assinatura e sem cobrança automática."
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
      {!sampleState && (
        <button
          onClick={sample}
          disabled={!!busy}
          className="link mx-auto mt-5 block py-1 text-center text-[0.9375rem] text-ink-2 hover:text-ink disabled:opacity-50"
        >
          {busy === "sample" ? "Pedindo a amostra…" : "Ver uma amostra grátis antes"}
        </button>
      )}

      {/* ---------- preferências ---------- */}
      <div className="mt-8 border-t border-rule">
        <button
          type="button"
          onClick={() => setPrefsOpen((v) => !v)}
          className="flex w-full items-center justify-between py-4 text-left text-[0.9375rem] text-ink-2 hover:text-ink"
          aria-expanded={prefsOpen}
        >
          Preferências de tradução <span className="text-muted">(opcional)</span>
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
