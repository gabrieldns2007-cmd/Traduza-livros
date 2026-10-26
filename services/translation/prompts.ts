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
import { mentions, searchable } from "@/services/glossary/glossary";
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

/**
 * Português do Brasil, fixo para o livro inteiro: quando o modelo muda no meio do
 * livro, o tratamento e o vocabulário não dependem dos parágrafos anteriores
 * (que nem existem no começo de um capítulo). Texto fixo: o prompt continua estável.
 */
function variantRule(book: BookContext): string {
  const code = book.targetCode.toLowerCase();
  if (code !== "pt-br" && code !== "pt") return "";
  return "Brazilian Portuguese throughout: address people as “você” by default and as “o senhor”/“a senhora” in formal or respectful speech (archaic or solemn address — thou, prayers — may use “tu” or “vós”, consistently); use Brazilian constructions (“estava fazendo”, never “estava a fazer”), Brazilian vocabulary and spelling (trem, ônibus, celular, banheiro, garota, fato, contato, ótimo — never comboio, autocarro, telemóvel, casa de banho, rapariga, facto, contacto, óptimo); keep one quotation-mark style for the whole book (“…”, with ‘…’ inside).";
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
  const variant = variantRule(book);
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
${variant ? `- ${variant}\n` : ""}- Headings and chapter titles are translated too; number words in headings become their ${book.targetLanguage} equivalents (keep roman or arabic numerals as they are).
- Leave untouched: URLs, e-mail addresses, code, footnote markers, numbers that are references, and text already written in ${book.targetLanguage}. Foreign-language phrases that the author left untranslated stay untranslated.
${extra ? `\nInstructions from the reader (follow them):\n${extra}\n` : ""}
Output format
- The input is a list of <seg id="N">…</seg> elements. Return every one of them, in the same order, as <seg id="N">translation</seg> — exactly one output segment per input segment, never merged, split or skipped. Output nothing before, between or after the segments.
- Segments may contain inline tags such as <em_3>…</em_3>, <strong_4>…</strong_4>, <a_7>…</a_7> or empty tags like <br_5/>. Keep every tag, with the same name and number, around the corresponding translated words, properly nested. Do not add, drop or rename tags.
- In verse, each <br_N/> marks a line break: keep it at the same break between lines, never replace it with a newline.
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
  parts.push(input.strict ? retryInstruction(input) : `Translate these segments into ${input.book.targetLanguage}:`);
  for (const s of input.segments) parts.push(`<seg id="${s.id}">${s.text}</seg>`);
  return parts.join("\n");
}

/** O que corrigir em cada motivo de nova tentativa (códigos de lib/quality.ts e do processador). */
function retryHints(target: string): Record<string, string> {
  return {
    missing: `Some segments were missing: return every segment as <seg id="N">…</seg>, each one closed with </seg>.`,
    tags: "Inline tags were lost: keep every inline tag (same name and number) around the corresponding translated words.",
    empty: "Some segments came back empty: translate every segment.",
    // sem pedir para traduzir o que o autor deixou em outro idioma (o prompt de sistema manda manter)
    echo: `Some segments came back untranslated: translate every segment fully into ${target}; never copy the original text. Only names, titles, addresses and phrases the author deliberately left in another language stay as they are.`,
    "partial-echo": `Some segments were only partly translated: translate every sentence into ${target}; never leave parts of the original untranslated. Only names, titles and phrases the author deliberately left in another language stay as they are.`,
    "wrong-language": `Some segments were not written in ${target}: write the translation only in ${target}. Only names, titles and phrases the author deliberately left in another language stay as they are.`,
    leak: "Some segments contained parts of the request (<seg>, <context>, <think>…): put only the translated text inside each <seg>.",
    "stray-tag": "Some segments contained HTML or Markdown formatting that is not in the original: use only the numbered inline tags from the input.",
    "foreign-script": `Some segments contained characters from another writing system: write only in ${target} (names stay as in the original).`,
    commentary: "Some segments contained notes, comments or apologies: return only the translation itself — no notes, explanations or remarks.",
    length: "Some segments were cut short or padded: translate each segment completely, without summarizing, skipping or adding anything.",
    misaligned: "Some segments received the translation of another segment: keep each translation in the segment with the same id.",
  };
}

