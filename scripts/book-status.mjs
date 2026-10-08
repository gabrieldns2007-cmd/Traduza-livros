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
const readOr = (f, fallback) => {
  try {
    return fs.existsSync(f) ? read(f) : fallback;
  } catch (err) {
    console.log(`  (não consegui ler ${path.relative(dataDir, f)}: ${err.message})`);
    return fallback;
  }
};

if (!fs.existsSync(booksDir)) {
  console.log(`Nenhum livro encontrado em ${booksDir}`);
  process.exit(0);
}

let found = 0;
for (const id of fs.readdirSync(booksDir).sort()) {
  if (only && id !== only) continue;
  const dir = path.join(booksDir, id);
  const metaFile = path.join(dir, "book.json");
  if (!fs.existsSync(metaFile)) continue;
  found++;
  try {
    report(id, dir, read(metaFile));
  } catch (err) {
    console.log(`\nLivro ${id}: não consegui ler os dados (${err.message}). Nada foi alterado.`);
  }
}
if (!found) console.log(`Nenhum livro encontrado em ${booksDir}`);

function report(id, dir, meta) {
  const chapters = meta.chapters ?? [];
  const docs = new Map();
  for (const d of meta.docs ?? []) docs.set(d.id, readOr(path.join(dir, "docs", `${d.id}.json`), { segments: [] }));
  let done = 0;
  let words = 0;
  let segments = 0;
  let next = null;
  chapters.forEach((c, i) => {
    const range = (docs.get(c.docId)?.segments ?? []).slice(c.start, c.end);
    const translated = range.filter((s) => s && s.out !== undefined);
    words += translated.reduce((a, s) => a + (s.words || 0), 0);
    segments += translated.length;
    const complete = range.length > 0 && range.every((s) => s && (s.out !== undefined || s.failed));
    if (complete) done++;
    else if (!next) next = { n: i + 1, title: c.title, partial: translated.length, total: range.length };
  });
  const glossary = readOr(path.join(dir, "glossary.json"), []).length;
  const totalWords = meta.totals?.words || 0;
  console.log(`\n${meta.title ?? "(sem título)"}  (${id})`);
  console.log(`  status salvo:          ${meta.status}${meta.error ? ` — ${meta.error}` : ""}`);
  console.log(`  capítulos concluídos:  ${done} de ${chapters.length}`);
  console.log(`  palavras traduzidas:   ${words} de ${totalWords}${totalWords ? ` (${((words / totalWords) * 100).toFixed(1)}%)` : ""}`);
  console.log(`  trechos traduzidos:    ${segments} de ${meta.totals?.segments ?? "?"}`);
  console.log(`  glossário:             ${glossary} termos`);
  console.log(
    next
      ? `  continua do capítulo:  ${next.n} — ${next.title}${next.partial ? ` (${next.partial} de ${next.total} trechos já prontos)` : ""}`
      : chapters.length
        ? "  tradução completa"
        : "  (livro ainda sem capítulos — importação incompleta?)",
  );
}
