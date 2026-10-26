/**
 * Tradução de um grupo de capítulos.
 *
 *   capítulos → lotes de parágrafos (vários capítulos pequenos podem caber no
 *   mesmo pedido) → tradução → validação das tags → gravação imediata →
 *   capítulo marcado como concluído assim que todos os seus trechos estão salvos
 *
 * Economia: cada pedido leva só o glossário relevante ao trecho, os últimos
 * resumos e 3 parágrafos anteriores (até 8 no começo de um capítulo ou quando
 * o modelo mudou: a “ponte” que mantém a voz e o tratamento, do tamanho que cabe
 * nos pedidos do serviço); nomes novos vêm
 * junto da tradução (sem chamada extra por capítulo); nada já traduzido é
 * reenviado. Além disso:
 *  - trechos sem palavras (números, “* * *”, marcas de nota) ficam como estão,
 *    sem ir ao modelo, e trechos idênticos no mesmo lote vão uma vez só;
 *  - resposta cortada no limite de saída ou recusada no meio: os trechos que
 *    vieram completos são aproveitados e só o resto é pedido de novo (recusas
 *    dividem o resto no máximo 2 vezes);
 *  - erro temporário no meio de um lote: só o que ainda falta é reenviado;
 *  - erro fatal (ex.: cota do dia): o que já voltou é gravado antes de parar;
 *  - poesia: até `maxSegments` versos por pedido, e quebras de verso trocadas
 *    por quebras de linha voltam ao lugar sem nova tentativa;
 *  - qualidade (lib/quality.ts): cada trecho é conferido antes de gravar (voltou
 *    sem traduzir, em outro idioma, com pedaços do pedido, com comentários…); o
 *    que falha vai numa única nova tentativa com o motivo no pedido, e a mesma
 *    tradução para trechos diferentes divide o pedido uma vez;
 *  - cada trecho gravado guarda quem o traduziu (`by`, “provedor/modelo”).
 */
import type { BookActivity, BookMeta, ChapterMeta, DocContent, Segment } from "@/types/book";
import { store } from "@/lib/storage";
import { appendMissingVoids, repairMarkup, restoreLineBreaks, tagKeys, toPlainText } from "@/lib/markup";
import { languageEnglishName } from "@/lib/languages";
import { checkSegment, repeatedOutputs, stripStrayTags, type QualityContext } from "@/lib/quality";
import { mergeCandidates, relevantEntries } from "@/services/glossary/glossary";
import type { BatchSegment, BookContext, ProviderLimits, TranslationProvider } from "@/services/translation/translation-provider";
import { ProviderError } from "@/services/translation/llm/types";
import { truncate } from "@/utils/text";
import { sleep } from "@/utils/async";

