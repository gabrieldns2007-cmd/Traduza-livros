/**
 * Tradução de um capítulo.
 *
 *   capítulo → (análise: resumo + novos termos) → lotes de parágrafos →
 *   tradução → validação das tags → gravação incremental
 *
 * Cada lote é gravado assim que fica pronto, então uma interrupção (pausa,
 * queda do servidor) perde no máximo o lote em andamento.
 */
import type { BookMeta, ChapterMeta, DocContent, Segment } from "@/types/book";
import { store } from "@/lib/storage";
import { appendMissingVoids, repairMarkup, tagKeys, toPlainText } from "@/lib/markup";
import { languageEnglishName } from "@/lib/languages";
import { config } from "@/lib/config";
import { mergeCandidates, relevantEntries } from "@/services/glossary/glossary";
import type { BatchSegment, BookContext, TranslationProvider } from "@/services/translation/translation-provider";
import { ProviderError } from "@/services/translation/llm/types";
import { truncate } from "@/utils/text";
import { sleep } from "@/utils/async";

export interface ProcessorHooks {
  /** chamado após cada lote, com palavras/segmentos traduzidos nele */
  onProgress: (chapterId: string, delta: { words: number; segments: number; failed: number }) => Promise<void>;
  onUsage: (usage: { inputTokens: number; outputTokens: number }) => Promise<void>;
  /** serializa a análise de capítulos (para o resumo do anterior estar pronto) */
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

/** Texto do capítulo para análise (início e fim, se for muito longo). */
function chapterText(segments: Segment[], max = 28000): string {
  const text = segments.map((s) => toPlainText(s.src)).join("\n\n");
  if (text.length <= max) return text;
  return `${text.slice(0, Math.floor(max * 0.75))}\n\n[…]\n\n${text.slice(-Math.floor(max * 0.25))}`;
}

/** Agrupa segmentos pendentes em lotes de ~N caracteres, sem cortar parágrafos. */
export function makeBatches(segments: Segment[], maxChars: number, maxSegments = 60): Segment[][] {
  const batches: Segment[][] = [];
  let current: Segment[] = [];
  let size = 0;
  for (const s of segments) {
    const len = s.src.length;
    if (current.length && (size + len > maxChars || current.length >= maxSegments)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(s);
    size += len;
  }
  if (current.length) batches.push(current);
  return batches;
}

export async function processChapter(meta: BookMeta, chapter: ChapterMeta, provider: TranslationProvider, hooks: ProcessorHooks) {
  const bookId = meta.id;
  const book = bookContext(meta);
  const doc = await store.readDoc(bookId, chapter.docId);
  const range = doc.segments.slice(chapter.start, chapter.end);

  /* 1. análise do capítulo: resumo + novos termos do glossário */
  if (meta.options.deepContext && chapter.summary === undefined && range.length) {
    await hooks.analysisLock(async () => {
      const fresh = (await store.get(bookId))!;
      const prev = fresh.chapters
        .filter((c) => c.summary && fresh.chapters.indexOf(c) < fresh.chapters.findIndex((x) => x.id === chapter.id))
        .slice(-4)
        .map((c) => `${c.translatedTitle || c.title}: ${c.summary}`);
      const glossary = await store.readGlossary(bookId);
      let summary = "";
      try {
        const result = await provider.analyzeChapter(
          {
            book: { ...book, profile: fresh.profile },
            chapterTitle: chapter.title,
            text: chapterText(range),
            knownTerms: glossary.map((g) => g.term).slice(0, 400),
            previousSummaries: prev,
          },
          hooks.signal,
        );
        summary = result.summary;
        if (result.usage) await hooks.onUsage(result.usage);
        if (result.newTerms.length) await store.updateGlossary(bookId, (entries) => mergeCandidates(entries, result.newTerms));
      } catch (err) {
        if (err instanceof ProviderError && err.fatal) throw err;
        if (hooks.signal.aborted) throw err;
        console.warn(`[processor] análise do capítulo ${chapter.id} falhou; seguindo sem ela`, err);
      }
      await store.update(bookId, (m) => {
        const c = m.chapters.find((x) => x.id === chapter.id);
        if (c) c.summary = summary;
      });
    });
  }

  /* 2. tradução em lotes */
  const pending = range.filter((s) => s.out === undefined && !s.failed);
  const batches = makeBatches(pending, config.batchChars);
  const current = (await store.get(bookId))!;
  const chapterSummary = current.chapters.find((c) => c.id === chapter.id)?.summary || undefined;
  const story = current.chapters
    .filter((c) => c.summary && current.chapters.findIndex((x) => x.id === c.id) < current.chapters.findIndex((x) => x.id === chapter.id))
    .slice(-5)
    .map((c) => `- ${c.translatedTitle || c.title}: ${c.summary}`);

  for (const batch of batches) {
    if (hooks.signal.aborted) throw hooks.signal.reason ?? new Error("aborted");
    await translateBatchWithRetries(bookId, chapter, doc, batch, provider, hooks, {
      book: { ...book, profile: current.profile },
      story,
      chapterSummary,
    });
  }
}

interface BatchContext {
  book: BookContext;
  story: string[];
  chapterSummary?: string;
}

async function translateBatchWithRetries(
  bookId: string,
  chapter: ChapterMeta,
  doc: DocContent,
  batch: Segment[],
  provider: TranslationProvider,
  hooks: ProcessorHooks,
  ctx: BatchContext,
) {
  const glossary = await store.readGlossary(bookId);
  const batchText = batch.map((s) => toPlainText(s.src)).join("\n");
  const relevant = relevantEntries(glossary, batchText);

  // parágrafos anteriores já traduzidos (continuidade de voz e de tratamento)
  const firstIdx = batch[0].i;
  const preceding = doc.segments
    .slice(Math.max(chapter.start, firstIdx - 3), firstIdx)
    .filter((s) => s.out)
    .map((s) => truncate(toPlainText(s.out!), 600));

  const results = new Map<number, string>();
  const failed = new Set<number>();

  const attempt = async (segs: Segment[], strict: boolean, depth: number): Promise<void> => {
    const items: BatchSegment[] = segs.map((s) => ({ id: s.i, text: s.src }));
    const out = await provider.translateBatch({
      book: ctx.book,
      glossary: relevant,
      storySoFar: ctx.story,
      chapterTitle: chapter.title,
      chapterSummary: ctx.chapterSummary,
      preceding,
      segments: items,
      strict,
      signal: hooks.signal,
    });
    await hooks.onUsage(out.usage);

    // resposta cortada ou recusada: divide o lote ao meio
    if ((out.truncated || out.refused) && segs.length > 1 && depth < 6) {
      const mid = Math.ceil(segs.length / 2);
      await attempt(segs.slice(0, mid), strict, depth + 1);
      await attempt(segs.slice(mid), strict, depth + 1);
      return;
    }

    const retry: Segment[] = [];
    for (const s of segs) {
      const raw = out.translations.get(s.i);
      if (raw === undefined || (!raw.trim() && s.src.trim())) {
        if (strict) failed.add(s.i);
        else retry.push(s);
        continue;
      }
      const srcKeys = tagKeys(s.src);
      const repaired = repairMarkup(raw, doc.tags, srcKeys);
      if (repaired.missing.length && !strict) {
        retry.push(s);
        continue;
      }
      results.set(s.i, repaired.missing.length ? appendMissingVoids(repaired.markup, repaired.missing, doc.tags) : repaired.markup);
    }
    if (retry.length) await attempt(retry, true, depth + 1);
  };

  let transient = 0;
  for (;;) {
    try {
      await attempt(batch, false, 0);
      break;
    } catch (err) {
      if (hooks.signal.aborted) throw err;
      if (err instanceof ProviderError && err.fatal) throw err;
      // erro temporário que sobreviveu às novas tentativas do SDK
      transient++;
      // limite de uso: espera mais (contas novas têm limites baixos); outros erros: 3 tentativas
      const isRate = err instanceof ProviderError && err.code === "rate_limit";
      if (transient > (isRate ? 8 : 3)) throw err;
      const wait = Math.min(15000 * 2 ** (transient - 1), 5 * 60_000);
      console.warn(`[processor] erro temporário (tentativa ${transient}); aguardando ${wait / 1000}s`, err);
      await sleep(wait, hooks.signal);
    }
  }

  // grava (lê de novo dentro do lock para não perder edições feitas em paralelo)
  const delta = await store.updateDoc(bookId, chapter.docId, (content) => {
    let words = 0;
    let segments = 0;
    let fails = 0;
    for (const s of batch) {
      const seg = content.segments[s.i];
      if (!seg || seg.edited) continue;
      const translated = results.get(s.i);
      if (translated !== undefined) {
        seg.out = translated;
        delete seg.failed;
        words += seg.words;
        segments++;
      } else if (failed.has(s.i)) {
        seg.failed = true;
        fails++;
      }
    }
    // mantém a cópia local em sincronia (para o contexto dos próximos lotes)
    for (const s of batch) doc.segments[s.i] = content.segments[s.i];
    return { words, segments, failed: fails };
  });
  await hooks.onProgress(chapter.id, delta);
}
