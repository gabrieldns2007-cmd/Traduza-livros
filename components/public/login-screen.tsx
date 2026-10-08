"use client";

import { useEffect, useRef, useState } from "react";
import Script from "next/script";
import { userFromGoogleCredential, type VersoUser } from "@/lib/browser/session";
import { Wordmark } from "@/components/wordmark";
import { Button } from "@/components/ui/button";

const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
const TEST_LOGIN = process.env.NEXT_PUBLIC_VERSO_TEST_LOGIN === "1";

interface GoogleId {
  initialize(opts: { client_id: string; callback: (r: { credential: string }) => void; auto_select?: boolean; ux_mode?: string }): void;
  renderButton(el: HTMLElement, opts: Record<string, unknown>): void;
}

function googleId(): GoogleId | undefined {
  return (window as { google?: { accounts?: { id?: GoogleId } } }).google?.accounts?.id;
}

const STEPS = [
  ["Enviar", "Escolha um EPUB ou PDF. O livro fica guardado só no seu aparelho."],
  ["Prévia grátis", "Veja um trecho traduzido antes de traduzir o livro todo."],
  ["Traduzir e baixar", "Capítulo por capítulo, com nomes consistentes. Baixe em EPUB ou PDF."],
];

/** Tela de entrada da versão pública: apresentação curta + “Entrar com Google”. */
export function LoginScreen({ onSignIn }: { onSignIn: (u: VersoUser) => void }) {
  const buttonRef = useRef<HTMLDivElement>(null);
  const [scriptReady, setScriptReady] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (googleId()) setScriptReady(true);
  }, []);

  useEffect(() => {
    const id = googleId();
    if (!scriptReady || !id || !CLIENT_ID || !buttonRef.current) return;
    id.initialize({
      client_id: CLIENT_ID,
      callback: ({ credential }) => {
        const u = userFromGoogleCredential(credential);
        if (u) onSignIn(u);
        else setError("Não foi possível entrar com o Google. Tente de novo.");
      },
    });
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    id.renderButton(buttonRef.current, {
      type: "standard",
      theme: dark ? "filled_black" : "outline",
      size: "large",
      text: "continue_with",
      shape: "pill",
      locale: "pt-BR",
      width: Math.min(320, buttonRef.current.clientWidth || 320),
    });
  }, [scriptReady, onSignIn]);

  return (
    <div className="min-h-dvh">
      {CLIENT_ID && <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" onReady={() => setScriptReady(true)} />}
      <header className="mx-auto flex w-full max-w-5xl items-center px-5 pt-[max(1.1rem,env(safe-area-inset-top))] pb-4 sm:px-8 sm:pt-7">
        <Wordmark />
      </header>
      <main className="mx-auto w-full max-w-[42rem] px-5 pt-8 pb-24 sm:px-8 sm:pt-16">
        <section className="rise">
          <h1 className="serif text-[3.1rem] leading-[0.98] font-[380] tracking-[-0.035em] text-ink sm:text-[4.6rem]">
            Traduza seu livro<span className="text-accent">.</span>
          </h1>
          <p className="serif mt-5 max-w-[32rem] text-[1.25rem] leading-[1.45] text-ink-2 sm:text-[1.375rem]">
            Livros inteiros em outro idioma, preservando capítulos e formatação — de graça, com uma chave gratuita de IA.
          </p>
        </section>

        <section className="rise mt-10" style={{ animationDelay: "80ms" }}>
          <div className="rounded-[1.25rem] border border-rule px-6 py-7 sm:px-8">
            <p className="label">Comece por aqui</p>
            {CLIENT_ID ? (
              <div ref={buttonRef} className="mt-4 flex min-h-11 w-full max-w-[320px] items-center" />
            ) : (
              <p className="mt-3 text-[0.875rem] text-ink-2">
                O login com Google ainda não foi configurado neste site (falta <code className="text-[0.8125rem]">NEXT_PUBLIC_GOOGLE_CLIENT_ID</code>
                ).
              </p>
            )}
            {TEST_LOGIN && (
              <Button
                variant="secondary"
                className="mt-4"
                onClick={() => onSignIn({ sub: "visitante-teste", name: "Visitante (teste)", email: "teste@exemplo.com" })}
              >
                Entrar como visitante (teste)
              </Button>
            )}
            {error && <p className="mt-3 text-[0.875rem] text-accent">{error}</p>}
            <p className="mt-5 text-[0.8125rem] leading-relaxed text-muted">
              A conta Google só identifica você neste aparelho. Seus livros e sua chave de IA ficam guardados no seu navegador — não em um servidor
              nosso.
            </p>
          </div>
        </section>

        <ol className="mt-14 grid gap-7 border-t border-rule pt-10 sm:grid-cols-3 sm:gap-6">
          {STEPS.map(([title, text], i) => (
            <li key={title}>
              <span className="num flex h-7 w-7 items-center justify-center rounded-full border border-rule-strong text-[0.8125rem] text-ink-2">
                {i + 1}
              </span>
              <h3 className="serif mt-3 text-[1.125rem] text-ink">{title}</h3>
              <p className="mt-1.5 text-[0.875rem] leading-relaxed text-muted">{text}</p>
            </li>
          ))}
        </ol>
      </main>
    </div>
  );
}
