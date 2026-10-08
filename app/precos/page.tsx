import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { OPERATIONS, SERVICE_LEVELS } from "@/lib/billing/pricing";
import { brl } from "@/lib/money";
import { PUBLIC_MODE } from "@/lib/mode";
import { Check } from "@/components/ui/icons";
import { PriceCalculator } from "@/components/commerce/price-calculator";

export const metadata: Metadata = { title: "Preços" };

const INCLUDED = [
  "Tradução completa, capítulo por capítulo",
  "Amostra grátis antes de pagar",
  "Nomes e termos consistentes do começo ao fim",
  "Revisão e edição de cada parágrafo, online",
  "EPUB para Kindle, Kobo e Apple Books, e PDF com cara de livro",
  "Sem assinatura: você paga só pelo livro que traduzir",
];

const FAQ: [string, string][] = [
  [
    "Como o preço é calculado?",
    "Pelo tamanho do livro (número de palavras) e pelo tipo de tradução que você escolher. Você vê o valor exato antes de pagar.",
  ],
  ["Posso ver a tradução antes de pagar?", "Sim. Depois de enviar o livro, peça uma amostra grátis: um trecho do começo, com o original ao lado."],
  ["Quanto tempo demora?", "De alguns minutos a algumas horas, conforme o tamanho do livro. Você acompanha o progresso capítulo por capítulo."],
  ["Posso corrigir alguma coisa?", "Pode. Na revisão, cada parágrafo traduzido aparece ao lado do original e pode ser editado antes de baixar."],
  ["Quais arquivos posso enviar?", "EPUB (o melhor ponto de partida) ou PDF com texto. Livros com DRM não podem ser lidos."],
  ["O que vocês fazem com o meu livro?", "Nada além de traduzir. Seu livro não é publicado, compartilhado nem usado para outros fins."],
];

export default async function PricesPage() {
  let literaria = false;
  if (!PUBLIC_MODE) {
    await connection();
    const { readSettings } = await import("@/lib/storage");
    const { levelOffered } = await import("@/services/commerce/routing");
    literaria = levelOffered("literaria", await readSettings());
  }
  return (
    <main className="mx-auto w-full max-w-[48rem] px-5 pt-8 pb-28 sm:px-8 sm:pt-14">
      <header className="rise max-w-[38rem]">
        <p className="label">Preços</p>
        <h1 className="serif mt-3 text-[2.5rem] leading-[1.04] font-[380] tracking-[-0.035em] text-ink text-balance sm:text-[3.4rem]">
          Você paga pela tradução do livro<span className="text-accent">.</span> Só isso.
        </h1>
        <p className="serif mt-5 text-[1.2rem] leading-[1.5] text-ink-2">
          Sem assinatura e sem surpresa: o preço aparece antes de qualquer pagamento.
        </p>
      </header>

      <section className="rise mt-10" style={{ animationDelay: "60ms" }}>
        <PriceCalculator literariaAvailable={literaria} />
      </section>

      <section className="mt-14 grid gap-4 sm:grid-cols-2">
        {SERVICE_LEVELS.map((l) => {
          const available = l.id === "padrao" || literaria;
          return (
            <article key={l.id} className={`rounded-[1.25rem] border px-6 py-6 ${l.id === "padrao" ? "border-ink" : "border-rule"}`}>
              <h2 className="serif text-[1.5rem] leading-tight text-ink">Tradução {l.label}</h2>
              <p className="mt-2 text-[0.9375rem] leading-relaxed text-ink-2">{l.description}</p>
              <p className="mt-5 border-t border-rule pt-4">
                {available ? (
                  <>
                    <span className="serif num text-[1.5rem] text-ink">{brl(l.per1kBrl)}</span>
                    <span className="text-[0.875rem] text-muted"> por mil palavras</span>
                  </>
                ) : (
                  <span className="text-[1rem] text-muted">Em breve</span>
                )}
              </p>
            </article>
          );
        })}
      </section>
      <p className="mt-3 text-[0.8125rem] text-muted">Preço mínimo por livro: {brl(OPERATIONS.minimumBrl)}. O valor final já inclui tudo.</p>

      <section className="mt-14">
        <h2 className="serif text-[1.8rem] leading-tight tracking-[-0.015em] text-ink">Tudo incluído</h2>
        <ul className="mt-5 grid gap-3 sm:grid-cols-2">
          {INCLUDED.map((item) => (
            <li key={item} className="flex gap-2.5 text-[0.9375rem] leading-snug text-ink-2">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
              {item}
            </li>
          ))}
        </ul>
        <Link
          href="/"
          className="mt-8 inline-flex h-12 items-center justify-center rounded-full bg-ink px-7 text-[0.9375rem] font-medium text-paper transition-colors hover:bg-ink/88"
        >
          Enviar meu livro
        </Link>
      </section>

      <section className="mt-16 max-w-[40rem]">
        <h2 className="serif text-[1.8rem] leading-tight tracking-[-0.015em] text-ink">Perguntas</h2>
        <div className="mt-4 divide-y divide-rule border-y border-rule">
          {FAQ.map(([q, a]) => (
            <details key={q} className="group py-4">
              <summary className="flex cursor-pointer list-none items-baseline justify-between gap-4 text-[1rem] text-ink [&::-webkit-details-marker]:hidden">
                {q}
                <span className="shrink-0 text-muted transition-transform duration-300 group-open:rotate-45">+</span>
              </summary>
              <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink-2">{a}</p>
            </details>
          ))}
        </div>
      </section>
    </main>
  );
}
