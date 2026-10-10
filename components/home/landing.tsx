import { LANGUAGES } from "@/lib/languages";
import { OPERATIONS, priceFor, SERVICE_LEVELS } from "@/lib/billing/pricing";
import { brl } from "@/lib/money";
import { ArrowRight, Check } from "@/components/ui/icons";
import { ButtonLink } from "@/components/ui/button";
import { Faq } from "@/components/commerce/faq";
import { UploadCta } from "./upload-cta";

const STEPS: [string, string][] = [
  ["Envie o livro", "Um arquivo EPUB ou PDF, do celular ou do computador."],
  ["Escolha o idioma", "O valor aparece na hora, antes de continuar. Se quiser, leia antes uma amostra grátis."],
  ["Receba sua nova edição", "Em EPUB e PDF, com os capítulos e a formatação do original."],
];

const STRUCTURE = [
  "Capítulos e sumário",
  "Títulos, itálicos e negritos",
  "Notas e referências",
  "Capa e imagens",
  "Diálogos no padrão do idioma",
  "Nomes e termos iguais do começo ao fim",
];

const EXAMPLES: [string, number][] = [
  ["Conto", 10_000],
  ["Romance", 80_000],
  ["Livro longo", 210_000],
];

function Section({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`mt-20 sm:mt-24 ${className}`}>
      <h2 className="serif text-[1.9rem] leading-tight tracking-[-0.02em] text-ink sm:text-[2.3rem]">{title}</h2>
      {children}
    </section>
  );
}

/**
 * Página inicial do serviço: explica em segundos o que é, como funciona e
 * quanto custa, com um único botão de ação. Fala do livro que a pessoa vai
 * ler, não da compra — mas sem esconder nada: o valor aparece antes de
 * continuar.
 */
