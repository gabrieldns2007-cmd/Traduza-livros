/**
 * Poesia sem desperdício de pedidos (a cota grátis do Gemini é de ~20 pedidos por dia).
 *
 * Um livro como “Devotions” (92 poemas curtos, um verso por parágrafo ou estrofes com
 * <br/>) passa pelo importador e pela fila de verdade, com um provedor falso que conta
 * os pedidos. Antes destas mudanças (medido na investigação, mesmo livro e mesma semente):
 * 51 pedidos (um verso por parágrafo), 17 (estrofes), 276 e 112 com recusas por citação.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeEpub } from "@/services/export/epub-writer";
import { importBook } from "@/services/parsing/import-book";
import { DEFAULT_SETTINGS, store } from "@/lib/storage";
import { providerConfigs, defaultProviderId } from "@/lib/config";
import { restoreLineBreaks, tagKeys, toPlainText } from "@/lib/markup";
import { jobRunner } from "@/services/processing/job-runner";
import { makeBatches, processChapters, SEG_WRAPPER_CHARS } from "@/services/processing/chapter-processor";
import { DEFAULT_ROUTING, levelOffered, routeProvider } from "@/services/commerce/routing";
import { recordExhausted } from "@/services/quota/usage";
import { createProvider } from "@/services/translation";
import { LLMTranslationProvider } from "@/services/translation/llm-provider";
import { GeminiClient } from "@/services/translation/llm/gemini";
import { ProviderError, type LLMRequest } from "@/services/translation/llm/types";
import { BillingStop } from "@/services/billing/run-ledger";
import type { BatchInput, BatchOutput, TranslationProvider } from "@/services/translation/translation-provider";
import { translationSystemPrompt } from "@/services/translation/prompts";
import type { Segment } from "@/types/book";

/* ---------- livro de poemas (determinístico) ---------- */

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ADJ =
  "dark wild blue slow quiet green silver cold bright small old soft deep white black golden thin pale sweet bitter early late long lonely holy patient tender broken shining hidden open empty heavy light restless gentle ancient narrow wide warm salt".split(
    " ",
  );
const NOUN =
  "heron pond pines field goldenrod grasshopper geese air owl bear mockingbird oaks snow river moon prayer grass body world sea morning evening rain wind stone shore fox deer swan lilies water branches leaves dunes harbor sky crow wren blackberries meadow path roots bones heart lamp door dog flowers marsh hills clouds bees fire hands mouth life death".split(
    " ",
  );
const VERB =
  "rises falls sings waits kneels drifts burns shines opens closes listens walks floats dreams breathes trembles wakes sleeps calls answers remembers forgets gleams shivers lingers".split(
    " ",
  );
const FUNC = "and of in over under into through with like as the a my your its".split(" ");
const TITLES = [
  "Wild Geese",
  "The Summer Day",
  "Morning Poem",
  "When Death Comes",
  "Heron Rises",
  "Mindful",
  "The Journey",
  "Snow Geese",
  "Blackwater Woods",
  "Sleeping",
];

function poem(r: () => number, targetWords: number) {
  const stanzas: string[][] = [];
  let words = 0;
  while (words < targetWords) {
    const lines: string[] = [];
    const n = 3 + Math.floor(r() * 5);
    for (let l = 0; l < n && words < targetWords; l++) {
      const w = 3 + Math.floor(r() * 7);
      const pick = (a: string[]) => a[Math.floor(r() * a.length)];
      const parts: string[] = [];
      while (parts.length < w) {
        const k = parts.length % 4;
        parts.push(k === 0 ? pick(FUNC) : k === 1 ? pick(ADJ) : k === 2 ? pick(NOUN) : pick(VERB));
      }
      let line = parts.join(" ");
      line = line[0].toUpperCase() + line.slice(1) + (r() < 0.3 ? "," : r() < 0.2 ? "." : "");
      if (r() < 0.08) line = line.replace(/(\w+)$/, "<i>$1</i>");
      lines.push(line);
      words += w;
    }
    stanzas.push(lines);
  }
  return stanzas;
}

type Layout = "line" | "stanza";

/** Folha de rosto, direitos, sumário e 92 poemas (~44 mil palavras no original da investigação). */
function poetryEpub(layout: Layout, poems = 92, seed = 7) {
  const r = rng(seed);
  const chapters: { title: string; body: string }[] = [
    {
      title: "Title Page",
      body: `<h1 class="title">Devotions</h1><p class="author">A. Poet</p><p class="publisher">Penguin Press · New York · 2017</p>`,
    },
    {
      title: "Copyright",
      body: `<p>Copyright © 2017 by A. Poet. All rights reserved. Penguin supports copyright. Copyright fuels creativity, encourages diverse voices, promotes free speech, and creates a vibrant culture. Thank you for buying an authorized edition of this book and for complying with copyright laws by not reproducing, scanning, or distributing any part of it in any form without permission.</p><p>Library of Congress Cataloging-in-Publication Data</p><p>ISBN 9780399563249 (hardcover)</p><p>ISBN 9780399563263 (ebook)</p>`,
    },
  ];
  const titles = Array.from(
    { length: poems },
    (_, c) => `${TITLES[c % TITLES.length]}${c >= TITLES.length ? ` ${Math.floor(c / TITLES.length) + 1}` : ""}`,
  );
  chapters.push({
    title: "Contents",
    body: `<h1>Contents</h1>` + titles.map((t, i) => `<p class="toc"><a href="ch${String(i + 4).padStart(3, "0")}.xhtml">${t}</a></p>`).join(""),
  });
  for (let c = 0; c < poems; c++) {
    const words = Math.round(0.82 * (r() < 0.55 ? 70 + r() * 230 : 400 + r() * 900));
    const st = poem(r, words);
    const verses =
      layout === "line"
        ? st.map((lines) => lines.map((l, i) => `<p class="${i === 0 ? "pf" : "pl"}">${l}</p>`).join("")).join("")
        : st.map((lines) => `<p class="stanza">${lines.join("<br/>")}</p>`).join("");
    chapters.push({ title: titles[c], body: `<h2 class="title">${titles[c]}</h2><div class="poem">${verses}</div>` });
  }
  return writeEpub({ title: "Devotions", author: "A. Poet", language: "en", chapters });
}

