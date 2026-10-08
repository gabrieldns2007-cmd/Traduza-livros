/**
 * Fila de tradução em segundo plano.
 *
 * Roda dentro do próprio servidor Node (sem infraestrutura extra). Um livro
 * por vez; dentro do livro, alguns capítulos em paralelo. Todo o estado fica
 * em disco, então:
 *   - você pode fechar o navegador/celular: a tradução continua no servidor;
 *   - se o servidor reiniciar, os livros em andamento voltam para a fila e
 *     continuam de onde pararam.
 */
import type { BookMeta } from "@/types/book";
import { store, readSettings } from "@/lib/storage";
import { config } from "@/lib/config";
import { toPlainText } from "@/lib/markup";
import { mergeCandidates } from "@/services/glossary/glossary";
import { getTranslationProvider, type TranslationProvider } from "@/services/translation";
import { ProviderError } from "@/services/translation/llm/types";
import { KeyedMutex, mapLimit } from "@/utils/async";
import { bookContext, processChapter } from "./chapter-processor";

const ACTIVE: BookMeta["status"][] = ["queued", "analyzing", "translating"];

class JobRunner {
  private queue: string[] = [];
  private current: { bookId: string; controller: AbortController } | null = null;
  private looping = false;
  private initialized = false;
  /** livros retomados enquanto a execução anterior ainda estava terminando */
  private restart = new Set<string>();
  private analysisMutex = new KeyedMutex();