export interface ProcessorHooks {
  /** chamado após cada lote gravado, por capítulo */
  onProgress: (chapterId: string, delta: { words: number; segments: number; failed: number }) => Promise<void>;
  /**
   * `retry`: pedido refeito (resposta cortada, trechos ou formatação perdidos);
   * `refused`: o modelo recusou a resposta (filtro de segurança ou de citação)
   */
  onUsage: (usage: { inputTokens: number; outputTokens: number }, info?: { retry?: boolean; refused?: boolean }) => Promise<void>;
  /** trechos resolvidos sem chamar o modelo (sem palavras ou repetidos no lote) */
  onLocal?: (segments: number) => Promise<void>;
  /** chamado quando todos os trechos de um capítulo estão gravados */
  onChapterSaved: (chapterId: string) => Promise<void>;
  /** serializa a análise opcional de capítulos */
  analysisLock: <T>(fn: () => Promise<T>) => Promise<T>;
  signal: AbortSignal;
  /** o que está acontecendo agora (pedido em andamento, espera de limite) */
  onActivity?: (activity: BookActivity | null) => void;
  /** antes de cada lote (palavras de origem): pode interromper (ex.: créditos acabaram) */
  beforeBatch?: (words: number) => Promise<void>;
  /** quem traduz nesta execução (“provedor/modelo”): gravado em cada trecho (`by`) */
  engine?: string;
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

/** Caracteres da moldura <seg id="N"></seg> de cada trecho no pedido (vai e volta com o texto). */
export const SEG_WRAPPER_CHARS = 21;

/** Trechos por pedido quando o provedor não define outro número. */
const DEFAULT_MAX_SEGMENTS = 120;

/** Parágrafos anteriores que vão como contexto em cada pedido. */
const PRECEDING_PARAGRAPHS = 3;

/** “Ponte” no começo de um capítulo ou quando o modelo mudou: mais parágrafos anteriores, até este total de caracteres. */
export const BRIDGE_PARAGRAPHS = 8;
const BRIDGE_CHARS = 3600;
/** Os 3 parágrafos comuns (até 600 caracteres cada): a ponte nunca é menor que isso. */
const BRIDGE_MIN_CHARS = 1800;

/**
 * Tamanho da ponte, proporcional ao pedido: num serviço de pedidos pequenos (Groq, 5000
 * caracteres; limite de 8 mil tokens por minuto contando os 4000 reservados para a saída)
 * ela fica do tamanho do contexto comum; com pedidos grandes (Gemini), 3600 caracteres.
 */
export function bridgeChars(limits: ProviderLimits): number {
  return Math.max(BRIDGE_MIN_CHARS, Math.min(BRIDGE_CHARS, Math.round(limits.batchChars * 0.36)));
}

/** “Leitura atenta”: capítulos com menos palavras que isso (uma dedicatória, uma epígrafe) não ganham o pedido extra. */
export const DEEP_CONTEXT_MIN_WORDS = 300;

/** “Leitura atenta”: poemas com menos palavras que isso também não (o resumo ajuda pouco num poema curto). */
export const DEEP_CONTEXT_MIN_VERSE_WORDS = 1000;

/**
 * Se o capítulo ganha a análise extra da “leitura atenta”. Prosa ganha a partir de
 * DEEP_CONTEXT_MIN_WORDS; poesia (versos curtos, um por parágrafo ou separados por
 * quebras de verso) só a partir de DEEP_CONTEXT_MIN_VERSE_WORDS.
 */
export function wantsDeepContext(chapter: ChapterMeta, range: Segment[]): boolean {
  if (chapter.wordCount < DEEP_CONTEXT_MIN_WORDS) return false;
  if (chapter.wordCount >= DEEP_CONTEXT_MIN_VERSE_WORDS) return true;
  // linhas = trechos + quebras de verso; prosa tem ~60 palavras por linha (diálogos, ~20), poesia ~6
  const lines = range.reduce((n, s) => n + 1 + (s.src.match(/<br_\d+\/>/g)?.length ?? 0), 0);
  return chapter.wordCount / Math.max(1, lines) >= 12;
}

/** Tamanho máximo de um pedido: caracteres (texto + moldura) e trechos. */
export function batchLimits(limits: ProviderLimits) {
  return { chars: limits.batchChars, segments: limits.maxSegments ?? DEFAULT_MAX_SEGMENTS };
}

/** Agrupa itens pendentes em lotes de ~N caracteres (contando a moldura de cada trecho), sem cortar parágrafos. */
export function makeBatches<T extends { seg: Segment }>(items: T[], maxChars: number, maxSegments = DEFAULT_MAX_SEGMENTS): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const it of items) {
    const len = it.seg.src.length + SEG_WRAPPER_CHARS;
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

/**
 * O que ainda falta traduzir em um capítulo (para montar grupos): caracteres,
 * com a mesma conta de makeBatches, e trechos. Assim um grupo cabe num pedido só.
 */
export async function pendingLoad(bookId: string, chapter: ChapterMeta): Promise<{ chars: number; segments: number }> {
  const doc = await store.readDoc(bookId, chapter.docId);
  const pending = doc.segments.slice(chapter.start, chapter.end).filter((s) => s.out === undefined && !s.failed);
  return { chars: pending.reduce((n, s) => n + s.src.length + SEG_WRAPPER_CHARS, 0), segments: pending.length };
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
      // resposta cortada ou ilegível: não serviu, mas os tokens já foram gastos e entram na conta
      if (err instanceof ProviderError && err.usage) await hooks.onUsage(err.usage);
      // um 400 pontual na análise do capítulo não para a tradução
      if (err instanceof ProviderError && err.fatal && err.code !== "bad_request") throw err;
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
      if (wantsDeepContext(chapter, range)) await analyzeChapter(meta, chapter, range, provider, hooks);
      else {
        // página curta ou poema curto: o resumo ajudaria pouco e custaria um pedido; fica marcado como lido
        await store.update(meta.id, (m) => {
          const c = m.chapters.find((x) => x.id === chapter.id);
          if (c && c.summary === undefined) c.summary = "";
        });
      }
    }
    for (const seg of range) if (seg.out === undefined && !seg.failed) items.push({ chapter, doc, seg });
  }

  // capítulos sem nada pendente (ex.: retomada no meio) já podem ser fechados
  for (const c of chapters) if (!items.some((it) => it.chapter.id === c.id)) await hooks.onChapterSaved(c.id);

  const limit = batchLimits(provider.limits);
  for (const batch of makeBatches(items, limit.chars, limit.segments)) {
    if (hooks.signal.aborted) throw hooks.signal.reason ?? new Error("aborted");
    await hooks.beforeBatch?.(batch.reduce((n, it) => n + it.seg.words, 0));
    const closeSaved = async () => {
      for (const c of new Set(batch.map((it) => it.chapter))) {
        if (!items.some((it) => it.chapter.id === c.id && it.seg.out === undefined && !it.seg.failed)) await hooks.onChapterSaved(c.id);
      }
    };
    try {
      await translateBatch(bookId, batch, provider, hooks);
    } catch (err) {
      // erro fatal depois de gravar o que já tinha voltado: fecha os capítulos que ficaram completos
      // (concluídos, com título traduzido e contados nesta execução) antes de parar
      if (!hooks.signal.aborted) await closeSaved().catch((e) => console.warn("[processor] não foi possível fechar os capítulos gravados", e));
      throw err;
    }
    // fecha cada capítulo assim que todos os seus trechos estão gravados
    await closeSaved();
  }
}

