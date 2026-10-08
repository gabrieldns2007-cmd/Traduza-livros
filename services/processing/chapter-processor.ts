/**
 * Tradução de um grupo de capítulos.
 *
 *   capítulos → lotes de parágrafos (vários capítulos pequenos podem caber no
 *   mesmo pedido) → tradução → validação das tags → gravação imediata →
 *   capítulo marcado como concluído assim que todos os seus trechos estão salvos
 *
 * Economia: cada pedido leva só o glossário relevante ao trecho, os últimos
 * resumos e 3 parágrafos anteriores; nomes novos vêm junto da tradução (sem
 * chamada extra por capítulo); nada já traduzido é reenviado.
 */
import type { BookMeta, ChapterMeta, DocContent, Segment } from "@/types/book";
import { store } from "@/lib/storage";
import { appendMissingVoids, repairMarkup, tagKeys, toPlainText } from "@/lib/markup";
import { languageEnglishName } from "@/lib/languages";
import { mergeCandidates, relevantEntries } from "@/services/glossary/glossary";
import type { BatchSegment, BookContext, TranslationProvider } from "@/services/translation/translation-provider";
import { ProviderError } from "@/services/translation/llm/types";
import { truncate } from "@/utils/text";
import { sleep } from "@/utils/async";

export interface ProcessorHooks {
  /** chamado após cada lote gravado, por capítulo */
  onProgress: (chapterId: string, delta: { words: number; segments: number; failed: number }) => Promise<void>;
  onUsage: (usage: { inputTokens: number; outputTokens: number }) => Promise<void>;
  /** chamado quando todos os trechos de um capítulo estão gravados */
  onChapterSaved: (chapterId: string) => Promise<void>;
  /** serializa a análise opcional de capítulos */
  analysisLock: <T>(fn: () => Promise<T>) => Promise<T>;
  signal: AbortSignal;
}

export function bookContext(meta: BookMeta): BookContext {
  const source = meta.sourceLanguage ?? meta.detectedLanguage ?? null;
  return {
    title: meta.title,
    author: meta.author,
    sourceLanguage: source ? languageEnglishName(source) : "auto",
    targetLanguage: languageEnglishName(meta.targetLanguage),
    targetCode: meta.targetLanguage,
    profile: meta.profile,
    options: meta.options,
  };
}

/** Um trecho a traduzir, com o capítulo e o arquivo de onde veio. */
interface Item {
  chapter: ChapterMeta;
  doc: DocContent;
  seg: Segment;
}

