"use client";

import type { BookSummary } from "@/types/book";

/** Envia o EPUB/PDF com o andamento do envio (0–1). Responde com o livro criado. */
export function uploadWithProgress(file: File, target: string, source: string, onProgress: (p: number) => void): Promise<BookSummary> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/books");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data: { book?: BookSummary; error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* resposta vazia */
      }
      if (xhr.status === 401) window.location.href = "/entrar";
      if (xhr.status >= 200 && xhr.status < 300 && data.book) resolve(data.book);
      else reject(new Error(data.error ?? "Não foi possível enviar o arquivo."));
    };
    xhr.onerror = () => reject(new Error("A conexão caiu durante o envio. Tente novamente."));
    const form = new FormData();
    form.append("file", file);
    form.append("targetLanguage", target);
    form.append("sourceLanguage", source);
    xhr.send(form);
  });
}