/* ---------- provedor falso que conta os pedidos ---------- */

interface Mode {
  /** poema “famoso”: a resposta para no 3º verso dele (como o filtro de citação do Gemini) */
  famousEvery?: number;
  /** cota do dia acaba depois de N pedidos de tradução */
  quotaAfter?: number;
  /** o modelo troca as quebras de verso (<br_N/>) por quebras de linha nesta fração das estrofes */
  newlineBr?: number;
}

interface Call {
  segs: number;
  chars: number;
  strict: boolean;
  refused: boolean;
}

/** Limites reais do Gemini (sem rede: só monta o provedor). */
const GEMINI_LIMITS = createProvider("gemini", { geminiApiKey: "chave-de-teste" }).limits;

class PoetryProvider implements TranslationProvider {
  id = "gemini";
  model = "gemini-3.8-flash";
  paid = false;
  limits = GEMINI_LIMITS;
  calls: Call[] = [];
  /** textos de todos os trechos enviados */
  sent: string[] = [];
  chapterAnalyses = 0;
  famous = new Set<string>();
  /** texto do trecho → título do poema */
  chapterOf = new Map<string, string>();
  constructor(private mode: Mode = {}) {}

  async analyzeBook(input: { tocLabels: string[] }) {
    return {
      sourceLanguage: "en",
      profile: { genre: "Poesia", tone: "Contemplativo", narrativeVoice: "Primeira pessoa lírica", styleNotes: "Versos livres" },
      glossary: [],
      tocTranslations: input.tocLabels.map((l) => `PT ${l}`),
      usage: { inputTokens: 3000, outputTokens: 1000 },
    };
  }
  async analyzeChapter() {
    this.quota();
    this.chapterAnalyses++;
    return { summary: "Um poema sobre a natureza.", newTerms: [], usage: { inputTokens: 500, outputTokens: 100 } };
  }
  private quota() {
    if (this.mode.quotaAfter !== undefined && this.calls.length + this.chapterAnalyses >= this.mode.quotaAfter) {
      throw new ProviderError("Limite gratuito atingido.", { fatal: true, code: "quota" });
    }
  }
  async translateBatch(input: BatchInput): Promise<BatchOutput> {
    this.quota();
    const r = rng(input.segments.reduce((h, s) => h * 31 + s.id + s.text.length, this.calls.length + 1));
    for (const s of input.segments) this.sent.push(s.text);
    const translations = new Map<number, string>();
    let refused = false;
    let famousLines = 0;
    let last = "";
    for (const s of input.segments) {
      const title = this.chapterOf.get(s.text) ?? "";
      if (title !== last) famousLines = 0;
      last = title;
      if (this.famous.has(title) && ++famousLines >= 3) {
        refused = true; // a resposta para aqui: nada depois deste ponto
        break;
      }
      let out = `PT ${s.text}`;
      if (this.mode.newlineBr && /<br_\d+\/>/.test(s.text) && r() < this.mode.newlineBr) out = out.replace(/<br_\d+\/>/g, "\n");
      translations.set(s.id, out);
    }
    this.calls.push({
      segs: input.segments.length,
      chars: input.segments.reduce((n, s) => n + s.text.length + SEG_WRAPPER_CHARS, 0),
      strict: !!input.strict,
      refused,
    });
    return { translations, truncated: false, refused, usage: { inputTokens: 1000, outputTokens: 500 } };
  }
}

