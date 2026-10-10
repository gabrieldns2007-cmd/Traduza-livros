"use client";

import { useState } from "react";

/**
 * Baixar o PDF: ele leva alguns segundos para ser gerado, então o botão mostra
 * “Gerando PDF…” e um erro legível se falhar (página do livro e estante).
 */
export function usePdfDownload(bookId: string) {
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState("");

  const download = async () => {
    setState("loading");
    setError("");
    try {
      const res = await fetch(`/api/books/${bookId}/export/pdf`);
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Não foi possível gerar o PDF.");
      const blob = await res.blob();
      const name = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get("content-disposition") ?? "")?.[1];
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name ? decodeURIComponent(name) : "livro.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setState("idle");
    } catch (err) {
      setError((err as Error).message);
      setState("error");
    }
  };

  return { loading: state === "loading", error: state === "error" ? error : "", download };
}
