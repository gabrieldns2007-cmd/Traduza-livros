import type { Metadata } from "next";
import Link from "next/link";
import { PACKS, PLANS, QUALITIES, pricePerCredit } from "@/lib/billing/catalog";
import { billingMode } from "@/lib/billing/mode";
import { brl } from "@/lib/money";
import { Check } from "@/components/ui/icons";

export const metadata: Metadata = { title: "Planos" };

const NOVEL = 80_000;

const FAQ: [string, string][] = [
  [
    "O que é um crédito?",
    "Um crédito traduz 1.000 palavras na qualidade Padrão. Um romance costuma ter entre 60 e 100 mil palavras. Antes de começar, o Verso mostra quantos créditos o livro vai usar.",
  ],
  [
    "E se meus créditos acabarem no meio do livro?",
    "A tradução pausa e tudo o que já foi traduzido fica salvo. Quando você tiver créditos de novo, ela continua do mesmo ponto — nada é traduzido (nem cobrado) duas vezes.",
  ],
  ["A prévia é paga?", "Não. Antes de traduzir o livro todo, você vê um trecho traduzido de graça para avaliar a qualidade."],
  ["Os créditos vencem?", "Créditos avulsos valem por 12 meses. Os créditos mensais dos planos acumulam por mais 1 mês (Plus) ou 2 meses (Pro)."],
  [
    "Posso usar a minha própria chave de IA?",
    "Sim. Com uma chave gratuita do Gemini, do Groq ou do GitHub, a tradução não consome créditos — ela usa a cota grátis do seu serviço.",
  ],
  ["Vocês usam os meus livros?", "Não. O texto vai ao serviço de IA só para ser traduzido. Não há anúncios e seus livros não são compartilhados."],
];

/** “1 romance”, “3 romances” — quantos romances de 80 mil palavras os créditos cobrem. */
function novels(creditsPerMonth: number) {
  const n = Math.max(1, Math.floor((creditsPerMonth * 1000) / NOVEL));
  return `${n} ${n > 1 ? "romances" : "romance"}`;
}