async function waitFor(bookId: string, statuses: string[]) {
  for (let i = 0; i < 6000; i++) {
    const m = (await store.get(bookId))!;
    if (statuses.includes(m.status) && !jobRunner.isRunning(bookId)) return m;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timeout");
}

/** Importa o livro de poemas e roda a fila de verdade com o provedor falso. */
async function runBook(layout: Layout, mode: Mode = {}, opts: { deep?: boolean } = {}) {
  const meta = await importBook(await poetryEpub(layout), { fileName: "devotions.epub", targetLanguage: "pt-BR" });
  const provider = new PoetryProvider(mode);
  for (const [idx, c] of meta.chapters.entries()) {
    const doc = await store.readDoc(meta.id, c.docId);
    for (const s of doc.segments.slice(c.start, c.end)) provider.chapterOf.set(s.src, c.title);
    if (mode.famousEvery && idx >= 3 && (idx - 3) % mode.famousEvery === 1) provider.famous.add(c.title);
  }
  if (opts.deep) await store.update(meta.id, (m) => void (m.options.deepContext = true));
  jobRunner.providerFactory = () => provider;
  await jobRunner.start(meta.id);
  const done = await waitFor(meta.id, ["done", "error", "paused"]);
  let failed = 0;
  let brKept = 0;
  let brTotal = 0;
  for (const d of done.docs) {
    const doc = await store.readDoc(meta.id, d.id);
    for (const s of doc.segments) {
      if (s.failed) failed++;
      const brs = [...tagKeys(s.src)].filter((k) => doc.tags[String(k)]?.n === "br");
      brTotal += brs.length;
      if (s.out) brKept += brs.filter((k) => s.out!.includes(`_${k}/>`)).length;
    }
  }
  const run = done.runs!.find((x) => x.kind === "translation")!;
  return { meta: done, provider, run, failed, brKept, brTotal };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("poesia: menos pedidos por livro", () => {
  it("Gemini aceita até 400 trechos por pedido; os outros continuam com 120", () => {
    expect(GEMINI_LIMITS.maxSegments).toBe(400);
    expect(createProvider("groq", { groqApiKey: "chave-de-teste" }).limits.maxSegments).toBeUndefined();
    const items = Array.from({ length: 1000 }, (_, i) => ({
      seg: { i, tag: "p", role: "paragraph", src: "Short verse line here", words: 4 } as Segment,
    }));
    expect(makeBatches(items, 24000).map((b) => b.length)).toEqual([120, 120, 120, 120, 120, 120, 120, 120, 40]);
    // a moldura <seg id="N"></seg> conta no tamanho: 24000 / (21 + 21) = 571 → corta antes, em 400
    expect(makeBatches(items, 24000, 400).map((b) => b.length)).toEqual([400, 400, 200]);
    expect(makeBatches(items, 4200, 400)[0]).toHaveLength(100);
  });

  it("o limite de saída cobre a moldura de 400 versos curtos (abaixo do teto de 65.536 do Gemini)", async () => {
    const seen: LLMRequest[] = [];
    const llm = {
      providerId: "gemini",
      model: "gemini-3.8-flash",
      complete: async (req: LLMRequest) => {
        seen.push(req);
        return { text: "", stopReason: "end" as const, usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const provider = new LLMTranslationProvider(llm, { paid: false, limits: GEMINI_LIMITS });
    const book = {
      title: "t",
      sourceLanguage: "English",
      targetLanguage: "Brazilian Portuguese",
      targetCode: "pt-BR",
      options: { dialogueStyle: "target" as const, deepContext: false },
    };
    const segments = Array.from({ length: 400 }, (_, i) => ({ id: i + 1, text: "x".repeat(60) }));
    await provider.translateBatch({ book, glossary: [], storySoFar: [], chapterTitle: "c", preceding: [], segments });
    // ~24 mil caracteres: texto traduzido + 400 molduras + folga para o raciocínio
    expect(seen[0].maxTokens).toBe(Math.ceil(24000 * 1.2) + 400 * 8 + 8000);
    expect(seen[0].maxTokens).toBeLessThanOrEqual(65536);
    const huge = Array.from({ length: 400 }, (_, i) => ({ id: i + 1, text: "x".repeat(200) }));
    await provider.translateBatch({ book, glossary: [], storySoFar: [], chapterTitle: "c", preceding: [], segments: huge });
    expect(seen[1].maxTokens).toBe(64000);
  });

  it("um verso por parágrafo: 51 → poucos pedidos, grupos e lotes batem (sem sobras)", async () => {
    const { meta, provider, run, failed } = await runBook("line");
    expect(meta.status).toBe("done");
    expect(failed).toBe(0);
    expect(meta.progress.translatedWords).toBe(meta.totals.words);
    expect(provider.calls.length).toBeLessThanOrEqual(20); // antes: 51
    expect(run.requests).toBe(provider.calls.length + 1); // + análise do livro
    expect(provider.calls.every((c) => c.segs <= 400 && c.chars <= 24000)).toBe(true);
    // sem pedidos “sobra” pequenos entre grupos: só o último pode ser menor que 1/4 do limite
    const small = provider.calls.slice(0, -1).filter((c) => c.segs < 100 && c.chars < 6000);
    expect(small).toHaveLength(0);
    console.info(`[medida] um verso por parágrafo: ${provider.calls.length} pedidos de tradução (antes 51)`);
  });

  it("estrofes com <br/>: 17 → menos pedidos, sem sobras", async () => {
    const { meta, provider, failed, brKept, brTotal } = await runBook("stanza");
    expect(meta.status).toBe("done");
    expect(failed).toBe(0);
    expect(provider.calls.length).toBeLessThan(17);
    expect(brKept).toBe(brTotal);
    const small = provider.calls.slice(0, -1).filter((c) => c.segs < 100 && c.chars < 6000);
    expect(small).toHaveLength(0);
    console.info(`[medida] estrofes: ${provider.calls.length} pedidos de tradução (antes 17)`);
  });

  it("recusas por citação (1 poema em 12): bem menos pedidos e todas as recusas registradas", async () => {
    // o filtro de citação falso deixa passar só 2 versos do poema “famoso” por pedido: com o limite de
    // 2 divisões, num livro de um verso por parágrafo sobram mais versos falhos (vão para a revisão),
    // em troca de 4 vezes menos pedidos
    const line = await runBook("line", { famousEvery: 12 });
    const stanza = await runBook("stanza", { famousEvery: 12 });
    console.info(
      `[medida] recusas: verso por parágrafo ${line.provider.calls.length} pedidos (${line.run.refusedRequests} recusados, ${line.provider.calls.filter((c) => c.strict).length} novas tentativas), ${line.failed} trechos falharam (antes 276 / 178); ` +
        `estrofes ${stanza.provider.calls.length} pedidos (${stanza.run.refusedRequests} recusados, ${stanza.provider.calls.filter((c) => c.strict).length} novas tentativas), ${stanza.failed} falharam (antes 112 / 23)`,
    );
    expect(line.meta.status).toBe("done");
    expect(line.provider.calls.length).toBeLessThan(276 / 2); // antes: 276
    expect(line.run.refusedRequests).toBe(line.provider.calls.filter((c) => c.refused).length);
    expect(line.run.refusedRequests).toBeGreaterThan(0);
    expect(stanza.meta.status).toBe("done");
    expect(stanza.provider.calls.length).toBeLessThan(112 / 2); // antes: 112
    expect(stanza.failed).toBeLessThanOrEqual(23); // antes: 23 trechos sem tradução
  });

  it("cota do dia acaba depois de 16 pedidos: muito mais palavras salvas, nada traduzido duas vezes", async () => {
    const ideal = await runBook("line", { quotaAfter: 16 });
    expect(ideal.meta.status).toBe("paused");
    expect(ideal.meta.stopCode).toBe("quota");
    expect(ideal.meta.progress.translatedWords).toBeGreaterThan(10943 * 2); // antes: 10.943
    const refusing = await runBook("stanza", { famousEvery: 2, quotaAfter: 16 });
    expect(refusing.meta.stopCode).toBe("quota");
    expect(refusing.meta.progress.translatedWords).toBeGreaterThan(778); // antes: 778
    expect(refusing.run.requests).toBe(16 + 1); // 16 pedidos de tradução + a análise do livro
    console.info(
      `[medida] cota em 16 pedidos: ${ideal.meta.progress.translatedWords} palavras (antes 10943); ` +
        `estrofes com recusas: ${refusing.meta.progress.translatedWords} (antes 778)`,
    );

    // no dia seguinte: continua de onde parou, sem mandar de novo nada que já estava salvo
    const saved = new Set<string>();
    const pending = new Set<string>();
    for (const d of refusing.meta.docs) {
      for (const s of (await store.readDoc(refusing.meta.id, d.id)).segments) (s.out !== undefined ? saved : pending).add(s.src);
    }
    const nextDay = new PoetryProvider();
    jobRunner.providerFactory = () => nextDay;
    await jobRunner.start(refusing.meta.id);
    const done = await waitFor(refusing.meta.id, ["done", "error", "paused"]);
    expect(done.status).toBe("done");
    expect(nextDay.calls.length).toBeGreaterThan(0);
    const sentAgain = nextDay.sent.filter((t) => saved.has(t) && !pending.has(t));
    expect(sentAgain).toHaveLength(0);
    // as palavras de cada trecho entram uma vez só (sem contar o que ficou marcado como falho)
    let failedWords = 0;
    for (const d of done.docs)
      for (const s of (await store.readDoc(done.id, d.id)).segments) if (s.failed && s.out === undefined) failedWords += s.words;
    expect(done.progress.translatedWords).toBe(done.totals.words - failedWords);
    const runs = done.runs!.filter((r) => r.kind === "translation");
    expect(runs.reduce((n, r) => n + r.words, 0)).toBe(done.progress.translatedWords);
  });

  it("estrofes com quebras de verso trocadas por quebras de linha: sem nova tentativa, quebras preservadas", async () => {
    const { meta, provider, brKept, brTotal } = await runBook("stanza", { newlineBr: 0.25 });
    expect(meta.status).toBe("done");
    expect(provider.calls.filter((c) => c.strict)).toHaveLength(0); // antes: uma nova tentativa por lote com estrofes assim
    expect(brKept).toBe(brTotal); // antes: as quebras sumiam se a nova tentativa errasse igual
  });

  it("leitura atenta: poemas curtos não ganham a análise extra (e não são reanalisados)", async () => {
    const { meta, provider } = await runBook("line", {}, { deep: true });
    const long = meta.chapters.filter((c) => c.wordCount >= 1000).length;
    expect(provider.chapterAnalyses).toBe(long); // antes: uma por capítulo (95)
    expect(meta.chapters.every((c) => c.summary !== undefined)).toBe(true);
    console.info(`[medida] leitura atenta: ${provider.chapterAnalyses} análises de capítulo (antes 95)`);
  });
});

/* ---------- casos pequenos, direto no processador ---------- */

async function smallStanzaBook(stanzas: string[]) {
  const epub = await writeEpub({
    title: "Small Poems",
    language: "en",
    chapters: [{ title: "Poem", body: `<h2>Poem</h2>` + stanzas.map((s) => `<p>${s}</p>`).join("") }],
  });
  const meta = await importBook(epub, { fileName: "small.epub", targetLanguage: "pt-BR" });
  const doc = await store.readDoc(meta.id, meta.chapters[0].docId);
  return { meta, doc };
}

type Behavior = (input: BatchInput, call: number) => Partial<BatchOutput> | Error | void;

class ScriptedProvider implements TranslationProvider {
  id = "fake";
  model = "fake";
  paid = false;
  limits = { batchChars: 50_000, concurrency: 1 };
  calls: BatchInput[] = [];
  constructor(private behavior: Behavior = () => {}) {}
  async analyzeBook() {
    return { profile: { genre: "", tone: "", narrativeVoice: "", styleNotes: "" }, glossary: [], tocTranslations: [] };
  }
  async analyzeChapter() {
    return { summary: "", newTerms: [] };
  }
  async translateBatch(input: BatchInput): Promise<BatchOutput> {
    this.calls.push(input);
    const translations = new Map(input.segments.map((s) => [s.id, `PT ${s.text}`]));
    const b = this.behavior(input, this.calls.length);
    if (b instanceof Error) throw b;
    return { translations, truncated: false, refused: false, usage: { inputTokens: 10, outputTokens: 10 }, ...b };
  }
}

function hooks() {
  const stats = { requests: 0, retries: 0, refused: 0, words: 0, failed: 0 };
  return {
    stats,
    signal: new AbortController().signal,
    analysisLock: <T>(fn: () => Promise<T>) => fn(),
    onUsage: async (_u: unknown, info?: { retry?: boolean; refused?: boolean }) => {
      stats.requests++;
      if (info?.retry) stats.retries++;
      if (info?.refused) stats.refused++;
    },
    onProgress: async (_c: string, d: { words: number; failed: number }) => {
      stats.words += d.words;
      stats.failed += d.failed;
    },
    onChapterSaved: async () => {},
  };
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `The heron number ${i + 1} rises from the dark pond.`);

describe("recusas, cota e quebras de verso", () => {
  it("resposta recusada no meio: o que veio completo fica e só o resto é dividido", async () => {
    const { meta } = await smallStanzaBook(lines(16));
    // 1º pedido: para no 6º trecho (recusado); os seguintes dão certo
    const provider = new ScriptedProvider((input, call) => {
      if (call !== 1) return;
      return { translations: new Map(input.segments.slice(0, 5).map((s) => [s.id, `PT ${s.text}`])), refused: true };
    });
    const h = hooks();
    await processChapters(meta, [meta.chapters[0]], provider, h);
    const sent = provider.calls[0].segments.length;
    expect(sent).toBe(17); // título + 16 versos
    // o resto (12) vai em duas metades; nenhum trecho aceito volta
    expect(provider.calls.slice(1).map((c) => c.segments.length)).toEqual([6, 6]);
    const firstFive = new Set(provider.calls[0].segments.slice(0, 5).map((s) => s.text));
    for (const c of provider.calls.slice(1)) for (const s of c.segments) expect(firstFive.has(s.text)).toBe(false);
    expect(h.stats.refused).toBe(1);
    const doc = await store.readDoc(meta.id, meta.chapters[0].docId);
    expect(doc.segments.every((s) => s.out?.startsWith("PT "))).toBe(true);
  });

  it("recusa que se repete: no máximo 2 divisões, depois uma nova tentativa e o trecho fica marcado", async () => {
    const { meta } = await smallStanzaBook(lines(15));
    const provider = new ScriptedProvider(() => ({ translations: new Map(), refused: true }));
    const h = hooks();
    await processChapters(meta, [meta.chapters[0]], provider, h);
    // 1 pedido + 2 metades + 4 quartos + 1 nova tentativa para cada quarto (antes: 31 pedidos)
    expect(provider.calls).toHaveLength(1 + 2 + 4 + 4);
    expect(provider.calls.filter((c) => c.strict)).toHaveLength(4);
    expect(h.stats.refused).toBe(11);
    expect(h.stats.failed).toBe(16);
    const doc = await store.readDoc(meta.id, meta.chapters[0].docId);
    expect(doc.segments.every((s) => s.failed && s.out === undefined)).toBe(true);
  });

  it("a cota acaba no meio do lote: o que já voltou é gravado e não é pedido de novo", async () => {
    const { meta } = await smallStanzaBook(lines(20));
    const provider = new ScriptedProvider((input, call) => {
      // 1º pedido recusado depois de 8 trechos; o 2º encontra a cota esgotada
      if (call === 1) return { translations: new Map(input.segments.slice(0, 8).map((s) => [s.id, `PT ${s.text}`])), refused: true };
      return new ProviderError("Limite gratuito atingido.", { fatal: true, code: "quota" });
    });
    const h = hooks();
    await expect(processChapters(meta, [meta.chapters[0]], provider, h)).rejects.toMatchObject({ code: "quota" });
    let doc = await store.readDoc(meta.id, meta.chapters[0].docId);
    const saved = doc.segments.filter((s) => s.out !== undefined);
    expect(saved).toHaveLength(8);
    expect(h.stats.words).toBe(saved.reduce((n, s) => n + s.words, 0));

    // retomada: só o que falta vai ao modelo, e a soma das palavras fecha com o livro
    const next = new ScriptedProvider();
    const h2 = hooks();
    await processChapters((await store.get(meta.id))!, [(await store.get(meta.id))!.chapters[0]], next, h2);
    const savedTexts = new Set(saved.map((s) => s.src));
    for (const c of next.calls) for (const s of c.segments) expect(savedTexts.has(s.text)).toBe(false);
    doc = await store.readDoc(meta.id, meta.chapters[0].docId);
    expect(doc.segments.every((s) => s.out !== undefined)).toBe(true);
    expect(h.stats.words + h2.stats.words).toBe(meta.chapters[0].wordCount);
  });

  it("recusa depois de um verso perdido: o poema seguinte não paga pelo poema recusado", async () => {
    // 3 poemas (A, B, C) no mesmo pedido; a resposta para no verso B3 e, no 1º pedido, o modelo
    // também pula o verso A2 (verso juntado ao anterior). A divisão é no ponto de parada, não no A2
    const ch = (t: string) => ({
      title: t,
      body: Array.from({ length: 5 }, (_, i) => `<p>Verse ${t}${i + 1} about the heron and the dark pond.</p>`).join(""),
    });
    const meta = await importBook(await writeEpub({ title: "R", language: "en", chapters: [ch("A"), ch("B"), ch("C")] }), {
      fileName: "r.epub",
      targetLanguage: "pt-BR",
    });
    const provider = new ScriptedProvider((input, call) => {
      const translations = new Map<number, string>();
      for (const s of input.segments) {
        if (s.text.includes("Verse B3")) return { translations, refused: true };
        if (call === 1 && s.text.includes("Verse A2")) continue;
        translations.set(s.id, `PT ${s.text}`);
      }
    });
    await processChapters(meta, meta.chapters, provider, hooks());
    const failed: string[] = [];
    for (const c of meta.chapters) {
      const doc = await store.readDoc(meta.id, c.docId);
      for (const s of doc.segments.slice(c.start, c.end)) {
        if (s.failed) failed.push(s.src.replace(/ about.*/, "").replace("Verse ", ""));
        else expect(s.out).toBe(`PT ${s.src}`);
      }
    }
    expect(failed).toEqual(["B3", "B4"]); // antes: B3, B4, B5 e C1 (de um poema sem culpa)
    expect(provider.calls).toHaveLength(6);
  });

  it("recusa só no fim (todos os trechos voltaram): uma nova tentativa só para os que perderam a formatação", async () => {
    const { meta } = await smallStanzaBook(Array.from({ length: 10 }, (_, i) => `Line ${i} of the poem${i < 4 ? " <i>very</i> slowly" : ""}.`));
    const provider = new ScriptedProvider((input, call) => ({
      translations: new Map(input.segments.map((s) => [s.id, input.strict ? `PT ${s.text}` : `PT ${s.text.replace(/<\/?i_\d+>/g, "")}`])),
      refused: call === 1,
    }));
    await processChapters(meta, [meta.chapters[0]], provider, hooks());
    // antes: o resto era dividido em metades, cada uma com a sua nova tentativa (5 pedidos)
    expect(provider.calls.map((c) => [c.segments.length, !!c.strict])).toEqual([
      [11, false],
      [4, true],
    ]);
    const doc = await store.readDoc(meta.id, meta.chapters[0].docId);
    expect(doc.segments.every((s) => s.out === `PT ${s.src}`)).toBe(true);
  });

  it("parada pelo registro logo depois de um pedido: o que voltou nele também é gravado", async () => {
    const { meta } = await smallStanzaBook(lines(6));
    const provider = new ScriptedProvider();
    const h = hooks();
    const onUsage = h.onUsage;
    h.onUsage = async (u, info) => {
      await onUsage(u, info);
      throw new BillingStop("Pausamos esta tradução.", "margin");
    };
    await expect(processChapters(meta, [meta.chapters[0]], provider, h)).rejects.toMatchObject({ code: "margin" });
    expect(provider.calls).toHaveLength(1);
    const doc = await store.readDoc(meta.id, meta.chapters[0].docId);
    expect(doc.segments.every((s) => s.out === `PT ${s.src}`)).toBe(true);
    expect(h.stats.words).toBe(meta.chapters[0].wordCount);
  });

  it("a cota acaba no meio do lote pela fila: os capítulos que ficaram completos são fechados e contados", async () => {
    const ch = (t: string) => ({
      title: t,
      body: `<h2>${t}</h2>` + Array.from({ length: 4 }, (_, i) => `<p>Verse ${t}${i + 1} about the heron and the dark pond.</p>`).join(""),
    });
    const meta = await importBook(await writeEpub({ title: "F", language: "en", chapters: [ch("Alpha"), ch("Beta"), ch("Gamma")] }), {
      fileName: "f.epub",
      targetLanguage: "pt-BR",
    });
    // 1º pedido: recusado no começo de Gamma; o 2º encontra a cota esgotada
    const provider = new ScriptedProvider((input, call) => {
      if (call > 1) return new ProviderError("Limite gratuito atingido.", { fatal: true, code: "quota" });
      const translations = new Map<number, string>();
      for (const s of input.segments) {
        if (s.text.includes("Gamma")) break;
        translations.set(s.id, `PT ${s.text}`);
      }
      return { translations, refused: true };
    });
    jobRunner.providerFactory = () => provider;
    await jobRunner.start(meta.id);
    const m = await waitFor(meta.id, ["paused", "done", "error"]);
    expect(m.stopCode).toBe("quota");
    expect(m.chapters.map((c) => [c.status, c.translatedTitle])).toEqual([
      ["done", "PT Alpha"],
      ["done", "PT Beta"],
      ["pending", undefined],
    ]);
    expect(m.progress.translatedSegments).toBe(10);
    expect(m.runs!.find((r) => r.kind === "translation")!.chapters).toBe(2); // antes: 0
  });

  it("quebras de verso: só quando faltam <br/> e o número de quebras de linha bate", async () => {
    const { meta, doc } = await smallStanzaBook(["One line<br/>two line<br/>three line", "Alone <i>here</i>"]);
    const stanza = doc.segments.find((s) => s.src.includes("<br_"))!;
    const brs = [...tagKeys(stanza.src)];
    expect(brs).toHaveLength(2);
    const fixed = restoreLineBreaks("Um verso \n dois versos\ntrês versos", brs, doc.tags);
    expect(fixed).toEqual({ markup: `Um verso<br_${brs[0]}/>dois versos<br_${brs[1]}/>três versos`, missing: [] });
    // contagem diferente, ou nada de quebra faltando: nada muda
    expect(restoreLineBreaks("Um verso\ndois versos três versos", brs, doc.tags).missing).toEqual(brs);
    const italic = doc.segments.find((s) => s.src.includes("<i_"))!;
    const iKeys = [...tagKeys(italic.src)];
    expect(restoreLineBreaks("Sozinho\naqui", iKeys, doc.tags)).toEqual({ markup: "Sozinho\naqui", missing: iKeys });

    // no processador: a estrofe com quebras de linha é aceita sem nova tentativa
    const provider = new ScriptedProvider((input) => ({
      translations: new Map(
        input.segments.map((s) => [s.id, s.text.includes("<br_") ? `PT ${s.text.replace(/<br_\d+\/>/g, "\n")}` : `PT ${s.text}`]),
      ),
    }));
    await processChapters(meta, [meta.chapters[0]], provider, hooks());
    expect(provider.calls).toHaveLength(1);
    const out = (await store.readDoc(meta.id, meta.chapters[0].docId)).segments.find((s) => s.i === stanza.i)!.out!;
    expect(out).toBe(`PT One line<br_${brs[0]}/>two line<br_${brs[1]}/>three line`);
  });

  it("quebras de verso na nova tentativa: voltam ao lugar em vez de sumir; contagem diferente continua como antes", async () => {
    const { meta, doc } = await smallStanzaBook(["One line<br/>two line<br/>three line", "Four line<br/>five line"]);
    const [a, b] = doc.segments.filter((s) => s.src.includes("<br_"));
    // 1ª tentativa: a 1ª estrofe perde as quebras sem quebras de linha (nova tentativa);
    // na nova tentativa vêm as quebras de linha certas. A 2ª estrofe junta os versos (contagem errada)
    const provider = new ScriptedProvider((input) => ({
      translations: new Map(
        input.segments.map((s) => [
          s.id,
          s.text === a.src
            ? `PT ${s.text.replace(/<br_\d+\/>/g, input.strict ? "\n" : " ")}`
            : s.text === b.src
              ? `PT ${s.text.replace(/<br_\d+\/>/g, " ")}`
              : `PT ${s.text}`,
        ]),
      ),
    }));
    await processChapters(meta, [meta.chapters[0]], provider, hooks());
    expect(provider.calls.map((c) => c.strict)).toEqual([false, true]);
    const after = (await store.readDoc(meta.id, meta.chapters[0].docId)).segments;
    expect(tagKeys(after[a.i].out!)).toEqual(tagKeys(a.src));
    // sem como saber onde ficavam: aceita na nova tentativa sem as quebras (comportamento de antes)
    expect(after[b.i].out).toBe("PT Four line five line");
  });

  it("a regra das quebras de verso está no prompt de tradução", () => {
    const prompt = translationSystemPrompt({
      title: "t",
      sourceLanguage: "English",
      targetLanguage: "Brazilian Portuguese",
      targetCode: "pt-BR",
      options: { dialogueStyle: "target", deepContext: false },
    });
    expect(prompt).toMatch(/<br_N\/> marks a line break/);
  });

  it("Gemini: o motivo de uma recusa vai para o log (só o código, sem o texto)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubGlobal("fetch", async () => {
      const body = [
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '<seg id="1">Texto secreto' }] } }] })}`,
        `data: ${JSON.stringify({ candidates: [{ finishReason: "RECITATION" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 } })}`,
        "",
      ].join("\n");
      return new Response(body, { status: 200 });
    });
    const res = await new GeminiClient("gemini-3.8-flash", "k").complete({ system: "s", user: "u", maxTokens: 100, purpose: "translation" });
    expect(res.stopReason).toBe("refusal");
    const logged = info.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("RECITATION");
    expect(logged).not.toContain("secreto");
  });
});

describe("leitura atenta e análise do livro", () => {
  async function mixedBook() {
    const long = Array.from(
      { length: 70 },
      (_, i) => `<p>Sentence ${i} about the lighthouse keeper and the long winter by the cold northern sea.</p>`,
    ).join("");
    const epub = await writeEpub({
      title: "Mixed",
      language: "en",
      chapters: [
        { title: "Short One", body: `<h1>Short One</h1><p>A very short poem about geese.</p>` },
        { title: "Long One", body: `<h1>Long One</h1>${long}` },
        { title: "Short Two", body: `<h1>Short Two</h1><p>Another tiny poem about rain.</p>` },
      ],
    });
    return importBook(epub, { fileName: "mixed.epub", targetLanguage: "pt-BR" });
  }

  it("páginas com menos de 300 palavras não ganham o pedido extra; ficam marcadas como lidas", async () => {
    const meta = await mixedBook();
    expect(meta.chapters[1].wordCount).toBeGreaterThanOrEqual(1000);
    await store.update(meta.id, (m) => void (m.options.deepContext = true));
    const analyzed: string[] = [];
    class Deep extends ScriptedProvider {
      async analyzeChapter(input?: unknown) {
        analyzed.push((input as { chapterTitle: string }).chapterTitle);
        return { summary: "Resumo.", newTerms: [] };
      }
    }
    const fresh = (await store.get(meta.id))!;
    await processChapters(fresh, fresh.chapters, new Deep(), hooks());
    expect(analyzed).toEqual(["Long One"]);
    const after = (await store.get(meta.id))!;
    expect(after.chapters.map((c) => c.summary)).toEqual(["", "Resumo.", ""]);
  });

  it("prosa a partir de 300 palavras ganha o pedido extra; poema curto em estrofes, não", async () => {
    const prose = Array.from(
      { length: 12 },
      (_, i) =>
        `<p>Paragraph ${i} tells how the keeper climbed the stairs at dusk, lit the great lamp and watched the ships pass the rocks while the wind rose over the northern sea and the gulls went quiet.</p>`,
    ).join("");
    const stanzas = Array.from(
      { length: 24 },
      (_, i) => `<p>The heron ${i} rises slow<br/>over the dark pond<br/>and the pines lean in<br/>to hear the morning bell sing</p>`,
    ).join("");
    const epub = await writeEpub({
      title: "Medium",
      language: "en",
      chapters: [
        { title: "Keeper", body: `<h1>Keeper</h1>${prose}` },
        { title: "Heron", body: `<h1>Heron</h1>${stanzas}` },
      ],
    });
    const meta = await importBook(epub, { fileName: "medium.epub", targetLanguage: "pt-BR" });
    for (const c of meta.chapters) {
      expect(c.wordCount).toBeGreaterThanOrEqual(300);
      expect(c.wordCount).toBeLessThan(1000);
    }
    await store.update(meta.id, (m) => void (m.options.deepContext = true));
    const analyzed: string[] = [];
    class Deep extends ScriptedProvider {
      async analyzeChapter(input?: unknown) {
        analyzed.push((input as { chapterTitle: string }).chapterTitle);
        return { summary: "Resumo.", newTerms: [] };
      }
    }
    const fresh = (await store.get(meta.id))!;
    await processChapters(fresh, fresh.chapters, new Deep(), hooks());
    expect(analyzed).toEqual(["Keeper"]);
    expect((await store.get(meta.id))!.chapters.map((c) => c.summary)).toEqual(["Resumo.", ""]);
  });

  it("análise do livro falha sem erro fatal: fica sem perfil e tenta de novo uma vez na próxima execução", async () => {
    let analyses = 0;
    let budget = 1;
    class Flaky extends ScriptedProvider {
      constructor() {
        super(() => (budget-- > 0 ? undefined : new ProviderError("Limite gratuito atingido.", { fatal: true, code: "quota" })));
      }
      async analyzeBook(): Promise<never> {
        analyses++;
        throw new ProviderError("Serviço sobrecarregado.", { fatal: false, code: "server" });
      }
    }
    const meta = await (async () => {
      const epub = await writeEpub({
        title: "Retry",
        language: "en",
        chapters: Array.from({ length: 3 }, (_, i) => ({ title: `Chapter ${i + 1}`, body: `<p>Paragraph of chapter ${i + 1} about the sea.</p>` })),
      });
      return importBook(epub, { fileName: "retry.epub", targetLanguage: "pt-BR" });
    })();
    // lotes de 1 capítulo: o 2º pedido encontra a cota esgotada
    const provider = new Flaky();
    provider.limits = { batchChars: 60, concurrency: 1 };
    jobRunner.providerFactory = () => provider;

    await jobRunner.start(meta.id);
    let m = await waitFor(meta.id, ["paused", "done", "error"]);
    expect(m.stopCode).toBe("quota");
    expect(analyses).toBe(1);
    expect(m.profile).toBeUndefined();
    expect(m.analysisFailed).toBe(true);

    // próxima execução: tenta de novo uma vez; falhando de novo, segue com o perfil vazio para sempre
    budget = 1;
    await jobRunner.start(meta.id);
    m = await waitFor(meta.id, ["paused", "done", "error"]);
    expect(analyses).toBe(2);
    expect(m.profile).toEqual({ genre: "", tone: "", narrativeVoice: "", styleNotes: "" });
    expect(m.analysisFailed).toBeUndefined();

    budget = 10;
    await jobRunner.start(meta.id);
    m = await waitFor(meta.id, ["paused", "done", "error"]);
    expect(m.status).toBe("done");
    expect(analyses).toBe(2);
  });
});

describe("GitHub Models encerrado", () => {
  const settings = { ...DEFAULT_SETTINGS, githubToken: "token-antigo" };

  it("um token salvo nunca manda traduções para lá", async () => {
    expect(DEFAULT_ROUTING.padrao).toEqual(["gemini", "groq", "cloudflare", "mistral"]);
    const github = providerConfigs(settings).find((p) => p.id === "github")!;
    expect(github.available).toBe(false);
    expect(github.hint).toMatch(/encerrou/);
    expect(defaultProviderId(settings)).not.toBe("github");
    // nem numa lista antiga salva pelo painel
    expect(await routeProvider("padrao", { ...settings, routing: { padrao: ["github"] } })).toEqual({ ok: false, reason: "no_provider" });
    expect(levelOffered("padrao", { ...settings, routing: { padrao: ["github"] } })).toBe(false);
    // com o Gemini sem cota, a lista padrão pula o GitHub e espera
    await recordExhausted("gemini", "gemini-3.8-flash", Date.now() + 60_000);
    const route = await routeProvider("padrao", { ...settings, geminiApiKey: "chave" });
    expect(route.ok).toBe(false);
    expect(() => createProvider("github", settings)).toThrow(/encerrou/);
    try {
      createProvider("github", settings);
    } catch (err) {
      expect((err as ProviderError).code).toBe("model");
    }
  });

  it("livro antigo que traduzia com o GitHub: pausa com o aviso, sem chamar nada", async () => {
    const epub = await writeEpub({ title: "Old", language: "en", chapters: [{ title: "One", body: "<p>An old book about the sea.</p>" }] });
    const meta = await importBook(epub, { fileName: "old.epub", targetLanguage: "pt-BR" });
    await store.update(meta.id, (m) => void (m.provider = { id: "github", model: "openai/gpt-4.1" }));
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    jobRunner.providerFactory = createProvider;
    await jobRunner.start(meta.id);
    const m = await waitFor(meta.id, ["paused", "error", "done"]);
    expect(m.status).toBe("paused");
    expect(m.error).toMatch(/encerrou/);
    expect(m.stopCode).toBe("model");
    expect(network).not.toHaveBeenCalled();
  });
});