/** Traduz só um trecho de um capítulo (prévia grátis). As traduções ficam salvas e contam no progresso. */
export async function translateRange(
  meta: BookMeta,
  chapter: ChapterMeta,
  start: number,
  end: number,
  provider: TranslationProvider,
  hooks: ProcessorHooks,
) {
  const doc = await store.readDoc(meta.id, chapter.docId);
  const items: Item[] = doc.segments
    .slice(start, end)
    .filter((seg) => seg.out === undefined && !seg.failed)
    .map((seg) => ({ chapter, doc, seg }));
  const limit = batchLimits(provider.limits);
  for (const batch of makeBatches(items, limit.chars, limit.segments)) {
    if (hooks.signal.aborted) throw hooks.signal.reason ?? new Error("aborted");
    await hooks.beforeBatch?.(batch.reduce((n, it) => n + it.seg.words, 0));
    await translateBatch(meta.id, batch, provider, hooks);
  }
}

/** Trecho que não tem o que traduzir: só números, pontuação, separadores ou marcas. */
export function hasWords(src: string): boolean {
  return /\p{L}/u.test(toPlainText(src));
}

/**
 * Parágrafos anteriores já traduzidos (continuidade de voz e de tratamento). No meio de
 * um capítulo, os 3 últimos. A “ponte” — até 8, cruzando para o fim do capítulo anterior
 * quando o lote começa um capítulo — entra quando nada do capítulo foi traduzido ainda ou
 * quando o trecho anterior foi feito por outro modelo (troca de serviço no meio do livro).
 */
