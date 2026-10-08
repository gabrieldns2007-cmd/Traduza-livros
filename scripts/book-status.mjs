#!/usr/bin/env node
/**
 * Mostra, SEM alterar nada, o que está salvo de cada livro:
 * capítulos concluídos (conferidos nos arquivos de segmentos), palavras
 * traduzidas, termos do glossário e de qual capítulo a tradução continua.
 *
 *   npm run status            (todos os livros)
 *   npm run status -- <id>    (um livro)
 */
import fs from "node:fs";
import path from "node:path";

const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data"));
const booksDir = path.join(dataDir, "books");
const only = process.argv[2];
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

if (!fs.existsSync(booksDir)) {
  console.log(`Nenhum livro encontrado em ${booksDir}`);
  process.exit(0);
}

for (const id of fs.readdirSync(booksDir).sort()) {
  if (only && id !== only) continue;
  const dir = path.join(booksDir, id);
  const metaFile = path.join(dir, "book.json");
  if (!fs.existsSync(metaFile)) continue;
  const meta = read(metaFile);
  const docs = new Map();
  for (const d of meta.docs) {
    const f = path.join(dir, "docs", `${d.id}.json`);
    docs.set(d.id, fs.existsSync(f) ? read(f) : { segments: [] });
  }
  let done = 0;
  let words = 0;
  let segments = 0;
  let next = null;
  meta.chapters.forEach((c, i) => {
    const range = docs.get(c.docId).segments.slice(c.start, c.end);
    const translated = range.filter((s) => s.out !== undefined);
    words += translated.reduce((a, s) => a + s.words, 0);
    segments += translated.length;
    const complete = range.length > 0 && range.every((s) => s.out !== undefined || s.failed);
    if (complete) done++;
    else if (!next) next = { n: i + 1, title: c.title, partial: translated.length, total: range.length };
  });
  const glossaryFile = path.join(dir, "glossary.json");
  const glossary = fs.existsSync(glossaryFile) ? read(glossaryFile).length : 0;
  console.log(`\n${meta.title}  (${id})`);
  console.log(`  status salvo:          ${meta.status}${meta.error ? ` — ${meta.error}` : ""}`);
  console.log(`  capítulos concluídos:  ${done} de ${meta.chapters.length}`);
  console.log(`  palavras traduzidas:   ${words} de ${meta.totals.words} (${((words / meta.totals.words) * 100).toFixed(1)}%)`);
  console.log(`  trechos traduzidos:    ${segments} de ${meta.totals.segments}`);
  console.log(`  glossário:             ${glossary} termos`);
  console.log(
    next
      ? `  continua do capítulo:  ${next.n} — ${next.title}${next.partial ? ` (${next.partial} de ${next.total} trechos já prontos)` : ""}`
      : "  tradução completa",
  );
}
