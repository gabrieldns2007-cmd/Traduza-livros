"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { clearSession, readSession, saveSession, type VersoUser } from "@/lib/browser/session";
import { listenEarly, startLocalBackend, useDataDirFor } from "@/lib/browser/bridge";
import { interceptDownloadLinks } from "@/lib/browser/downloads";
import { PageLoading } from "@/components/ui/page-loading";
import { LoginScreen } from "./login-screen";

interface SessionValue {
  user: VersoUser;
  signOut: () => void;
}

const SessionContext = createContext<SessionValue | null>(null);

/** Quem entrou (só na versão pública; null no Verso de servidor próprio). */
export function useSession() {
  return useContext(SessionContext);
}

/**
 * Versão pública: exige login com Google e liga o “servidor” do navegador
 * (livros no aparelho, tradução com a chave de cada pessoa) antes de mostrar o site.
 */
export function PublicShell({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<VersoUser | null | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    listenEarly();
    setUser(readSession());
    return interceptDownloadLinks();
  }, []);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    useDataDirFor(user.sub);
    startLocalBackend()
      .then(() => alive && setReady(true))
      .catch((err) => alive && setError((err as Error).message));
    return () => {
      alive = false;
    };
  }, [user]);

  const signIn = useCallback((u: VersoUser) => {
    saveSession(u);
    setUser(u);
  }, []);

  const signOut = useCallback(() => {
    clearSession();
    (window as { google?: { accounts?: { id?: { disableAutoSelect(): void } } } }).google?.accounts?.id?.disableAutoSelect();
    // recarrega para soltar a trava da aba e trocar a pasta de dados
    window.location.href = "/";
  }, []);

  if (user === undefined) return <PageLoading label="Abrindo o Verso…" />;
  if (!user) return <LoginScreen onSignIn={signIn} />;
  if (error)
    return (
      <main className="mx-auto max-w-md px-5 pt-24 text-center">
        <p className="serif text-[1.5rem] text-ink">Não foi possível abrir o Verso.</p>
        <p className="mt-3 text-[0.9375rem] text-ink-2">{error}</p>
      </main>
    );
  if (!ready) return <PageLoading label="Abrindo sua estante…" />;
  return <SessionContext.Provider value={{ user, signOut }}>{children}</SessionContext.Provider>;
}
