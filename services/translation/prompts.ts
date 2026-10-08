/**
 * Prompts de tradução e análise.
 *
 * Princípios:
 *  - o prompt de sistema é estável durante todo o livro (perfil + regras),
 *    para aproveitar cache e manter consistência entre capítulos;
 *  - o contexto variável (glossário relevante, resumo da história, parágrafos
 *    anteriores) vai na mensagem do usuário, marcado como “só referência”;
 *  - a saída é um formato simples de recortar: <seg id="N">…</seg>.
 */
import type { GlossaryEntry } from "@/types/book";
import type { BatchInput, BookAnalysisInput, BookContext, ChapterAnalysisInput } from "./translation-provider";

const GLOSSARY_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["term", "translation", "type", "note"],
  properties: {
    term: { type: "string" },
    translation: { type: "string" },
    type: { type: "string", enum: ["character", "place", "organization", "term", "other"] },
    note: { type: "string" },
  },
} as const;

export const BOOK_ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sourceLanguage", "translatedTitle", "genre", "tone", "narrativeVoice", "styleNotes", "synopsis", "glossary", "tocTranslations"],
  properties: {
    sourceLanguage: { type: "string" },
    translatedTitle: { type: "string" },
    genre: { type: "string" },
    tone: { type: "string" },
    narrativeVoice: { type: "string" },
    styleNotes: { type: "string" },
    synopsis: { type: "string" },
    glossary: { type: "array", items: GLOSSARY_ITEM_SCHEMA },
    tocTranslations: { type: "array", items: { type: "string" } },
  },
} as const;

export const CHAPTER_ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "newTerms"],
  properties: {
    summary: { type: "string" },
    newTerms: { type: "array", items: GLOSSARY_ITEM_SCHEMA },
  },
} as const;

function dialogueRule(book: BookContext): string {
  if (book.options.dialogueStyle === "source") {
    return `Keep the dialogue structure of the original (quoted speech stays quoted), using the quotation marks customary in ${book.targetLanguage}.`;
  }
  const code = book.targetCode.toLowerCase();
  if (code.startsWith("pt")) {
    return "Format dialogue the way published Portuguese-language fiction does: spoken lines are introduced by an em dash (travessão, “—”) at the start of the paragraph, with em dashes around dialogue tags (— Venha comigo — disse ela. — Agora.), instead of quotation marks. Quotations that are not spoken dialogue (titles, quoted words, thoughts the author put in quotes) use “aspas curvas”. Apply this consistently.";
  }
  if (code.startsWith("es")) {
    return "Format dialogue the way published Spanish fiction does: spoken lines are introduced by a raya (—), with rayas around dialogue tags, instead of quotation marks. Other quotations use comillas angulares (« »). Apply this consistently.";
  }
  if (code.startsWith("fr")) {
    return "Format dialogue the way published French fiction does: guillemets (« … ») with non-breaking spaces, and an em dash (—) for changes of speaker inside a dialogue. Apply this consistently.";
  }
  if (code.startsWith("de")) return "Use German quotation marks („…“) for dialogue, as in published German fiction.";
  return `Use the dialogue and quotation-mark conventions of published fiction in ${book.targetLanguage}.`;
}

function profileBlock(book: BookContext): string {
  const p = book.profile;
  const lines = [`Title: ${book.title}`];
  if (book.author) lines.push(`Author: ${book.author}`);
  if (p?.genre) lines.push(`Genre: ${p.genre}`);
  if (p?.tone) lines.push(`Tone: ${p.tone}`);
  if (p?.narrativeVoice) lines.push(`Narrative voice: ${p.narrativeVoice}`);
  if (p?.styleNotes) lines.push(`Style notes: ${p.styleNotes}`);
  if (p?.synopsis) lines.push(`Synopsis: ${p.synopsis}`);
  return lines.join("\n");
}