function retryInstruction(input: BatchInput): string {
  const target = input.book.targetLanguage;
  const hints = retryHints(target);
  const reasons = [...new Set(input.issues ?? [])].map((i) => hints[i]).filter(Boolean);
  if (!reasons.length) {
    return `Translate these segments into ${target}. This is a retry: a previous attempt lost segments or inline tags. Return every segment and keep every inline tag (same name and number).`;
  }
  return `Translate these segments into ${target}. This is a retry; fix what went wrong in the previous attempt:\n${reasons.map((r) => `- ${r}`).join("\n")}\nReturn every segment and keep every inline tag (same name and number).`;
}

/** <think>, </think>, <seg id=…> e </seg> na ordem em que aparecem. */
const STRUCTURE_RE = /<\/?think>|<seg\s+id\s*=[^>]*>|<\/seg\s*>/gi;

/**
 * Posições dos <think> e </think> que são do modelo, e não texto do livro: um “<think>” dentro
 * de um trecho (entre um <seg id=…> e o </seg> dele, ex.: um livro sobre HTML) fica.
 */
function reasoningTags(text: string): { open: number[]; close: number[] } {
  const marks = [...text.matchAll(STRUCTURE_RE)].map((m) => ({ at: m.index ?? 0, tag: m[0].toLowerCase() }));
  const open: number[] = [];
  const close: number[] = [];
  marks.forEach((m, i) => {
    if (m.tag !== "<think>" && m.tag !== "</think>") return;
    let before: string | undefined;
    for (let j = i - 1; j >= 0 && !before; j--) if (!marks[j].tag.includes("think")) before = marks[j].tag;
    let after: string | undefined;
    for (let j = i + 1; j < marks.length && !after; j++) if (!marks[j].tag.includes("think")) after = marks[j].tag;
    const insideSeg = !!before?.startsWith("<seg") && !!after?.startsWith("</seg");
    if (!insideSeg) (m.tag === "<think>" ? open : close).push(m.at);
  });
  return { open, close };
}

/**
 * Tira o raciocínio que alguns modelos deixam no texto: tudo até o último </think>,
 * tudo depois de um <think> que não fechou (resposta cortada no meio do raciocínio)
 * e, nos modelos com canais (<|channel|>), tudo fora do canal final. Um “<think>” que
 * está dentro de um trecho traduzido é texto do livro e fica.
 */
export function stripReasoning(text: string): string {
  let t = text;
  if (t.includes("<|channel|>")) {
    const final = t.lastIndexOf("<|channel|>final");
    if (final < 0) return "";
    t = t.slice(final + "<|channel|>final".length).replace(/^[\s\S]*?<\|message\|>/, "");
    t = t.replace(/<\|[a-z_]{2,24}\|>[\s\S]*$/, "");
  }
  const { close } = reasoningTags(t);
  if (close.length) t = t.slice(close[close.length - 1] + "</think>".length);
  const { open } = reasoningTags(t);
  if (open.length) t = t.slice(0, open[0]);
  return t;
}

export interface ParseOptions {
  /**
   * id → texto enviado: se o mesmo id aparece mais de uma vez, o que é igual ao original
   * (a entrada repetida, antes ou depois da resposta) ou vazio perde para uma tradução
   */
  sources?: Map<number, string>;
  /**
   * a resposta terminou normalmente (não foi cortada no limite): o último trecho sem </seg>
   * vale até o fim do texto (ou até uma linha em branco, onde começa a conversa do modelo)
   */
  complete?: boolean;
}

/**
 * Extrai <seg id="N">…</seg> da resposta. Um trecho termina no </seg>, no próximo
 * <seg id=…> (o modelo esqueceu de fechar) ou no <new_terms>; um trecho que só
 * termina no fim do texto conta só se a resposta não foi cortada (`complete`).
 * Se o mesmo id aparece mais de uma vez, vale o último — o modelo às vezes repete a
 * entrada antes da resposta —, a não ser que o último seja vazio ou igual ao original
 * e um anterior não (a entrada repetida depois da resposta, “Original: …”).
 */
