"use client";

import { useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { uploadWithProgress } from "@/lib/upload";

/** Idioma de destino e limite de envio (o mesmo da página inicial). Sem isso, “Novo livro” leva à página inicial. */
export type UploadConfig = { targetLanguage: string; maxUploadMb: number };

export type NewBook = {
  /** abre o seletor de arquivo */
  pick: () => void;
  /** null = parado; 0–1 = enviando; 1 = lendo o livro */
  progress: number | null;
  /** “Enviando… 42%” / “Lendo o livro…” */
  status: string;
  error: string;
  /** o <input type="file"> escondido (renderizar uma vez) */
  input: ReactNode;
};

/**
 * “Novo livro” dentro da biblioteca: abre direto o seletor de arquivo, envia e
 * leva para a confirmação do livro — sem voltar para a página de venda.
 */
export function useNewBook(config: UploadConfig | undefined): NewBook | null {
  const router = useRouter();
  const ref = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");

  if (!config) return null;

  const send = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    if (!/\.(epub|pdf)$/i.test(file.name)) return setError("Esse formato não é aceito. Escolha um arquivo .epub ou .pdf.");
    if (file.size > config.maxUploadMb * 1024 * 1024) return setError(`O arquivo passa do limite de ${config.maxUploadMb} MB.`);
    setProgress(0);
    try {
      const book = await uploadWithProgress(file, config.targetLanguage, "auto", setProgress);
      router.push(`/livros/${book.id}`);
    } catch (err) {
      setError((err as Error).message);
      setProgress(null);
      if (ref.current) ref.current.value = "";
    }
  };

  return {
    pick: () => {
      if (progress === null) ref.current?.click();
    },
    progress,
    status: progress === null ? "" : progress < 1 ? `Enviando… ${Math.round(progress * 100)}%` : "Lendo o livro…",
    error,
    input: (
      <input
        ref={ref}
        type="file"
        accept=".epub,.pdf,application/epub+zip,application/pdf"
        className="sr-only"
        onChange={(e) => send(e.target.files?.[0])}
        aria-label="Escolher o livro"
        tabIndex={-1}
      />
    ),
  };
}
