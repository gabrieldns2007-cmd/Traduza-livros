import Link from "next/link";

/** Rodapé do serviço: preços e textos legais sempre a um toque. */
export function SiteFooter() {
  return (
    <footer className="mx-auto w-full max-w-[56rem] border-t border-rule px-5 pt-6 pb-10 sm:px-8">
      <nav className="flex flex-wrap gap-x-6 text-[0.875rem] text-muted" aria-label="Rodapé">
        <Link href="/precos" className="inline-flex min-h-11 items-center hover:text-ink">
          Preços
        </Link>
        <Link href="/termos" className="inline-flex min-h-11 items-center hover:text-ink">
          Termos de uso
        </Link>
        <Link href="/privacidade" className="inline-flex min-h-11 items-center hover:text-ink">
          Privacidade
        </Link>
      </nav>
      <p className="mt-2 text-[0.8125rem] text-muted">Verso · tradução de livros</p>
    </footer>
  );
}
