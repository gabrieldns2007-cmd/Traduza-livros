import type { Metadata } from "next";
import type { ReactNode } from "react";
import { connection } from "next/server";
import { PUBLIC_MODE } from "@/lib/mode";
import { ButtonLink } from "@/components/ui/button";
import { ArrowRight, Check } from "@/components/ui/icons";
import { EditionConfigurator } from "@/components/commerce/edition-configurator";
import { UploadCta } from "@/components/home/upload-cta";
import { Faq } from "@/components/commerce/faq";

export const metadata: Metadata = { title: "Preços" };

/** O que chega nas mãos do leitor — escrito como resultado, não como item de fatura. */
const EDITION: [string, string][] = [
  ["O livro inteiro, em português", "Capítulo por capítulo, do começo ao fim."],
  ["A cara do original", "Capítulos, sumário, capa, itálicos e notas no lugar."],
  ["Nomes que não mudam", "Personagens, lugares e termos iguais do primeiro ao último capítulo."],
  ["EPUB para qualquer leitor", "Kindle, Kobo, Apple Books e Google Play Livros."],
  ["PDF com cara de livro", "Diagramado para ler na tela ou imprimir."],
  ["A última palavra é sua", "Revise e edite qualquer parágrafo, com o original ao lado, antes de baixar."],
];

/**
 * A capa do original atrás e a nova edição na frente: o resultado antes de
 * qualquer número. Puramente ilustrativo (livro fictício).
 */
function EditionPreview() {
  return (
    <figure className="rounded-[1.75rem] bg-paper-2 px-6 pt-9 pb-6 sm:pt-12 sm:pb-8">
      <div className="relative mx-auto h-[14.5rem] w-[16rem]" aria-hidden>
        {/* original */}
        <div className="absolute top-5 left-1 flex h-[11.5rem] w-[7.75rem] -rotate-[7deg] flex-col rounded-[3px_9px_9px_3px] border border-rule-strong bg-paper-3 px-3.5 pt-4 pb-3.5 shadow-[0_10px_24px_-18px_rgba(0,0,0,0.5)]">
          <span className="text-[0.5rem] tracking-[0.16em] text-muted uppercase">Edith Marlow</span>
          <span className="serif mt-auto text-[1.0625rem] leading-[1.08] text-ink-2">The Lighthouse Keeper</span>
          <span className="mt-2.5 h-px w-6 bg-rule-strong" />
          <span className="mt-auto text-[0.5rem] tracking-[0.16em] text-muted uppercase">Inglês</span>
        </div>
        {/* nova edição */}
        <div className="absolute top-0 right-1 flex h-[14rem] w-[9.25rem] rotate-[3deg] flex-col overflow-hidden rounded-[3px_11px_11px_3px] bg-ink px-4 pt-5 pb-4 text-paper shadow-[0_28px_44px_-22px_rgba(0,0,0,0.6),0_2px_6px_-2px_rgba(0,0,0,0.25)]">
          <span className="pointer-events-none absolute inset-y-0 left-0 w-2.5 bg-gradient-to-r from-black/25 to-transparent" />
          <span className="text-[0.5625rem] tracking-[0.16em] uppercase opacity-65">Edith Marlow</span>
          <span className="serif mt-auto text-[1.5rem] leading-[1.02] tracking-[-0.01em]">O guardião do farol</span>
          <span className="mt-3 h-[2px] w-7 rounded-full bg-accent" />
          <span className="mt-auto text-[0.5625rem] tracking-[0.16em] uppercase opacity-65">Português</span>
        </div>
        {/* os arquivos */}
        <div className="absolute right-0 -bottom-1 flex gap-1.5">
          {["EPUB", "PDF"].map((f) => (
            <span
              key={f}
              className="rounded-full border border-rule-strong bg-paper px-2.5 py-1 text-[0.625rem] font-medium tracking-[0.08em] text-ink shadow-[0_6px_14px_-10px_rgba(0,0,0,0.5)]"
            >
              {f}
            </span>
          ))}
        </div>
      </div>
      <figcaption className="mt-7 flex items-center justify-center gap-2.5 text-[0.8125rem] text-muted">
        <span>O original</span>
        <ArrowRight className="h-3.5 w-3.5 text-accent" />
        <span className="text-ink-2">Sua nova edição</span>
      </figcaption>
    </figure>
  );
}