async function precedingContext(bookId: string, meta: BookMeta, first: Item, engine: string | undefined, budget: number): Promise<string[]> {
  const plain = (segs: Segment[]) => segs.map((s) => truncate(toPlainText(s.out!), 600));
  const before = first.doc.segments.slice(first.chapter.start, first.seg.i).filter((s) => s.out !== undefined && hasWords(s.src));
  const last = before[before.length - 1];
  if (last && (!engine || last.by === engine)) {
    return plain(first.doc.segments.slice(Math.max(first.chapter.start, first.seg.i - PRECEDING_PARAGRAPHS), first.seg.i).filter((s) => s.out));
  }
  let pool = before;
  if (!last) {
    // começo do capítulo: o fim do capítulo anterior
    const idx = meta.chapters.findIndex((c) => c.id === first.chapter.id);
    const prev = idx > 0 ? meta.chapters[idx - 1] : undefined;
    if (!prev) return [];
    const doc = prev.docId === first.chapter.docId ? first.doc : await store.readDoc(bookId, prev.docId).catch(() => null);
    pool = doc ? doc.segments.slice(prev.start, prev.end).filter((s) => s.out !== undefined && hasWords(s.src)) : [];
  }
  const out: string[] = [];
  let chars = 0;
  for (const text of plain(pool.slice(-BRIDGE_PARAGRAPHS)).reverse()) {
    if (out.length && chars + text.length > budget) break;
    out.unshift(text);
    chars += text.length;
  }
  return out;
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
  const preceding = await precedingContext(bookId, meta, first, hooks.engine, bridgeChars(provider.limits));

  // conferência de cada trecho antes de gravar (a de idioma, só para modelos de verdade)
  const quality: QualityContext = {
    sourceLang: meta.sourceLanguage ?? meta.detectedLanguage ?? null,
    targetLang: meta.targetLanguage,
    languageChecks: !!provider.checkLanguage,
  };

  // ids locais 1..n: trechos de arquivos diferentes podem ter o mesmo índice
  const local = new Map<number, Item>();
  batch.forEach((it, n) => local.set(n + 1, it));
  const idOf = new Map<Item, number>([...local].map(([id, it]) => [it, id]));

  const results = new Map<Item, string>();
  const failed = new Set<Item>();
  /** por que a última resposta de um trecho não serviu (vai no pedido da nova tentativa; fica anotado se falhar) */
  const reasons = new Map<Item, string>();
  /** avisos dos trechos aceitos (tamanho fora do comum, formatação perdida…) */
  const warns = new Map<Item, string[]>();

  // sem palavras: fica igual ao original; repetido no lote: vai ao modelo uma vez só
  const toSend: Item[] = [];
  const copyOf = new Map<Item, Item>();
  const firstBySrc = new Map<string, Item>();
  for (const it of batch) {
    if (!hasWords(it.seg.src)) {
      results.set(it, repairMarkup(it.seg.src, it.doc.tags, tagKeys(it.seg.src)).markup);
      continue;
    }
    const first = firstBySrc.get(it.seg.src);
    if (first) copyOf.set(it, first);
    else {
      firstBySrc.set(it.seg.src, it);
      toSend.push(it);
    }
  }

  const reject = (it: Item, reason: string) => {
    reasons.set(it, reason);
    return false;
  };

  /**
   * Aceita a tradução de um trecho se ela veio inteira, com a formatação e passou na
   * conferência de qualidade; senão anota o motivo e devolve false.
   */
  const accept = (it: Item, raw: string | undefined, strict: boolean): boolean => {
    if (raw === undefined || (!raw.trim() && it.seg.src.trim())) return reject(it, raw === undefined ? "missing" : "empty");
    const repaired = repairMarkup(raw, it.doc.tags, tagKeys(it.seg.src));
    // quebras de verso trocadas por quebras de linha voltam ao lugar (sem nova tentativa)
    const { markup, missing } = repaired.missing.length ? restoreLineBreaks(repaired.markup, repaired.missing, it.doc.tags) : repaired;
    if (missing.length && !strict) return reject(it, "tags");
    let final = missing.length ? appendMissingVoids(markup, missing, it.doc.tags) : markup;
    let check = checkSegment(it.seg.src, final, quality);
    const extra: string[] = [];
    if (check.hard === "stray-tag" && strict) {
      // ainda com <em> ou *ênfase* soltos na nova tentativa: tira as marcas (nunca grava tags literais no livro)
      final = stripStrayTags(final);
      check = checkSegment(it.seg.src, final, quality);
      extra.push("stray-tag");
    }
    if (check.hard) return reject(it, check.hard);
    results.set(it, final);
    reasons.delete(it);
    const w = [...new Set([...extra, ...check.soft])];
    if (w.length) warns.set(it, w);
    else warns.delete(it);
    return true;
  };

  /**
   * `refusals`: quantas vezes este pedaço já foi dividido por causa de uma recusa;
   * `realigned`: já foi dividido porque o modelo se perdeu na ordem dos trechos
   */
  const attempt = async (its: Item[], strict: boolean, depth: number, refusals = 0, realigned = false): Promise<void> => {
    const segments: BatchSegment[] = its.map((it) => ({ id: idOf.get(it)!, text: it.seg.src }));
    const chapterCount = new Set(its.map((it) => it.chapter.id)).size;
    // na nova tentativa, o pedido diz o que deu errado na anterior
    const issues = strict ? [...new Set(its.map((it) => reasons.get(it)).filter((r): r is string => !!r))] : [];
    hooks.onActivity?.({ kind: "request", since: new Date().toISOString(), chapters: chapterCount });
    const out = await provider.translateBatch({
      book: { ...book, profile: meta.profile },
      glossary: relevant,
      storySoFar: story,
      chapterTitle: titles.length === 1 ? titles[0] : titles.slice(0, 6).join(" / "),
      chapterSummary,
      preceding,
      segments,
      strict,
      ...(issues.length ? { issues } : {}),
      signal: hooks.signal,
      onWait: (ms) => {
        const now = Date.now();
        hooks.onActivity?.({ kind: "waiting", since: new Date(now).toISOString(), until: new Date(now + ms).toISOString() });
        // depois da espera o mesmo pedido é reenviado
        setTimeout(() => hooks.onActivity?.({ kind: "request", since: new Date().toISOString(), chapters: chapterCount }), ms).unref?.();
      },
    });
    // a mesma tradução para trechos diferentes: o modelo se perdeu na ordem. Esses trechos
    // voltam na nova tentativa; na nova tentativa, a repetição é aceita (pode ser legítima)
    const repeated = repeatedOutputs(its.map((it) => ({ src: it.seg.src, out: out.translations.get(idOf.get(it)!) })));
    const take = (it: Item, i: number) =>
      !strict && repeated.indexes.has(i) ? reject(it, "misaligned") : accept(it, out.translations.get(idOf.get(it)!), strict);
    try {
      await hooks.onUsage(out.usage, { retry: strict || depth > 0, refused: out.refused });
    } catch (stop) {
      // parada pelo registro (ex.: gasto acima do previsto): esta resposta já foi paga, então o que
      // veio completo nela também é gravado antes de parar
      its.forEach((it, i) => take(it, i));
      throw stop;
    }
    if (out.newTerms?.length) await store.updateGlossary(bookId, (entries) => mergeCandidates(entries, out.newTerms!));

    // vários trechos (2 ou mais, e ao menos 1 em cada 10) com a tradução de outro: nada desta
    // resposta é confiável (pode estar tudo deslocado); divide o pedido ao meio, uma vez só.
    // Repetições raras (um refrão num pedido de 400 versos) só voltam na nova tentativa
    if (!strict && !realigned && repeated.cases >= 2 && repeated.cases * 10 >= its.length && its.length > 1) {
      for (const i of repeated.indexes) reasons.set(its[i], "misaligned");
      const mid = Math.ceil(its.length / 2);
      await attempt(its.slice(0, mid), false, depth + 1, refusals, true);
      await attempt(its.slice(mid), false, depth + 1, refusals, true);
      return;
    }

    // resposta cortada no limite de saída: aproveita os trechos que vieram completos
    // e pede só o resto (em metades, se ainda for muito)
    if (out.truncated && its.length > 1 && depth < 4) {
      const rest = its.filter((it, i) => !take(it, i));
      if (!rest.length) return;
      if (rest.length < its.length && rest.length <= Math.ceil(its.length / 2)) {
        await attempt(rest, strict, depth + 1, refusals, realigned);
        return;
      }
      const mid = Math.ceil(rest.length / 2);
      await attempt(rest.slice(0, mid), strict, depth + 1, refusals, realigned);
      await attempt(rest.slice(mid), strict, depth + 1, refusals, realigned);
      return;
    }

    // o que veio completo fica (inclusive numa resposta recusada no meio)
    const rest = its.filter((it, i) => !take(it, i));
    if (!rest.length) return;
    // recusada (filtro de segurança ou de citação, ou “desculpe, não posso” no texto) antes do fim:
    // divide só o resto em dois, no máximo 2 vezes. O motivo está no trecho em que a resposta parou
    // (não num trecho anterior que o modelo pulou ou devolveu sem a formatação): o capítulo dele vai
    // separado dos seguintes, que não têm culpa; se nada voltou, divide ao meio. Se todos os trechos
    // voltaram (recusa só no fim), não divide: o que perdeu a formatação vai junto na nova tentativa abaixo
    let lastBack = -1; // último trecho que voltou na resposta
    its.forEach((it, i) => {
      if (out.translations.has(idOf.get(it)!)) lastBack = i;
    });
    if (out.refused && lastBack < its.length - 1 && rest.length > 1 && refusals < 2) {
      const culprit = lastBack >= 0 ? its[lastBack + 1].chapter.id : undefined;
      const after = new Set(its.slice(lastBack + 1));
      const next = culprit ? rest.findIndex((it) => after.has(it) && it.chapter.id !== culprit) : -1;
      const mid = next > 0 ? next : Math.ceil(rest.length / 2);
      await attempt(rest.slice(0, mid), strict, depth + 1, refusals + 1, realigned);
      await attempt(rest.slice(mid), strict, depth + 1, refusals + 1, realigned);
      return;
    }
    // faltou, perdeu a formatação ou não passou na conferência (voltou sem traduzir, em outro
    // idioma, com comentários…): só esses trechos voltam, numa única chamada extra com o motivo;
    // se falharem de novo, ficam marcados para revisão
    if (strict) for (const it of rest) failed.add(it);
    else await attempt(rest, true, depth + 1, refusals, realigned);
  };

  /** Grava imediatamente, arquivo por arquivo (relê dentro do lock para não perder edições). */
  const save = async () => {
    // repetidos recebem a mesma tradução do primeiro
    for (const [it, first] of copyOf) {
      const t = results.get(first);
      if (t !== undefined) results.set(it, t);
      else if (failed.has(first)) failed.add(it);
    }
    const sent = new Set(toSend);
    const resolvedHere = batch.filter((it) => !sent.has(it) && results.has(it)).length;
    if (resolvedHere) await hooks.onLocal?.(resolvedHere);

    const perChapter = new Map<string, { words: number; segments: number; failed: number }>();
    for (const docId of new Set(batch.map((it) => it.chapter.docId))) {
      const docItems = batch.filter((it) => it.chapter.docId === docId);
      await store.updateDoc(bookId, docId, (content) => {
        for (const it of docItems) {
          const seg = content.segments[it.seg.i];
          if (!seg || seg.edited) continue;
          const d = perChapter.get(it.chapter.id) ?? { words: 0, segments: 0, failed: 0 };
          const translated = results.get(it);
          const origin = copyOf.get(it) ?? it;
          if (translated !== undefined) {
            seg.out = translated;
            delete seg.failed;
            // quem traduziu; trecho sem palavras fica como no original (nenhum modelo mexeu nele)
            if (hooks.engine && (sent.has(it) || copyOf.has(it))) seg.by = hooks.engine;
            else delete seg.by;
            const w = warns.get(origin);
            if (w?.length) seg.warn = w;
            else delete seg.warn;
            d.words += seg.words;
            d.segments++;
          } else if (failed.has(it)) {
            seg.failed = true;
            delete seg.by;
            const r = reasons.get(origin);
            if (r) seg.warn = [r];
            else delete seg.warn;
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
  };

  let transient = 0;
  for (;;) {
    try {
      // numa nova tentativa depois de um erro temporário, só vai o que ainda falta
      const pending = toSend.filter((it) => !results.has(it) && !failed.has(it));
      if (pending.length) await attempt(pending, false, 0);
      break;
    } catch (err) {
      if (hooks.signal.aborted) throw err;
      const fatal = err instanceof ProviderError && err.fatal;
      if (!fatal) transient++;
      // limite por minuto ou provedor sobrecarregado: espera mais antes de desistir
      const isRate = err instanceof ProviderError && (err.code === "rate_limit" || err.code === "server");
      const wait = Math.min(15000 * 2 ** (transient - 1), 5 * 60_000);
      // o serviço pediu para esperar mais do que a próxima tentativa: parar já (sem gastar pedidos à toa)
      const asksLonger = err instanceof ProviderError && err.retryAt !== undefined && err.retryAt - Date.now() > wait;
      if (fatal || asksLonger || transient > (isRate ? 6 : 3)) {
        // antes de parar (ex.: a cota do dia acabou), grava o que já voltou: esses pedidos já foram gastos
        hooks.onActivity?.(null);
        await save().catch((e) => console.warn("[processor] não foi possível gravar o que já tinha voltado", e));
        throw err;
      }
      console.warn(`[processor] erro temporário (tentativa ${transient}); aguardando ${wait / 1000}s`, err);
      const now = Date.now();
      hooks.onActivity?.({ kind: "waiting", since: new Date(now).toISOString(), until: new Date(now + wait).toISOString() });
      await sleep(wait, hooks.signal);
    }
  }

  hooks.onActivity?.(null);
  await save();
}
