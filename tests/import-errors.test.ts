/** Mensagens de envio que o cliente entende: arquivo danificado não é "formato errado". */
import { describe, expect, it } from "vitest";
import { importBook } from "@/services/parsing/import-book";

const junk = new TextEncoder().encode("isto não é um livro");

describe("arquivo que não abre", () => {
  it(".epub ou .pdf com conteúdo estragado: fala em arquivo danificado ou protegido", async () => {
    for (const fileName of ["livro.epub", "LIVRO.PDF"]) {
      await expect(importBook(junk, { fileName, targetLanguage: "pt-BR" })).rejects.toThrow(/danificado, incompleto ou protegido por DRM/);
    }
  });
  it("outro tipo de arquivo: pede .epub ou .pdf", async () => {
    await expect(importBook(junk, { fileName: "livro.docx", targetLanguage: "pt-BR" })).rejects.toThrow(/Envie um arquivo \.epub ou \.pdf/);
  });
});