export default async function PricesPage() {
  let literaria = false;
  let action: ReactNode = (
    <ButtonLink href="/" size="lg" className="w-full">
      Traduzir meu livro <ArrowRight />
    </ButtonLink>
  );
  let closingAction: ReactNode = (
    <ButtonLink href="/" size="lg" className="w-full sm:w-auto">
      Traduzir meu livro <ArrowRight />
    </ButtonLink>
  );
  if (!PUBLIC_MODE) {
    await connection();
    const { readSettings } = await import("@/lib/storage");
    const { levelOffered } = await import("@/services/commerce/routing");
    const { config } = await import("@/lib/config");
    const settings = await readSettings();
    literaria = levelOffered("literaria", settings);
    const maxUploadMb = Math.round(config.maxUploadBytes / 1024 / 1024);
    action = <UploadCta targetLanguage={settings.targetLanguage} maxUploadMb={maxUploadMb} label="Traduzir meu livro" />;
    closingAction = <UploadCta targetLanguage={settings.targetLanguage} maxUploadMb={maxUploadMb} label="Traduzir meu livro" />;
  }

  return (
    <main className="mx-auto w-full max-w-[48rem] px-5 pt-8 pb-28 sm:px-8 sm:pt-14">
      {/* ---------- o resultado ---------- */}
      <header>
        <div className="rise">
          <p className="label">Tradução de livros</p>
          <h1 className="serif mt-3 text-[2.6rem] leading-[1.02] font-[380] tracking-[-0.035em] text-ink sm:text-[3.5rem]">
            Seu livro.
            <br />
            Agora em português<span className="text-accent">.</span>
          </h1>
          <p className="serif mt-5 max-w-[36rem] text-[1.1875rem] leading-[1.5] text-ink-2 sm:text-[1.3125rem]">
            Envie o EPUB ou PDF. O Verso traduz o livro inteiro, capítulo por capítulo, e entrega uma nova edição — com capa, capítulos e formatação
            no lugar.
          </p>
        </div>
        <div className="rise mt-9 sm:mt-12" style={{ animationDelay: "80ms" }}>
          <EditionPreview />
        </div>
      </header>

      {/* ---------- a escolha ---------- */}
      <section className="rise mt-16 sm:mt-20" style={{ animationDelay: "140ms" }} aria-labelledby="monte">
        <h2 id="monte" className="serif text-[1.9rem] leading-tight tracking-[-0.02em] text-ink sm:text-[2.3rem]">
          Monte a sua edição
        </h2>
        <p className="mt-2 text-[0.9375rem] leading-relaxed text-ink-2">Duas escolhas rápidas e você já vê como fica o seu livro.</p>
        <div className="mt-8">
          <EditionConfigurator literariaAvailable={literaria} action={action} />
        </div>
      </section>

      {/* ---------- o que vem ---------- */}
      <section className="mt-20 sm:mt-24">
        <h2 className="serif text-[1.9rem] leading-tight tracking-[-0.02em] text-ink sm:text-[2.3rem]">Sua nova edição inclui</h2>
        <ul className="mt-7 grid gap-x-8 gap-y-6 sm:grid-cols-2">
          {EDITION.map(([title, text]) => (
            <li key={title} className="flex gap-3.5">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-paper-2 text-ok">
                <Check className="h-3.5 w-3.5" />
              </span>
              <div>
                <h3 className="text-[1rem] leading-snug font-medium text-ink">{title}</h3>
                <p className="mt-0.5 text-[0.9375rem] leading-relaxed text-ink-2">{text}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* ---------- perguntas ---------- */}
      <section className="mt-20 max-w-[40rem] sm:mt-24">
        <h2 className="serif text-[1.9rem] leading-tight tracking-[-0.02em] text-ink sm:text-[2.3rem]">Perguntas</h2>
        <div className="mt-5">
          <Faq />
        </div>
      </section>

      {/* ---------- fim ---------- */}
      <section className="mt-20 rounded-[1.5rem] bg-paper-2 px-6 py-10 text-center sm:px-10">
        <h2 className="serif text-[1.9rem] leading-tight tracking-[-0.02em] text-ink text-balance">Que livro você quer ler em português?</h2>
        <p className="mt-2 text-[0.9375rem] leading-relaxed text-ink-2">
          Envie o arquivo, leia uma amostra grátis e veja o valor antes de continuar.
        </p>
        <div className="mt-7 flex justify-center">{closingAction}</div>
      </section>
    </main>
  );
}
