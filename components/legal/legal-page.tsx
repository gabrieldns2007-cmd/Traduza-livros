import type { ReactNode } from "react";

export const LEGAL_UPDATED = "8 de outubro de 2026";

/** Quem vende, como aparece nos textos legais (configurado no painel → Vendas). */
export function sellerOf(business: { name?: string; email?: string } | undefined) {
  return {
    name: business?.name || "Verso",
    email: business?.email || null,
  };
}

export function Contact({ email }: { email: string | null }) {
  return email ? (
    <a href={`mailto:${email}`} className="link text-ink">
      {email}
    </a>
  ) : (
    <span>o e-mail de contato indicado no site</span>
  );
}

/** Página de texto legal: legível no celular, sem letras miúdas. */
export function LegalPage({ title, intro, children }: { title: string; intro: ReactNode; children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-[40rem] px-5 pt-8 pb-24 sm:px-8 sm:pt-14">
      <h1 className="rise serif text-[2.4rem] leading-[1.05] font-[380] tracking-[-0.03em] text-ink sm:text-[3rem]">{title}</h1>
      <p className="mt-3 text-[0.8125rem] text-muted">Última atualização: {LEGAL_UPDATED}</p>
      <div className="mt-6 text-[1rem] leading-relaxed text-ink-2">{intro}</div>
      <div className="mt-10 space-y-9 text-[0.9375rem] leading-relaxed text-ink-2 [&_h2]:serif [&_h2]:mb-2 [&_h2]:text-[1.35rem] [&_h2]:leading-snug [&_h2]:text-ink [&_li]:mt-1.5 [&_ul]:list-disc [&_ul]:pl-5">
        {children}
      </div>
    </main>
  );
}
