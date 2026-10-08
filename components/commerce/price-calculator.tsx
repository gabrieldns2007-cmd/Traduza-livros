"use client";

import { useState } from "react";
import { priceFor } from "@/lib/billing/pricing";
import { brl } from "@/lib/money";

const PRESETS = [
  { label: "Conto", words: 10_000 },
  { label: "Romance", words: 80_000 },
  { label: "Livro longo", words: 150_000 },
];

/** “Quanto custa o meu livro?” — o mesmo cálculo da tela de confirmação. */
export function PriceCalculator({ literariaAvailable }: { literariaAvailable: boolean }) {
  const [words, setWords] = useState(80_000);
  return (
    <div className="rounded-[1.25rem] border border-rule px-5 py-6 sm:px-7">
      <p className="label">Quanto custa o seu livro</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => setWords(p.words)}
            className={`rounded-full border px-4 py-2 text-[0.875rem] transition-colors ${words === p.words ? "border-ink text-ink" : "border-rule text-ink-2 hover:border-rule-strong"}`}
          >
            {p.label}
          </button>
        ))}
      </div>
      <label className="mt-5 block">
        <span className="num text-[0.9375rem] text-ink">{words.toLocaleString("pt-BR")} palavras</span>
        <input
          type="range"
          min={5_000}
          max={300_000}
          step={5_000}
          value={words}
          onChange={(e) => setWords(Number(e.target.value))}
          className="mt-3 w-full accent-[var(--accent)]"
          aria-label="Número de palavras do livro"
        />
      </label>
      <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-rule pt-4">
        <div>
          <dt className="text-[0.875rem] text-muted">Tradução Padrão</dt>
          <dd className="serif num mt-1 text-[1.75rem] leading-none text-ink">{brl(priceFor(words, "padrao"))}</dd>
        </div>
        <div>
          <dt className="text-[0.875rem] text-muted">Tradução Literária</dt>
          <dd className="serif num mt-1 text-[1.75rem] leading-none text-ink">
            {literariaAvailable ? brl(priceFor(words, "literaria")) : "Em breve"}
          </dd>
        </div>
      </dl>
      <p className="mt-4 text-[0.8125rem] leading-relaxed text-muted">
        O preço exato do seu livro aparece assim que você envia o arquivo, antes de qualquer pagamento.
      </p>
    </div>
  );
}
