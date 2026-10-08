import { expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { importBook } from "@/services/parsing/import-book";
import { store } from "@/lib/storage";

it("reconstrói capítulos, parágrafos e itálico a partir de um PDF", async () => {
  const bytes = new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, "fixtures/sample.pdf")));
  const meta = await importBook(bytes, { fileName: "sample.pdf", targetLanguage: "pt-BR" });
  expect(meta.originalFormat).toBe("pdf");
  expect(meta.chapters.map((c) => c.title)).toEqual(["Chapter One", "Chapter Two"]);
  const doc = await store.readDoc(meta.id, meta.chapters[0].docId);
  const paragraphs = doc.segments.filter((s) => s.role === "paragraph");
  expect(paragraphs).toHaveLength(2);
  // itálico preservado e hifenização de fim de linha desfeita
  expect(paragraphs[0].src).toMatch(/<em_\d+>everyone<\/em_\d+>/);
  expect(paragraphs[0].src).toContain("hyphenation handling");
});
