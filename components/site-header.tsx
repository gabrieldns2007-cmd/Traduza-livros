"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Wordmark } from "./wordmark";
import { LinkPending } from "./ui/pending";
import { useSession } from "./public/public-shell";

const LINKS = [
  { href: "/", label: "Traduzir", short: "Traduzir", match: (p: string) => p === "/" },
  { href: "/livros", label: "Meus livros", short: "Livros", match: (p: string) => p.startsWith("/livros") },
  { href: "/planos", label: "Planos", short: "Planos", match: (p: string) => p.startsWith("/planos") },
  { href: "/configuracoes", label: "Configurações", short: "Ajustes", match: (p: string) => p.startsWith("/configuracoes") },
];

export function SiteHeader() {
  const pathname = usePathname() ?? "/";
  const session = useSession();
  // a tela de revisão tem a própria barra; o login não tem navegação
  if (/^\/livros\/[^/]+\/revisar/.test(pathname) || pathname === "/entrar") return null;
  return (
    <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-5 pt-[max(1.1rem,env(safe-area-inset-top))] pb-4 sm:px-8 sm:pt-7">
      <Wordmark />
      <nav className="flex items-center gap-1 text-[0.875rem] sm:gap-2">
        {LINKS.map((l) => {
          const active = l.match(pathname);
          return (
            <Link
              key={l.href}
              href={l.href}
              aria-current={active ? "page" : undefined}
              className={`rounded-full px-3 py-2 transition-colors active:bg-paper-2 ${active ? "text-ink" : "text-muted hover:text-ink"} ${l.href === "/" || l.href === "/planos" ? "hidden sm:inline-block" : ""}`}
            >
              <span className="sm:hidden">{l.short}</span>
              <span className="hidden sm:inline">{l.label}</span>
              {active ? <span className="mx-auto mt-0.5 block h-px w-3 bg-accent" /> : <LinkPending className="mx-auto mt-0.5 !block" />}
            </Link>
          );
        })}
        {session && (
          <Link
            href="/conta"
            aria-label="Minha conta"
            aria-current={pathname.startsWith("/conta") ? "page" : undefined}
            className="ml-1 flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border border-rule transition-colors hover:border-ink-2 active:bg-paper-2"
          >
            {session.user.picture ? (
              // eslint-disable-next-line @next/next/no-img-element -- foto do Google, pequena
              <img src={session.user.picture} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
            ) : (
              <span className="text-[0.8125rem] text-ink-2">{session.user.name.slice(0, 1).toUpperCase()}</span>
            )}
          </Link>
        )}
      </nav>
    </header>
  );
}