/** Agrupa itens pendentes em lotes de ~N caracteres, sem cortar parágrafos. */
export function makeBatches<T extends { seg: Segment }>(items: T[], maxChars: number, maxSegments = 120): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const it of items) {
    const len = it.seg.src.length;
    if (current.length && (size + len > maxChars || current.length >= maxSegments)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(it);
    size += len;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** Caracteres ainda por traduzir em um capítulo (para montar grupos). */
export async function pendingChars(bookId: string, chapter: ChapterMeta): Promise<number> {
  const doc = await store.readDoc(bookId, chapter.docId);
  return doc.segments
    .slice(chapter.start, chapter.end)
    .filter((s) => s.out === undefined && !s.failed)
    .reduce((n, s) => n + s.src.length, 0);
}

/** Análise opcional (“leitura atenta”): uma chamada extra por capítulo para resumo + nomes novos. */
async function analyzeChapter(meta: BookMeta, chapter: ChapterMeta, range: Segment[], provider: TranslationProvider, hooks: ProcessorHooks) {
  await hooks.analysisLock(async () => {
    const fresh = (await store.get(meta.id))!;
    const idx = fresh.chapters.findIndex((x) => x.id === chapter.id);
    const prev = fresh.chapters
      .slice(0, idx)
      .filter((c) => c.summary)
      .slice(-4)
      .map((c) => `${c.translatedTitle || c.title}: ${c.summary}`);
    const glossary = await store.readGlossary(meta.id);
    const text = range.map((s) => toPlainText(s.src)).join("\n\n");
    let summary = "";
    try {
      const result = await provider.analyzeChapter(
        {
          book: { ...bookContext(meta), profile: fresh.profile },
          chapterTitle: chapter.title,
          text: text.length <= 28000 ? text : `${text.slice(0, 21000)}\n\n[…]\n\n${text.slice(-7000)}`,
          knownTerms: glossary.map((g) => g.term).slice(0, 400),
          previousSummaries: prev,
        },
        hooks.signal,
      );
      summary = result.summary;
      if (result.usage) await hooks.onUsage(result.usage);
      if (result.newTerms.length) await store.updateGlossary(meta.id, (entries) => mergeCandidates(entries, result.newTerms));
    } catch (err) {
      if (err instanceof ProviderError && err.fatal) throw err;
      if (hooks.signal.aborted) throw err;
      console.warn(`[processor] análise do capítulo ${chapter.id} falhou; seguindo sem ela`, err);
    }
    await store.update(meta.id, (m) => {
      const c = m.chapters.find((x) => x.id === chapter.id);
      if (c) c.summary = summary;
    });
  });
}

/** Traduz um grupo de capítulos consecutivos (um só, ou vários pequenos). */
export async function processChapters(meta: BookMeta, chapters: ChapterMeta[], provider: TranslationProvider, hooks: ProcessorHooks) {
  const bookId = meta.id;
  const docs = new Map<string, DocContent>();
  const items: Item[] = [];
  for (const chapter of chapters) {
    if (!docs.has(chapter.docId)) docs.set(chapter.docId, await store.readDoc(bookId, chapter.docId));
    const doc = docs.get(chapter.docId)!;
    const range = doc.segments.slice(chapter.start, chapter.end);
    if (meta.options.deepContext && chapter.summary === undefined && range.some((s) => s.out === undefined)) {
      await analyzeChapter(meta, chapter, range, provider, hooks);
    }
    for (const seg of range) if (seg.out === undefined && !seg.failed) items.push({ chapter, doc, seg });
  }

  // capítulos sem nada pendente (ex.: retomada no meio) já podem ser fechados
  for (const c of chapters) if (!items.some((it) => it.chapter.id === c.id)) await hooks.onChapterSaved(c.id);

  for (const batch of makeBatches(items, provider.limits.batchChars)) {
    if (hooks.signal.aborted) throw hooks.signal.reason ?? new Error("aborted");
    await translateBatch(bookId, batch, provider, hooks);
    // fecha cada capítulo assim que todos os seus trechos estão gravados
    for (const c of new Set(batch.map((it) => it.chapter))) {
      if (!items.some((it) => it.chapter.id === c.id && it.seg.out === undefined && !it.seg.failed)) await hooks.onChapterSaved(c.id);
    }
  }
}

async function translateBatch(bookId: string, batch: Item[], provider: TranslationProvider, hooks: ProcessorHooks) {
  const meta = (await store.get(bookId))!;
  const book = bookContext(meta);
  const glossary = await store.readGlossary(bookId);
  const relevant = relevantEntries(glossary, batch.map((it) => toPlainText(it.seg.src)).join("\n"));

  const first = batch[0];
  const firstIdx = meta.chapters.findIndex((c) => c.id === first.chapter.id);
  const story = meta.chapters
    .slice(0, firstIdx)
    .filter((c) => c.summary)
    .slice(-5)
    .map((c) => `- ${c.translatedTitle || c.title}: ${c.summary}`);
  const titles = [...new Set(batch.map((it) => it.chapter.title))];
  const chapterSummary = titles.length === 1 ? meta.chapters[firstIdx]?.summary || undefined : undefined;

  // parágrafos anteriores já traduzidos (continuidade de voz e de tratamento)
  const preceding = first.doc.segments
    .slice(Math.max(first.chapter.start, first.seg.i - 3), first.seg.i)
    .filter((s) => s.out)
    .map((s) => truncate(toPlainText(s.out!), 600));

  // ids locais 1..n: trechos de arquivos diferentes podem ter o mesmo índice
  const local = new Map<number, Item>();
  batch.forEach((it, n) => local.set(n + 1, it));
  const idOf = new Map<Item, number>([...local].map(([id, it]) => [it, id]));

  const results = new Map<Item, string>();
  const failed = new Set<Item>();

  const attempt = async (its: Item[], strict: boolean, depth: number): Promise<void> => {
    const segments: BatchSegment[] = its.map((it) => ({ id: idOf.get(it)!, text: it.seg.src }));
    const out = await provider.translateBatch({
      book: { ...book, profile: meta.profile },
      glossary: relevant,
      storySoFar: story,
      chapterTitle: titles.length === 1 ? titles[0] : titles.slice(0, 6).join(" / "),
      chapterSummary,
      preceding,
      segments,
      strict,
      signal: hooks.signal,
    });
    await hooks.onUsage(out.usage);
    if (out.newTerms?.length) await store.updateGlossary(bookId, (entries) => mergeCandidates(entries, out.newTerms!));

    // resposta cortada ou recusada: divide o lote ao meio (com limite)
    if ((out.truncated || out.refused) && its.length > 1 && depth < 4) {
      const mid = Math.ceil(its.length / 2);
      await attempt(its.slice(0, mid), strict, depth + 1);
      await attempt(its.slice(mid), strict, depth + 1);
      return;
    }

    const missing: Item[] = [];
    for (const it of its) {
      const raw = out.translations.get(idOf.get(it)!);
      if (raw === undefined || (!raw.trim() && it.seg.src.trim())) {
        if (strict) failed.add(it);
        else missing.push(it);
        continue;
      }
      const repaired = repairMarkup(raw, it.doc.tags, tagKeys(it.seg.src));
      // formatação perdida (itálico, notas…): uma nova tentativa, junto dos trechos que faltaram
      if (repaired.missing.length && !strict) {
        missing.push(it);
        continue;
      }
      results.set(it, repaired.missing.length ? appendMissingVoids(repaired.markup, repaired.missing, it.doc.tags) : repaired.markup);
    }
    // só esses trechos voltam, numa única chamada extra
    if (missing.length) await attempt(missing, true, depth + 1);
  };

  let transient = 0;
  for (;;) {
    try {
      await attempt(batch, false, 0);
      break;
    } catch (err) {
      if (hooks.signal.aborted) throw err;
      if (err instanceof ProviderError && err.fatal) throw err;
      transient++;
      // limite por minuto ou provedor sobrecarregado: espera mais antes de desistir
      const isRate = err instanceof ProviderError && (err.code === "rate_limit" || err.code === "server");
      if (transient > (isRate ? 6 : 3)) throw err;
      const wait = Math.min(15000 * 2 ** (transient - 1), 5 * 60_000);
      console.warn(`[processor] erro temporário (tentativa ${transient}); aguardando ${wait / 1000}s`, err);
      await sleep(wait, hooks.signal);
    }
  }

  // grava imediatamente, arquivo por arquivo (relê dentro do lock para não perder edições)
  const perChapter = new Map<string, { words: number; segments: number; failed: number }>();
  for (const docId of new Set(batch.map((it) => it.chapter.docId))) {
    const docItems = batch.filter((it) => it.chapter.docId === docId);
    await store.updateDoc(bookId, docId, (content) => {
      for (const it of docItems) {
        const seg = content.segments[it.seg.i];
        if (!seg || seg.edited) continue;
        const d = perChapter.get(it.chapter.id) ?? { words: 0, segments: 0, failed: 0 };
        const translated = results.get(it);
        if (translated !== undefined) {
          seg.out = translated;
          delete seg.failed;
          d.words += seg.words;
          d.segments++;
        } else if (failed.has(it)) {
          seg.failed = true;
          d.failed++;
        }
        perChapter.set(it.chapter.id, d);
      }
      // mantém as cópias locais em sincronia (contexto dos próximos lotes)
      for (const it of docItems) {
        it.doc.segments[it.seg.i] = content.segments[it.seg.i];
        it.seg = content.segments[it.seg.i];
      }
    });
  }
  for (const [chapterId, delta] of perChapter) await hooks.onProgress(chapterId, delta);
}