  /** Retoma livros que estavam em andamento quando o servidor parou. */
  async init() {
    if (this.initialized) return;
    this.initialized = true;
    const books = await store.list();
    const pending = books.filter((b) => ACTIVE.includes(b.status)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    for (const b of pending) {
      await store.update(b.id, (m) => {
        m.status = "queued";
        m.activeChapterIds = [];
        m.phase = "Na fila";
        for (const c of m.chapters) if (c.status === "translating" || c.status === "analyzing") c.status = "pending";
      });
      this.enqueue(b.id);
    }
  }

  isRunning(bookId: string) {
    return this.current?.bookId === bookId;
  }

  queuePosition(bookId: string) {
    return this.queue.indexOf(bookId);
  }

  async start(bookId: string) {
    await this.init();
    await store.update(bookId, (m) => {
      m.status = "queued";
      m.error = undefined;
      m.phase = this.current ? "Na fila — aguardando outro livro" : "Estamos preparando sua tradução";
    });
    this.enqueue(bookId);
  }

  async pause(bookId: string) {
    this.queue = this.queue.filter((id) => id !== bookId);
    if (this.current?.bookId === bookId) this.current.controller.abort(new Error("paused"));
    await store.update(bookId, (m) => {
      if (m.status !== "done") {
        m.status = "paused";
        m.phase = "Pausado";
      }
      m.activeChapterIds = [];
    });
  }

  /** Para tudo antes de apagar um livro. */
  async stop(bookId: string) {
    this.queue = this.queue.filter((id) => id !== bookId);
    if (this.current?.bookId === bookId) {
      this.current.controller.abort(new Error("deleted"));
      // dá tempo para o lote em andamento ser cancelado
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  private enqueue(bookId: string) {
    if (this.current?.bookId === bookId) {
      if (this.current.controller.signal.aborted) this.restart.add(bookId);
    } else if (!this.queue.includes(bookId)) {
      this.queue.push(bookId);
    }
    void this.loop();
  }

  private async loop() {
    if (this.looping) return;
    this.looping = true;
    try {
      while (this.queue.length) {
        const bookId = this.queue.shift()!;
        const controller = new AbortController();
        this.current = { bookId, controller };
        try {
          await this.run(bookId, controller.signal);
        } catch (err) {
          console.error(`[runner] falha inesperada no livro ${bookId}`, err);
        } finally {
          this.current = null;
          if (this.restart.delete(bookId)) this.queue.push(bookId);
        }
      }
    } finally {
      this.looping = false;
    }
  }

  private async run(bookId: string, signal: AbortSignal) {
    const meta = await store.get(bookId);
    if (!meta || meta.status === "paused" || meta.status === "done") return;

    const settings = await readSettings();
    const provider = getTranslationProvider(settings.providerId);
    await store.update(bookId, (m) => {
      m.provider = { id: provider.id, model: provider.model };
      m.progress.startedAt ??= new Date().toISOString();
    });

    // medição de ritmo para estimar o tempo restante
    const runStart = Date.now();
    const base = (await store.get(bookId))!;
    const baseActive = base.progress.activeMs;
    const baseMeasured = base.progress.measuredWords;
    const wordsAtStart = base.progress.translatedWords;

    // sinal interno: cancela os outros capítulos se um deles falhar de vez
    const inner = new AbortController();
    const forward = () => inner.abort(signal.reason);
    signal.addEventListener("abort", forward, { once: true });

    try {
      if (!base.profile) await this.analyzeBook(bookId, provider, signal);

      await store.update(bookId, (m) => {
        m.status = "translating";
        m.phase = "Traduzindo";
      });

      // várias passagens: capítulos marcados para retradução durante a execução também entram
      for (let pass = 0; pass < 3; pass++) {
        const fresh = (await store.get(bookId))!;
        const todo = fresh.chapters.filter((c) => c.status !== "done");
        if (!todo.length || inner.signal.aborted) break;

        await mapLimit(
          todo,
          config.concurrency,
          async (chapter) => {
            if (inner.signal.aborted) return;
            try {
              await store.update(bookId, (m) => {
                const c = m.chapters.find((x) => x.id === chapter.id)!;
                c.status = "translating";
                if (!m.activeChapterIds.includes(c.id)) m.activeChapterIds.push(c.id);
              });
              const latest = (await store.get(bookId))!;
              const ch = latest.chapters.find((x) => x.id === chapter.id)!;

              await processChapter(latest, ch, provider, {
                signal: inner.signal,
                analysisLock: (fn) => this.analysisMutex.run(`analysis:${bookId}`, fn),
                onUsage: async (usage) => {
                  if (!usage.inputTokens && !usage.outputTokens) return;
                  await store.update(
                    bookId,
                    (m) => {
                      m.usage.inputTokens += usage.inputTokens;
                      m.usage.outputTokens += usage.outputTokens;
                    },
                    { persist: false },
                  );
                },
                onProgress: async (chapterId, delta) => {
                  await store.update(bookId, (m) => {
                    const c = m.chapters.find((x) => x.id === chapterId)!;
                    c.translatedWords += delta.words;
                    c.translatedSegments += delta.segments;
                    c.failedSegments += delta.failed;
                    m.progress.translatedWords += delta.words;
                    m.progress.translatedSegments += delta.segments;
                    m.progress.activeMs = baseActive + (Date.now() - runStart);
                    m.progress.measuredWords = baseMeasured + (m.progress.translatedWords - wordsAtStart);
                  });
                },
              });

              await this.finishChapter(bookId, chapter.id);
            } catch (err) {
              if (!inner.signal.aborted) inner.abort(err);
              throw err;
            }
          },
          inner.signal,
        );
      }

      if (signal.aborted) throw signal.reason ?? new Error("aborted");

      await store.update(bookId, (m) => {
        m.status = "done";
        m.phase = undefined;
        m.activeChapterIds = [];
        m.progress.finishedAt = new Date().toISOString();
      });
      await store.clearExports(bookId);
    } catch (err) {
      if (signal.aborted) {
        // pausa ou exclusão: pause()/stop() já ajustaram o estado
        if (await store.get(bookId)) {
          await store.update(bookId, (m) => {
            m.activeChapterIds = [];
            for (const c of m.chapters) if (c.status === "translating" || c.status === "analyzing") c.status = "pending";
            if (m.status !== "queued") {
              m.status = "paused";
              m.phase = "Pausado";
            }
          });
        }
        return;
      }
      const message =
        err instanceof ProviderError ? err.message : `Algo deu errado durante a tradução: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[runner] livro ${bookId} parou com erro`, err);
      await store.update(bookId, (m) => {
        m.status = "error";
        m.error = message;
        m.phase = undefined;
        m.activeChapterIds = [];
        for (const c of m.chapters) if (c.status === "translating" || c.status === "analyzing") c.status = "pending";
      });
    } finally {
      signal.removeEventListener("abort", forward);
      if (await store.get(bookId)) await store.flush(bookId);
    }
  }

  /** Conhece o livro: perfil literário, glossário inicial, título e sumário traduzidos. */
  private async analyzeBook(bookId: string, provider: TranslationProvider, signal: AbortSignal) {
    await store.update(bookId, (m) => {
      m.status = "analyzing";
      m.phase = "Conhecendo o livro";
    });
    const meta = (await store.get(bookId))!;

    // amostra: começo dos primeiros capítulos com texto de verdade
    const parts: string[] = [];
    let total = 0;
    const substantial = meta.chapters.filter((c) => c.wordCount >= 300);
    for (const ch of substantial.length ? substantial : meta.chapters) {
      if (total >= 16000) break;
      const doc = await store.readDoc(bookId, ch.docId);
      const text = doc.segments
        .slice(ch.start, ch.end)
        .map((s) => toPlainText(s.src))
        .join("\n\n")
        .slice(0, 3500);
      parts.push(`[${ch.title}]\n${text}`);
      total += text.length;
    }
    const tocLabels = [...new Set(meta.toc.map((t) => t.label))].slice(0, 300);

    let analysis;
    try {
      analysis = await provider.analyzeBook({ book: bookContext(meta), sample: parts.join("\n\n---\n\n"), tocLabels }, signal);
    } catch (err) {
      if (err instanceof ProviderError && err.fatal) throw err;
      if (signal.aborted) throw err;
      console.warn("[runner] análise do livro falhou; seguindo sem perfil", err);
      analysis = { profile: { genre: "", tone: "", narrativeVoice: "", styleNotes: "" }, glossary: [], tocTranslations: [] as string[] };
    }

    const tocMap = new Map<string, string>();
    tocLabels.forEach((label, i) => {
      const t = analysis.tocTranslations[i];
      if (t && analysis.tocTranslations.length === tocLabels.length) tocMap.set(label, t);
    });

    await store.updateGlossary(bookId, (entries) => mergeCandidates(entries, analysis.glossary));
    await store.update(bookId, (m) => {
      m.profile = analysis.profile;
      if (analysis.translatedTitle) m.translatedTitle ??= analysis.translatedTitle;
      if (!m.sourceLanguage && !m.detectedLanguage && "sourceLanguage" in analysis && analysis.sourceLanguage) {
        m.detectedLanguage = analysis.sourceLanguage;
      }
      for (const t of m.toc) if (tocMap.has(t.label)) t.translatedLabel = tocMap.get(t.label);
      for (const c of m.chapters) if (!c.translatedTitle && tocMap.has(c.title)) c.translatedTitle = tocMap.get(c.title);
      if ("usage" in analysis && analysis.usage) {
        m.usage.inputTokens += analysis.usage.inputTokens;
        m.usage.outputTokens += analysis.usage.outputTokens;
      }
    });
  }

  private async finishChapter(bookId: string, chapterId: string) {
    const meta = (await store.get(bookId))!;
    const ch = meta.chapters.find((c) => c.id === chapterId)!;
    const doc = await store.readDoc(bookId, ch.docId);
    const segs = doc.segments.slice(ch.start, ch.end);
    // título traduzido: o do sumário, ou a tradução do primeiro título do capítulo
    let translatedTitle = ch.translatedTitle;
    if (!translatedTitle) {
      const heading =
        segs.find((s) => s.role === "heading" && s.out && toPlainText(s.src).trim() === ch.title) ?? segs.find((s) => s.role === "heading" && s.out);
      if (heading?.out) translatedTitle = toPlainText(heading.out).trim().slice(0, 160);
    }
    const allDone = segs.every((s) => s.out !== undefined || s.failed);
    await store.update(bookId, (m) => {
      const c = m.chapters.find((x) => x.id === chapterId)!;
      c.status = allDone ? "done" : "pending";
      if (translatedTitle) c.translatedTitle = translatedTitle;
      m.activeChapterIds = m.activeChapterIds.filter((id) => id !== chapterId);
    });
  }
}

/** Recalcula o progresso a partir dos segmentos gravados (após edições ou retraduções). */
export async function recountProgress(bookId: string) {
  const meta = await store.get(bookId);
  if (!meta) return;
  const docs = new Map<string, Awaited<ReturnType<typeof store.readDoc>>>();
  for (const d of meta.docs) docs.set(d.id, await store.readDoc(bookId, d.id));
  await store.update(bookId, (m) => {
    let words = 0;
    let segs = 0;
    for (const c of m.chapters) {
      const range = docs.get(c.docId)?.segments.slice(c.start, c.end) ?? [];
      c.translatedWords = range.filter((s) => s.out !== undefined).reduce((a, s) => a + s.words, 0);
      c.translatedSegments = range.filter((s) => s.out !== undefined).length;
      c.failedSegments = range.filter((s) => s.failed && s.out === undefined).length;
      words += c.translatedWords;
      segs += c.translatedSegments;
    }
    m.progress.translatedWords = words;
    m.progress.translatedSegments = segs;
  });
}

const g = globalThis as unknown as { __versoRunner?: JobRunner };
export const jobRunner: JobRunner = g.__versoRunner ?? (g.__versoRunner = new JobRunner());
