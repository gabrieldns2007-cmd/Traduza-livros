"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/client";
import { quotaText, type QuotaInfo } from "@/lib/quota-format";
import { formatBytes } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { LinkPending } from "@/components/ui/pending";
import { useSession } from "./public-shell";

interface FreeService {
  id: string;
  label: string;
  hasKey: boolean;
  model: string;
  quota: QuotaInfo | null;
}

/** Minha conta: perfil, créditos grátis de hoje, livros e dados deste aparelho. */
export function AccountView() {
  const session = useSession();
  const [free, setFree] = useState<FreeService[] | null>(null);
  const [books, setBooks] = useState<number | null>(null);
  const [usage, setUsage] = useState<number | null>(null);
  const [wiping, setWiping] = useState(false);

  useEffect(() => {
    api<{ free: FreeService[] }>("/api/settings")
      .then((d) => setFree(d.free))
      .catch(() => setFree([]));
    api<{ books: unknown[] }>("/api/books")
      .then((d) => setBooks(d.books.length))
      .catch(() => setBooks(0));
    navigator.storage
      ?.estimate?.()
      .then((e) => setUsage(e.usage ?? null))
      .catch(() => {});
  }, []);

  if (!session) return null;
  const { user, signOut } = session;

  const wipe = async () => {
    if (!confirm("Apagar todos os seus livros, traduções e chaves deste aparelho? Isso não pode ser desfeito.")) return;
    setWiping(true);
    const { promises } = await import("@/lib/browser/fs");
    await promises.wipe(`/u/${user.sub.replace(/[^\w-]/g, "")}`);
    signOut();
  };

  const withKey = free?.filter((s) => s.hasKey) ?? [];

  return (
    <main className="mx-auto w-full max-w-[42rem] px-5 pt-8 pb-24 sm:px-8 sm:pt-14">
      <header className="rise flex items-center gap-4">
        <span className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full border border-rule bg-paper-2">
          {user.picture ? (
            // eslint-disable-next-line @next/next/no-img-element -- foto do Google, pequena
            <img src={user.picture} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
          ) : (
            <span className="serif text-[1.6rem] text-ink-2">{user.name.slice(0, 1).toUpperCase()}</span>
          )}
        </span>
        <div className="min-w-0">
          <h1 className="serif truncate text-[2rem] leading-tight tracking-[-0.02em] text-ink sm:text-[2.4rem]">{user.name}</h1>
          {user.email && <p className="truncate text-[0.9375rem] text-muted">{user.email}</p>}
        </div>
      </header>

      <section className="mt-12 border-t border-rule pt-6">
        <h2 className="label">Créditos grátis de hoje</h2>
        {!free ? (
          <div className="mt-5 h-20 animate-pulse rounded-2xl bg-paper-2" />
        ) : withKey.length ? (
          <ul className="mt-4 divide-y divide-rule border-y border-rule">
            {withKey.map((s) => {
              const q = quotaText(s.quota);
              return (
                <li key={s.id} className="flex items-baseline justify-between gap-4 py-3">
                  <span className="min-w-0">
                    <span className="block text-[0.9375rem] text-ink">{s.label}</span>
                    <span className="block truncate text-[0.8125rem] text-muted">{s.model}</span>
                  </span>
                  {q && <span className={`shrink-0 text-right text-[0.8125rem] ${q.tone === "out" ? "text-accent" : "text-ok"}`}>{q.text}</span>}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-4 text-[0.9375rem] leading-relaxed text-ink-2">
            Você ainda não adicionou nenhuma chave gratuita. Leva um minuto e não pede cartão.
          </p>
        )}
        <Link href="/configuracoes" className="link mt-4 inline-flex items-center gap-1.5 text-[0.875rem] text-ink-2 hover:text-ink">
          {withKey.length ? "Gerenciar chaves gratuitas" : "Adicionar uma chave gratuita"}
          <LinkPending />
        </Link>
      </section>

      <section className="mt-12 border-t border-rule pt-6">
        <h2 className="label">Seus livros</h2>
        <p className="mt-4 text-[0.9375rem] text-ink">
          {books === null ? "…" : books === 0 ? "Nenhum livro ainda." : books === 1 ? "Um livro neste aparelho." : `${books} livros neste aparelho.`}
          {usage !== null && usage > 0 && <span className="text-muted"> Ocupando {formatBytes(usage)}.</span>}
        </p>
        <p className="mt-2 text-[0.8125rem] leading-relaxed text-muted">
          Seus livros, traduções e chaves ficam guardados só neste navegador. Para ler em outro lugar, baixe o EPUB ou o PDF de cada livro.
        </p>
        <Link href="/livros" className="link mt-4 inline-flex items-center gap-1.5 text-[0.875rem] text-ink-2 hover:text-ink">
          Ver meus livros
          <LinkPending />
        </Link>
      </section>

      <section className="mt-12 flex flex-col gap-3 border-t border-rule pt-6 sm:flex-row sm:items-center">
        <Button variant="secondary" onClick={signOut}>
          Sair
        </Button>
        <button onClick={wipe} disabled={wiping} className="link py-2 text-[0.875rem] text-muted hover:text-accent disabled:opacity-50">
          {wiping ? "Apagando…" : "Apagar meus dados deste aparelho"}
        </button>
      </section>
    </main>
  );
}