export function parseSegments(text: string, opts: ParseOptions = {}): Map<number, string> {
  const found = new Map<number, string[]>();
  const cleaned = stripReasoning(text).replace(/^```[a-z]*\n?|```$/gim, "");
  const end = opts.complete ? "|$" : "";
  const re = new RegExp(`<seg\\s+id\\s*=\\s*["']?(\\d+)["']?\\s*>([\\s\\S]*?)(?:<\\/seg\\s*>|(?=<seg\\s+id\\s*=|<new_terms>${end}))`, "g");
  for (const m of cleaned.matchAll(re)) {
    let body = m[2];
    // último trecho sem </seg> numa resposta completa: a conversa do modelo depois de uma linha em branco fica de fora
    if (opts.complete && (m.index ?? 0) + m[0].length >= cleaned.length && !/<\/seg\s*>$/.test(m[0])) body = body.split(/\n[ \t]*\n/)[0];
    const id = Number(m[1]);
    found.set(id, [...(found.get(id) ?? []), body.trim()]);
  }
  const out = new Map<number, string>();
  for (const [id, list] of found) {
    const src = opts.sources?.get(id)?.trim();
    const good = list.filter((t) => t && t !== src);
    out.set(id, good.length ? good[good.length - 1] : list[list.length - 1]);
  }
  return out;
}

/**
 * Lê o bloco <new_terms> que o modelo acrescenta depois dos segmentos. Com `source`
 * (o texto do lote), só ficam os termos que aparecem nele: um modelo mais fraco às
 * vezes inventa nomes, e o primeiro registro de um nome vale para o livro todo.
 */
export function parseNewTerms(text: string, source?: string): { term: string; translation: string; type: GlossaryEntry["type"] }[] {
  const block = /<new_terms>([\s\S]*?)<\/new_terms>/.exec(stripReasoning(text))?.[1];
  if (!block) return [];
  const types = new Set(["character", "place", "organization", "term", "other"]);
  // apóstrofos (’/'), NBSP, acentos decompostos e plurais (“Dementor” em “dementors”) não contam
  const hay = source === undefined ? undefined : searchable(source);
  const out: { term: string; translation: string; type: GlossaryEntry["type"] }[] = [];
  for (const line of block.split("\n")) {
    const m = /^\s*[-*]?\s*(.+?)\s*=>\s*(.+?)\s*(?:\|\s*([a-z]+))?\s*$/i.exec(line);
    if (!m) continue;
    const term = m[1].trim();
    const translation = m[2].trim();
    if (!term || !translation || term.length > 80 || translation.length > 120) continue;
    if (hay !== undefined && !mentions(hay, term, true)) continue;
    const t = (m[3] ?? "other").toLowerCase();
    out.push({ term, translation, type: (types.has(t) ? t : "other") as GlossaryEntry["type"] });
  }
  return out.slice(0, 20);
}

export function analysisSystemPrompt(): string {
  return `You help a literary translator prepare a translation. You read excerpts of a book and produce concise, accurate reference notes. All descriptive fields (genre, tone, narrativeVoice, styleNotes, synopsis, summaries and glossary notes) must be written in Brazilian Portuguese, because they are shown to the reader in a Portuguese interface. Respond only with the requested JSON.`;
}

/** `glossaryEntries`: menos entradas quando o serviço tem um teto de saída baixo (a resposta não pode ser cortada). */
export function bookAnalysisPrompt(input: BookAnalysisInput, opts: { glossaryEntries?: number } = {}): string {
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
- glossary: the important proper names and recurring special terms that appear in the excerpts — characters, places, organizations, invented or technical terms, titles/honorifics — with their ${b.targetLanguage} rendering (people's names usually stay unchanged). Up to ${opts.glossaryEntries ?? 60} entries, most important first. note: a few words of context (who/what it is, gender if relevant for agreement).
- tocTranslations: the ${b.targetLanguage} translation of each table-of-contents entry, same order and same count (${input.tocLabels.length}).`;
}

export function chapterAnalysisPrompt(input: ChapterAnalysisInput, opts: { newTerms?: number } = {}): string {
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
- newTerms: proper names and recurring special terms from this chapter that are NOT in known_terms — characters, places, organizations, invented terms, nicknames — with their ${b.targetLanguage} rendering (people's names usually stay unchanged). Only terms that matter for consistency; at most ${opts.newTerms ?? 30}. note: a few words of context.`;
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