export default function PlansPage() {
  const selling = billingMode() === "enforce";
  return (
    <main className="mx-auto w-full max-w-[56rem] px-5 pt-8 pb-28 sm:px-8 sm:pt-14">
      <header className="rise max-w-[40rem]">
        <p className="label">Planos</p>
        <h1 className="serif mt-3 text-[2.6rem] leading-[1.02] font-[380] tracking-[-0.035em] text-ink text-balance sm:text-[3.6rem]">
          Pague pelo que você lê<span className="text-accent">.</span>
        </h1>
        <p className="serif mt-5 text-[1.2rem] leading-[1.5] text-ink-2 sm:text-[1.3rem]">
          Um crédito traduz mil palavras. Sem anúncios, sem surpresas: você vê quanto o livro vai usar antes de começar.
        </p>
        {!selling && (
          <p className="mt-5 border-l-2 border-accent pl-4 text-[0.875rem] leading-relaxed text-ink-2">
            Os planos pagos ainda não estão à venda. Por enquanto, tudo no Verso é gratuito.
          </p>
        )}
      </header>

      {/* ---------- planos ---------- */}
      <section className="rise mt-12 grid gap-4 sm:mt-16 lg:grid-cols-3" style={{ animationDelay: "60ms" }}>
        {PLANS.map((plan) => {
          const featured = plan.id === "plus";
          return (
            <article
              key={plan.id}
              className={`flex flex-col rounded-[1.25rem] border px-6 py-7 ${featured ? "border-ink" : "border-rule"}`}
              aria-label={`Plano ${plan.name}`}
            >
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="serif text-[1.6rem] leading-none text-ink">{plan.name}</h2>
                {featured && <span className="text-[0.75rem] text-accent">Mais escolhido</span>}
              </div>
              <p className="mt-2 text-[0.875rem] text-muted">{plan.tagline}</p>
              <p className="mt-6">
                {plan.priceBrl === 0 ? (
                  <span className="serif num text-[2.2rem] leading-none text-ink">R$ 0</span>
                ) : (
                  <>
                    <span className="serif num text-[2.2rem] leading-none text-ink">{brl(plan.priceBrl)}</span>
                    <span className="text-[0.875rem] text-muted"> /mês</span>
                  </>
                )}
              </p>
              <p className="mt-4 border-t border-rule pt-4 text-[0.9375rem] text-ink">
                <span className="num">{plan.monthlyCredits + plan.welcomeCredits}</span>{" "}
                {plan.welcomeCredits ? "créditos no primeiro mês" : "créditos por mês"}
              </p>
              <p className="text-[0.8125rem] text-muted">
                {plan.priceBrl > 0
                  ? `≈ ${novels(plan.monthlyCredits)} por mês · ${brl(pricePerCredit(plan))} por crédito`
                  : `${plan.monthlyCredits} por mês depois · ${plan.previewsPerDay} prévias por dia`}
              </p>
              <ul className="mt-5 flex-1 space-y-2.5">
                {plan.features.map((f) => (
                  <li key={f} className="flex gap-2.5 text-[0.9375rem] leading-snug text-ink-2">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
                    {f}
                  </li>
                ))}
              </ul>
              <div className="mt-7">
                {plan.priceBrl === 0 ? (
                  <Link
                    href="/"
                    className="inline-flex h-12 w-full items-center justify-center rounded-full border border-rule-strong text-[0.9375rem] font-medium text-ink transition-colors hover:border-ink"
                  >
                    Começar grátis
                  </Link>
                ) : (
                  <span
                    aria-disabled="true"
                    className={`inline-flex h-12 w-full items-center justify-center rounded-full text-[0.9375rem] font-medium ${featured ? "bg-ink text-paper opacity-40" : "border border-rule-strong text-ink opacity-50"}`}
                  >
                    Em breve
                  </span>
                )}
              </div>
            </article>
          );
        })}
      </section>

      {/* ---------- avulsos ---------- */}
      <section className="mt-20">
        <h2 className="serif text-[1.8rem] leading-tight tracking-[-0.015em] text-ink">Prefere pagar por livro?</h2>
        <p className="mt-2 max-w-[36rem] text-[0.9375rem] leading-relaxed text-ink-2">
          Créditos avulsos, sem assinatura. Valem por {PACKS[0].validityMonths} meses.
        </p>
        <ul className="mt-6 divide-y divide-rule border-y border-rule">
          {PACKS.map((p) => (
            <li key={p.id} className="flex items-baseline justify-between gap-4 py-4">
              <span className="min-w-0">
                <span className="serif num block text-[1.25rem] text-ink">{p.credits} créditos</span>
                <span className="block text-[0.8125rem] text-muted">
                  {p.label} · até {(p.credits * 1000).toLocaleString("pt-BR")} palavras
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="num block text-[1.0625rem] text-ink">{brl(p.priceBrl)}</span>
                <span className="block text-[0.75rem] text-muted">{brl(pricePerCredit(p))} por crédito</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* ---------- qualidades ---------- */}
      <section className="mt-20">
        <h2 className="serif text-[1.8rem] leading-tight tracking-[-0.015em] text-ink">Qualidade da tradução</h2>
        <p className="mt-2 max-w-[36rem] text-[0.9375rem] leading-relaxed text-ink-2">
          Modelos mais refinados custam mais para rodar, por isso usam mais créditos. Para um romance de {NOVEL.toLocaleString("pt-BR")} palavras:
        </p>
        <ul className="mt-6 grid gap-3 sm:grid-cols-2">
          {QUALITIES.map((q) => (
            <li key={q.id} className="rounded-2xl border border-rule px-5 py-4">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[1rem] font-medium text-ink">{q.label}</span>
                <span className="num text-[0.875rem] text-ink-2">{((NOVEL / 1000) * q.creditsPer1k).toLocaleString("pt-BR")} créditos</span>
              </div>
              <p className="mt-1 text-[0.875rem] leading-relaxed text-muted">{q.description}</p>
              <p className="mt-2 text-[0.75rem] text-muted">
                {q.creditsPer1k} {q.creditsPer1k === 1 ? "crédito" : "créditos"} por mil palavras
              </p>
            </li>
          ))}
        </ul>
      </section>

      {/* ---------- perguntas ---------- */}
      <section className="mt-20 max-w-[40rem]">
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