export function Landing({ targetLanguage, maxUploadMb, literaria }: { targetLanguage: string; maxUploadMb: number; literaria: boolean }) {
  const levels = SERVICE_LEVELS.filter((l) => l.id === "padrao" || literaria);
  return (
    <main className="mx-auto w-full max-w-[44rem] px-5 pb-28 sm:px-8">
      {/* ---------- primeira tela ---------- */}
      <section className="rise pt-12 sm:pt-24">
        <h1 className="serif text-[3.2rem] leading-[0.98] font-[380] tracking-[-0.035em] text-ink sm:text-[4.8rem]">
          Traduza seus livros<span className="text-accent">.</span>
        </h1>
        <p className="serif mt-5 text-[1.35rem] leading-[1.4] text-ink-2 sm:text-[1.6rem]">Envie. Escolha o idioma. Receba seu livro traduzido.</p>
        <div className="mt-9">
          <UploadCta targetLanguage={targetLanguage} maxUploadMb={maxUploadMb} />
        </div>
        <p className="mt-4 text-[0.875rem] leading-relaxed text-muted">
          EPUB ou PDF · a partir de {brl(OPERATIONS.minimumBrl)}
          <br className="sm:hidden" />
          <span className="hidden sm:inline"> · </span>
          Você verá o valor antes de continuar.
        </p>
      </section>

      {/* ---------- como funciona ---------- */}
      <Section title="Como funciona">
        <ol className="mt-7 space-y-6">
          {STEPS.map(([title, text], i) => (
            <li key={title} className="flex gap-5">
              <span className="serif num w-6 shrink-0 text-[1.75rem] leading-none text-accent">{i + 1}</span>
              <div>
                <h3 className="text-[1.0625rem] font-medium text-ink">{title}</h3>
                <p className="mt-1 text-[0.9375rem] leading-relaxed text-ink-2">{text}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="mt-7 text-[0.9375rem] leading-relaxed text-ink-2">
          Depois de confirmar, é só esperar: a tradução continua mesmo com a página fechada, e você acompanha capítulo por capítulo.
        </p>
      </Section>

      {/* ---------- formatos e idiomas ---------- */}
      <Section title="Formatos aceitos">
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <article className="rounded-2xl border border-rule px-5 py-5">
            <h3 className="serif text-[1.25rem] text-ink">EPUB</h3>
            <p className="mt-1.5 text-[0.9375rem] leading-relaxed text-ink-2">
              O formato dos livros digitais. O melhor ponto de partida: a estrutura vem completa.
            </p>
          </article>
          <article className="rounded-2xl border border-rule px-5 py-5">
            <h3 className="serif text-[1.25rem] text-ink">PDF</h3>
            <p className="mt-1.5 text-[0.9375rem] leading-relaxed text-ink-2">
              Com texto selecionável (não fotografado). O texto é reorganizado em capítulos.
            </p>
          </article>
        </div>
        <p className="mt-3 text-[0.8125rem] text-muted">Até {maxUploadMb} MB. Livros com proteção contra cópia (DRM) não podem ser lidos.</p>
      </Section>

      <Section title="Idiomas">
        <p className="mt-4 text-[0.9375rem] leading-relaxed text-ink-2">
          De e para {LANGUAGES.length} idiomas — por exemplo, do inglês para o português do Brasil. O idioma do livro é detectado sozinho.
        </p>
        <ul className="mt-5 flex flex-wrap gap-2">
          {LANGUAGES.map((l) => (
            <li key={l.code} className="rounded-full border border-rule px-3 py-1 text-[0.8125rem] text-ink-2">
              {l.label}
            </li>
          ))}
        </ul>
      </Section>

      {/* ---------- estrutura e arquivos ---------- */}
      <Section title="O livro continua um livro">
        <p className="mt-4 text-[0.9375rem] leading-relaxed text-ink-2">A tradução mantém a estrutura do original:</p>
        <ul className="mt-5 grid gap-2.5 sm:grid-cols-2">
          {STRUCTURE.map((item) => (
            <li key={item} className="flex items-center gap-2.5 text-[0.9375rem] text-ink-2">
              <Check className="h-4 w-4 shrink-0 text-ok" />
              {item}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Você recebe EPUB e PDF">
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <article className="rounded-2xl bg-paper-2 px-5 py-5">
            <h3 className="serif text-[1.25rem] text-ink">EPUB</h3>
            <p className="mt-1.5 text-[0.9375rem] leading-relaxed text-ink-2">Para ler no Kindle, Apple Books, Kobo e Google Play Livros.</p>
          </article>
          <article className="rounded-2xl bg-paper-2 px-5 py-5">
            <h3 className="serif text-[1.25rem] text-ink">PDF</h3>
            <p className="mt-1.5 text-[0.9375rem] leading-relaxed text-ink-2">Com diagramação de livro, para ler na tela ou imprimir.</p>
          </article>
        </div>
        <p className="mt-4 text-[0.9375rem] leading-relaxed text-ink-2">
          Antes de baixar, você pode revisar e editar qualquer parágrafo, com o original ao lado.
        </p>
      </Section>

      {/* ---------- preço ---------- */}
      <Section title="Preço">
        <p className="mt-4 text-[0.9375rem] leading-relaxed text-ink-2">
          Um valor único por livro, calculado pelo tamanho. Você verá o valor exato antes de continuar.
        </p>
        <div className="mt-6 overflow-hidden rounded-[1.25rem] border border-rule">
          <table className="num w-full text-[0.9375rem]">
            <thead>
              <tr className="border-b border-rule text-left text-[0.8125rem] text-muted">
                <th className="px-4 py-3 font-normal sm:px-5">Tamanho</th>
                {levels.map((l) => (
                  <th key={l.id} className="px-4 py-3 text-right font-normal sm:px-5">
                    {l.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {EXAMPLES.map(([label, words]) => (
                <tr key={label} className="border-b border-rule last:border-0">
                  <td className="px-4 py-3 sm:px-5">
                    <span className="text-ink">{label}</span>
                    <span className="block text-[0.8125rem] text-muted">{(words / 1000).toLocaleString("pt-BR")} mil palavras</span>
                  </td>
                  {levels.map((l) => (
                    <td key={l.id} className="serif px-4 py-3 text-right text-[1.125rem] text-ink sm:px-5">
                      {brl(priceFor(words, l.id))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[0.875rem] leading-relaxed text-ink-2">
          Sem assinatura, sem cobranças recorrentes, sem taxas escondidas.
          {!literaria && " Tradução Literária: em breve."}
        </p>
        <ButtonLink href="/precos" variant="secondary" className="mt-6 w-full sm:w-auto">
          Calcular o valor do meu livro <ArrowRight />
        </ButtonLink>
      </Section>

      <Section title="Perguntas frequentes">
        <div className="mt-5">
          <Faq />
        </div>
      </Section>

      {/* ---------- fim ---------- */}
      <section className="mt-20 rounded-[1.5rem] bg-paper-2 px-6 py-10 text-center sm:px-10">
        <h2 className="serif text-[1.9rem] leading-tight tracking-[-0.02em] text-ink">Pronto para ler no seu idioma?</h2>
        <p className="mt-2 text-[0.9375rem] text-ink-2">Envie o livro, leia uma amostra e veja o valor. Você decide se quer seguir.</p>
        <div className="mt-7 flex justify-center">
          <UploadCta targetLanguage={targetLanguage} maxUploadMb={maxUploadMb} />
        </div>
      </section>
    </main>
  );
}
