"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";

export function LoginForm({ endpoint = "/api/auth", fallback = "/" }: { endpoint?: string; fallback?: string }) {
  const params = useSearchParams();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
    if (res.ok) {
      const dest = params.get("de");
      window.location.href = dest && dest.startsWith("/") && !dest.startsWith("//") ? dest : fallback;
    } else {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "Não foi possível entrar.");
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-8">
      <label className="block">
        <span className="label">Senha</span>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="serif mt-2 w-full border-b border-rule-strong bg-transparent py-2 text-[1.3rem] text-ink outline-none focus:border-ink"
          autoFocus
        />
      </label>
      {error && <p className="mt-3 text-[0.875rem] text-accent">{error}</p>}
      <Button type="submit" disabled={busy || !password} className="mt-8 w-full">
        {busy ? "Entrando…" : "Entrar"}
      </Button>
    </form>
  );
}