export function translationSystemPrompt(book: BookContext): string {
  const extra = book.options.instructions?.trim();
  return `You are a literary translator preparing a published-quality ${book.targetLanguage} edition of a book written in ${book.sourceLanguage}. You translate it piece by piece; consistency across the whole book matters as much as the quality of each sentence.

<book>
${profileBlock(book)}
</book>

How to translate
- Translate everything, faithfully and completely, sentence by sentence — the way a professional literary translator would for a printed edition. Preserve the author's voice, tone, register, rhythm, humor, imagery and paragraphing. Never summarize, skip, censor, soften, add or explain.
- Write natural, idiomatic ${book.targetLanguage}. Avoid calques and constructions that read as translated, but don't "improve" or modernize the author.
- People's names stay as in the original unless the glossary says otherwise. Places, institutions and historical names use the established ${book.targetLanguage} form when one exists; otherwise keep the original. Invented terms get one consistent translation.
- The glossary in the context is binding: use exactly those renderings every time.
- Keep the narrative person and tense. Keep forms of address (formal/informal) and each character's way of speaking consistent with the preceding text.
- Dialogue: ${dialogueRule(book)}
- Headings and chapter titles are translated too; number words in headings become their ${book.targetLanguage} equivalents (keep roman or arabic numerals as they are).
- Leave untouched: URLs, e-mail addresses, code, footnote markers, numbers that are references, and text already written in ${book.targetLanguage}. Foreign-language phrases that the author left untranslated stay untranslated.
${extra ? `\nInstructions from the reader (follow them):\n${extra}\n` : ""}
Output format
- The input is a list of <seg id="N">…</seg> elements. Return every one of them, in the same order, as <seg id="N">translation</seg> — exactly one output segment per input segment, never merged, split or skipped. Output nothing before, between or after the segments.
- Segments may contain inline tags such as <em_3>…</em_3>, <strong_4>…</strong_4>, <a_7>…</a_7> or empty tags like <br_5/>. Keep every tag, with the same name and number, around the corresponding translated words, properly nested. Do not add, drop or rename tags.
- Everything inside <context> is reference material for consistency — never translate it or repeat it.
- After the last segment, if the text introduces proper names or recurring special terms (characters, places, organizations, invented words) that are NOT already in the glossary, list them once in this block, one per line, at most 15 lines; omit the block when there are none:
<new_terms>
Original term => translation | character|place|organization|term|other
</new_terms>`;
}

export function formatGlossary(entries: GlossaryEntry[]): string {
  return entries
    .map((e) => {
      const note = e.note ? ` — ${e.note}` : "";
      return `- ${e.term} → ${e.translation} (${e.type})${note}`;
    })
    .join("\n");
}

export function translationUserPrompt(input: BatchInput): string {
  const parts: string[] = ["<context>"];
  if (input.glossary.length) parts.push(`<glossary>\n${formatGlossary(input.glossary)}\n</glossary>`);
  if (input.storySoFar.length) parts.push(`<story_so_far>\n${input.storySoFar.join("\n")}\n</story_so_far>`);
  parts.push(
    `<current_chapter title="${escapeAttr(input.chapterTitle)}">${input.chapterSummary ? `\n${input.chapterSummary}\n` : ""}</current_chapter>`,
  );
  if (input.preceding.length) {
    parts.push(`<preceding_translation>\n${input.preceding.join("\n\n")}\n</preceding_translation>`);
  }
  parts.push("</context>");
  parts.push("");
  parts.push(
    input.strict
      ? `Translate these segments into ${input.book.targetLanguage}. This is a retry: a previous attempt lost segments or inline tags. Return every segment and keep every inline tag (same name and number).`
      : `Translate these segments into ${input.book.targetLanguage}:`,
  );
  for (const s of input.segments) parts.push(`<seg id="${s.id}">${s.text}</seg>`);
  return parts.join("\n");
}

