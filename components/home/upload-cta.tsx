"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ProgressBar } from "@/components/ui/progress-bar";
import { ArrowRight } from "@/components/ui/icons";
import { uploadWithProgress } from "./translate-flow";

/**
 * “Traduzir meu livro”: um botão só. Abre o seletor de arquivo, envia e leva
 * direto para a confirmação (idioma, preço). No computador, também aceita
 * arrastar o arquivo para cima do botão.
 */
export function UploadCta({
  targetLanguage,
  maxUploadMb,
  label = "Traduzir meu livro",
}: {
  targetLanguage: string;
  maxUploadMb: number;
  label?: string;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);

  const send = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    if (!/\.(epub|pdf)$/i.test(file.name)) return setError("Esse formato não é aceito. Escolha um arquivo .epub ou .pdf.");
    if (file.size > maxUploadMb * 1024 * 1024) return setError(`O arquivo passa do limite de ${maxUploadMb} MB.`);
    setName(file.name);
    setProgress(0);
    try {
      const book = await uploadWithProgress(file, targetLanguage, "auto", setProgress);
      router.push(`/livros/${book.id}`);
    } catch (err) {
      setError((err as Error).message);
      setProgress(null);
      if (input.current) input.current.value = "";
    }
  };

  if (progress !== null)
    return (
      <div className="w-full max-w-[26rem] rounded-2xl border border-rule px-5 py-4" aria-live="polite">
        <p className="truncate text-[0.9375rem] text-ink">{name}</p>
        <ProgressBar value={progress < 1 ? progress * 85 : 95} active className="mt-3" />
        <p className="mt-2 text-[0.8125rem] text-muted">
          {progress < 1 ? `Enviando… ${Math.round(progress * 100)}%` : "Lendo o livro e contando as palavras…"}
        </p>
      </div>
    );

  return (
    <div className="w-full">
      <input
        ref={input}
        type="file"
        accept=".epub,.pdf,application/epub+zip,application/pdf"
        className="sr-only"
        onChange={(e) => send(e.target.files?.[0])}
        aria-label="Escolher o livro"
        tabIndex={-1}
      />
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          send(e.dataTransfer.files?.[0]);
        }}
        className={`inline-flex h-14 w-full items-center justify-center gap-2.5 rounded-full px-8 text-[1.0625rem] font-medium tracking-[-0.005em] transition-[background-color,transform] duration-200 active:scale-[0.985] sm:w-auto ${
          dragging ? "bg-accent text-paper" : "bg-ink text-paper hover:bg-ink/88"
        }`}
      >
        {dragging ? "Solte o arquivo aqui" : label} <ArrowRight />
      </button>
      {error && (
        <p className="mt-3 text-[0.9375rem] text-accent" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
