import { connection } from "next/server";
import { readSettings } from "@/lib/storage";
import { config } from "@/lib/config";
import { defaultProviderId } from "@/lib/config";
import { TranslateFlow } from "@/components/home/translate-flow";
import { PUBLIC_MODE } from "@/lib/mode";
import { PublicHomeFlow } from "@/components/public/loaders";

export default async function HomePage() {
  const settings = PUBLIC_MODE ? null : (await connection(), await readSettings());

  return (
    <main className="mx-auto w-full max-w-[42rem] px-5 pt-10 pb-24 sm:px-8 sm:pt-20">
      <section className="rise">
        <h1 className="serif text-[3.1rem] leading-[0.98] font-[380] tracking-[-0.035em] text-ink sm:text-[4.6rem]">
          Traduza seu livro<span className="text-accent">.</span>
        </h1>
        <p className="serif mt-5 max-w-[32rem] text-[1.25rem] leading-[1.45] text-ink-2 sm:mt-6 sm:text-[1.375rem]">
          {PUBLIC_MODE
            ? "Transforme um livro inteiro em outro idioma, preservando capítulos, estrutura e formatação."
            : "Envie o livro, veja o preço na hora e receba a tradução completa em EPUB e PDF."}
        </p>
      </section>

      <section className="rise mt-10 sm:mt-14" style={{ animationDelay: "80ms" }}>
        {settings ? (
          <TranslateFlow
            defaults={{
              targetLanguage: settings.targetLanguage,
              dialogueStyle: settings.dialogueStyle,
              deepContext: settings.deepContext,
              instructions: settings.instructions,
              maxUploadMb: Math.round(config.maxUploadBytes / 1024 / 1024),
              demo: defaultProviderId(settings) === "demo",
            }}
          />
        ) : (
          <PublicHomeFlow />
        )}
      </section>

      <section className="mt-20 grid gap-8 border-t border-rule pt-10 sm:grid-cols-3 sm:gap-6">
        {[
          ["Capítulo por capítulo", "O livro é lido como um todo e traduzido em partes, sem perder o fio da história."],
          ["Nomes consistentes", "Um glossário guarda personagens, lugares e termos do primeiro ao último capítulo."],
          ["Pronto para ler", "EPUB válido para Kindle, Kobo e Apple Books, e um PDF com cara de livro."],
        ].map(([title, text]) => (
          <div key={title}>
            <h3 className="serif text-[1.125rem] text-ink">{title}</h3>
            <p className="mt-1.5 text-[0.875rem] leading-relaxed text-muted">{text}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