/** Extrai <seg id="N">…</seg> da resposta. */
export function parseSegments(text: string): Map<number, string> {
  const out = new Map<number, string>();
  const cleaned = text.replace(/^```[a-z]*\n?|```$/gim, "");
  for (const m of cleaned.matchAll(/<seg\s+id\s*=\s*["']?(\d+)["']?\s*>([\s\S]*?)<\/seg\s*>/g)) {
    const id = Number(m[1]);
    if (!out.has(id)) out.set(id, m[2].trim());
  }
  return out;
}

/** Lê o bloco <new_terms> que o modelo acrescenta depois dos segmentos. */
export function parseNewTerms(text: string): { term: string; translation: string; type: GlossaryEntry["type"] }[] {
  const block = /<new_terms>([\s\S]*?)<\/new_terms>/.exec(text)?.[1];
  if (!block) return [];
  const types = new Set(["character", "place", "organization", "term", "other"]);
  const out: { term: string; translation: string; type: GlossaryEntry["type"] }[] = [];
  for (const line of block.split("\n")) {
    const m = /^\s*[-*]?\s*(.+?)\s*=>\s*(.+?)\s*(?:\|\s*([a-z]+))?\s*$/i.exec(line);
    if (!m) continue;
    const term = m[1].trim();
    const translation = m[2].trim();
    if (!term || !translation || term.length > 80 || translation.length > 120) continue;
    const t = (m[3] ?? "other").toLowerCase();
    out.push({ term, translation, type: (types.has(t) ? t : "other") as GlossaryEntry["type"] });
  }
  return out.slice(0, 20);
}

export function analysisSystemPrompt(): string {
  return `You help a literary translator prepare a translation. You read excerpts of a book and produce concise, accurate reference notes. All descriptive fields (genre, tone, narrativeVoice, styleNotes, synopsis, summaries and glossary notes) must be written in Brazilian Portuguese, because they are shown to the reader in a Portuguese interface. Respond only with the requested JSON.`;
}

export function bookAnalysisPrompt(input: BookAnalysisInput): string {
  const b = input.book;
  const toc = input.tocLabels.length
    ? `\n<table_of_contents>\n${input.tocLabels.map((l, i) => `${i + 1}. ${l}`).join("\n")}\n</table_of_contents>\n`
    : "";
  return `The book below will be translated from ${b.sourceLanguage === "auto" ? "its original language" : b.sourceLanguage} into ${b.targetLanguage}.

Title: ${b.title}${b.author ? `\nAuthor: ${b.author}` : ""}
${toc}
<excerpts>
${input.sample}
</excerpts>

Return JSON with:
- sourceLanguage: ISO 639-1 code of the book's language (e.g. "en").
- translatedTitle: the title in ${b.targetLanguage}. If the book has a well-known published ${b.targetLanguage} title, use it; otherwise translate it naturally. Keep it unchanged if it is a proper name that should not be translated.
- genre, tone, narrativeVoice (person, tense, narrator), styleNotes (sentence rhythm, register, dialogue style, notable devices), synopsis (2–3 sentences, no spoilers beyond the excerpts).
- glossary: the important proper names and recurring special terms that appear in the excerpts — characters, places, organizations, invented or technical terms, titles/honorifics — with their ${b.targetLanguage} rendering (people's names usually stay unchanged). Up to 60 entries, most important first. note: a few words of context (who/what it is, gender if relevant for agreement).
- tocTranslations: the ${b.targetLanguage} translation of each table-of-contents entry, same order and same count (${input.tocLabels.length}).`;
}

export function chapterAnalysisPrompt(input: ChapterAnalysisInput): string {
  const b = input.book;
  return `Book: ${b.title}${b.author ? ` — ${b.author}` : ""}. Translation: ${b.sourceLanguage} → ${b.targetLanguage}.
${input.previousSummaries.length ? `\n<previous_chapters>\n${input.previousSummaries.join("\n")}\n</previous_chapters>\n` : ""}
<known_terms>
${input.knownTerms.join("; ") || "(none yet)"}
</known_terms>

<chapter title="${escapeAttr(input.chapterTitle)}">
${input.text}
</chapter>

Return JSON with:
- summary: 2–4 sentences summarizing what happens in this chapter (who, where, key events), useful as context for translating later chapters.
- newTerms: proper names and recurring special terms from this chapter that are NOT in known_terms — characters, places, organizations, invented terms, nicknames — with their ${b.targetLanguage} rendering (people's names usually stay unchanged). Only terms that matter for consistency; at most 30. note: a few words of context.`;
}

/** Interpreta JSON de forma tolerante (texto em volta, blocos de código). */
export function parseJsonLoose<T>(text: string): T | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*|```\s*$/g, "");
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "'").replace(/[<>]/g, "");
}
