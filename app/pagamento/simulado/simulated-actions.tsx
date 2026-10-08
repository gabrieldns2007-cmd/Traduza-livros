"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function SimulatedActions({ token, successUrl, cancelUrl }: { token: string; successUrl: string; cancelUrl: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // no simulado, o “aviso do meio de pagamento” sai daqui; num meio de pagamento real,
  // ele vem do servidor dele direto para /api/payments/webhook/<meio>
  const approve = async () => {
    setBusy(true);
    setError("");
    const res = await fetch("/api/payments/webhook/simulado", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ s: token, result: "approved" }),
    });
    if (!res.ok) {
      setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Não foi possível aprovar.");
      setBusy(false);
      return;
    }
    window.location.href = successUrl;
  };

  return (
    <div className="mt-6">
      <Button onClick={approve} disabled={busy} className="w-full">
        {busy ? "Aprovando…" : "Aprovar pagamento de teste"}
      </Button>
      <a href={cancelUrl} className="link mx-auto mt-4 block w-fit py-1 text-[0.9375rem] text-ink-2 hover:text-ink">
        Cancelar e voltar
      </a>
      {error && (
        <p className="mt-4 text-center text-[0.9375rem] text-accent" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
