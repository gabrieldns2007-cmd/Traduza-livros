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
import type { BookActivity, BookMeta } from "@/types/book";
import { store, readSettings } from "@/lib/storage";
import { billingOf, defaultProviderId, FREE_PROVIDERS } from "@/lib/config";
import { billingMode } from "@/lib/billing/mode";
import { activeRunIds, BillingStop, RunLedger } from "@/services/billing/run-ledger";
import { wallet } from "@/services/billing/wallet";
import { routeProvider, type Route } from "@/services/commerce/routing";
import { toPlainText } from "@/lib/markup";
import { findLanguage } from "@/lib/languages";
import { mergeCandidates } from "@/services/glossary/glossary";
import { createProvider, type TranslationProvider } from "@/services/translation";
import { ProviderError } from "@/services/translation/llm/types";
import { KeyedMutex, mapLimit } from "@/utils/async";
import { bookContext, pendingChars, processChapters, translateRange } from "./chapter-processor";

const ACTIVE: BookMeta["status"][] = ["queued", "analyzing", "translating"];

class JobRunner {
  private queue: string[] = [];
  private current: { bookId: string; controller: AbortController } | null = null;
  private looping = false;
  private initialized = false;
  /** livros retomados enquanto a execução anterior ainda estava terminando */
  private restart = new Set<string>();
  private analysisMutex = new KeyedMutex();
  /** atividade atual de cada livro (pedido em andamento, espera de limite) */
  private activities = new Map<string, BookActivity>();
  /** prévias em andamento (podem ser canceladas ao excluir o livro) */
  private previews = new Map<string, AbortController>();
  /** livros cuja próxima execução pode usar só o saldo disponível (tradução parcial) */
  private partial = new Set<string>();
  /** serviços que falharam de vez para um livro (chave recusada, modelo indisponível) */
  private excluded = new Map<string, Set<string>>();
  /** retomadas agendadas para quando a cota voltar */
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** fábrica do provedor (substituível em testes) */
  providerFactory: (id: string, settings?: Awaited<ReturnType<typeof readSettings>>) => TranslationProvider = createProvider;

  /** Retoma livros que estavam em andamento quando o servidor parou. */
  async init() {
    if (this.initialized) return;
    this.initialized = true;
    const books = await store.list();
    if (billingMode() === "enforce") await wallet.releaseStale(activeRunIds()).catch(() => {});
    // prévia interrompida por reinício do servidor: pode ser pedida de novo
    for (const b of books.filter((x) => x.preview?.status === "running")) {
      await store.update(b.id, (m) => {
        if (m.preview) Object.assign(m.preview, { status: "error", error: "O servidor reiniciou. Peça a prévia de novo." });
      });
    }
    // traduções à espera de cota continuam sozinhas na hora marcada
    for (const b of books) if (b.status === "paused" && b.stopCode === "waiting" && b.resumeAt) this.scheduleResume(b.id, Date.parse(b.resumeAt));
    const pending = books.filter((b) => ACTIVE.includes(b.status)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    for (const b of pending) {
      // provedor pago nunca recomeça sozinho: fica pausado até o usuário confirmar —
      // a não ser que o cliente já tenha pago a tradução (o preço cobre esse custo)
      const paid =
        b.provider && !(FREE_PROVIDERS as readonly string[]).includes(b.provider.id) && b.provider.id !== "demo" && b.order?.status !== "paid";
      if (paid) {
        await store.update(b.id, (m) => {
          m.status = "paused";
          m.phase = "Pausado";
          m.activeChapterIds = [];
          m.error = "O servidor reiniciou. Toque em “Continuar tradução” para seguir.";
          m.stopCode = "restart";
          for (const c of m.chapters) if (c.status === "translating" || c.status === "analyzing") c.status = "pending";
        });
        continue;
      }
      await store.update(b.id, (m) => {
        m.status = "queued";
        m.activeChapterIds = [];
        m.phase = "Na fila";
        for (const c of m.chapters) if (c.status === "translating" || c.status === "analyzing") c.status = "pending";
      });
      this.enqueue(b.id);
    }
  }

  /** Agenda a retomada de uma tradução pausada à espera de cota. */
  private scheduleResume(bookId: string, at: number) {
    clearTimeout(this.timers.get(bookId));
    const delay = Math.min(Math.max(at - Date.now() + 5_000, 1_000), 2 ** 31 - 1);
    const t = setTimeout(async () => {
      this.timers.delete(bookId);
      const m = await store.get(bookId);
      if (m?.status === "paused" && m.stopCode === "waiting") await this.start(bookId);
    }, delay);
    (t as { unref?: () => void }).unref?.();
    this.timers.set(bookId, t);
  }

  /** Sem serviço com cota agora: pausa com aviso amigável e agenda a retomada. */
  private async waitForService(bookId: string, route: Extract<Route, { ok: false }>) {
    const resumeAt = route.retryAt;
    await store.update(bookId, (m) => {
      m.status = "paused";
      m.phase = "Na fila";
      m.activeChapterIds = [];
      m.stopCode = resumeAt ? "waiting" : "unavailable";
      m.resumeAt = resumeAt ? new Date(resumeAt).toISOString() : undefined;
      m.error = resumeAt
        ? "Sua tradução está na fila e continua sozinha em breve. Você não precisa fazer nada."
        : "Sua tradução foi pausada por um instante. Ela continua do mesmo ponto assim que o serviço voltar.";
      for (const c of m.chapters) if (c.status === "translating" || c.status === "analyzing") c.status = "pending";
    });
    if (resumeAt) this.scheduleResume(bookId, resumeAt);
  }

  isRunning(bookId: string) {
    return this.current?.bookId === bookId;
  }

  activity(bookId: string): BookActivity | null {
    return this.activities.get(bookId) ?? null;
  }

  queuePosition(bookId: string) {
    return this.queue.indexOf(bookId);
  }

  async start(bookId: string, opts: { partial?: boolean } = {}) {
    await this.init();
    this.excluded.delete(bookId);
    clearTimeout(this.timers.get(bookId));
    this.timers.delete(bookId);
    if (opts.partial) this.partial.add(bookId);
    else this.partial.delete(bookId);
    await store.update(bookId, (m) => {
      m.status = "queued";
      m.error = undefined;
      m.stopCode = undefined;
      m.resumeAt = undefined;
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

  isPreviewing(bookId: string) {
    return this.previews.has(bookId);
  }

  /**
   * Prévia grátis: traduz um trecho curto do primeiro capítulo de verdade
   * (pula capa, sumário e direitos autorais). Um único pedido; o trecho fica
   * salvo e não é traduzido de novo quando o livro todo for traduzido.
   */
  async preview(bookId: string, providerId: string) {
    await this.init();
    if (this.previews.has(bookId)) return;
    const settings = await readSettings();
    const provider = this.providerFactory(providerId, settings);
    const meta = (await store.get(bookId))!;
    const chapter = meta.chapters.find((c) => c.wordCount >= 150) ?? meta.chapters.find((c) => c.wordCount > 0);
    if (!chapter) throw new ProviderError("Não há texto para a prévia.", { fatal: true, code: "other" });
    const doc = await store.readDoc(bookId, chapter.docId);
    const budget = Math.min(2500, provider.limits.batchChars);
    let end = chapter.start;
    let chars = 0;
    while (end < chapter.end && (end === chapter.start || chars + doc.segments[end].src.length <= budget)) {
      chars += doc.segments[end].src.length;
      end++;
    }
    await store.update(bookId, (m) => {
      m.preview = {
        status: "running",
        provider: { id: provider.id, model: provider.model },
        chapterId: chapter.id,
        docId: chapter.docId,
        start: chapter.start,
        end,
        at: new Date().toISOString(),
      };
    });

    const controller = new AbortController();
    this.previews.set(bookId, controller);
    const ledger = await RunLedger.open((await store.get(bookId))!, "preview", {
      id: provider.id,
      model: provider.model,
      billing: billingOf(provider.id, settings),
    });
    void (async () => {
      let reason = "preview";
      try {
        await translateRange(meta, chapter, chapter.start, end, provider, {
          signal: controller.signal,
          analysisLock: (fn) => fn(),
          onChapterSaved: async () => {},
          onUsage: async (usage) => {
            await store.update(
              bookId,
              (m) => {
                m.usage.inputTokens += usage.inputTokens;
                m.usage.outputTokens += usage.outputTokens;
              },
              { persist: false },
            );
            await ledger.usage(usage);
          },
          onProgress: async (chapterId, delta) => {
            await ledger.progress(delta);
            await store.update(bookId, (m) => {
              const c = m.chapters.find((x) => x.id === chapterId)!;
              c.translatedWords += delta.words;
              c.translatedSegments += delta.segments;
              c.failedSegments += delta.failed;
              m.progress.translatedWords += delta.words;
              m.progress.translatedSegments += delta.segments;
            });
          },
          onActivity: (a) => {
            if (a) this.activities.set(bookId, a);
            else this.activities.delete(bookId);
          },
        });
        await store.update(bookId, (m) => {
          if (m.preview) m.preview.status = "done";
        });
      } catch (err) {
        reason = err instanceof ProviderError ? err.code : "error";
        if (!(await store.get(bookId))) return; // livro excluído
        const message = err instanceof ProviderError ? err.message : "Não foi possível fazer a prévia agora. Tente de novo.";
        console.warn(`[runner] prévia do livro ${bookId} falhou`, err);
        await store.update(bookId, (m) => {
          if (m.preview) Object.assign(m.preview, { status: "error", error: message });
        });
      } finally {
        this.previews.delete(bookId);
        this.activities.delete(bookId);
        await ledger.close(reason).catch(() => {});
      }
    })();
  }

  /** Para tudo antes de apagar um livro. */
  async stop(bookId: string) {
    this.previews.get(bookId)?.abort(new Error("deleted"));
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

    // confere o que já está traduzido em disco: capítulos completos ficam “done” e nunca são refeitos
    const resume = await recountProgress(bookId);
    if (resume)
      console.info(
        `[runner] ${bookId}: ${resume.doneChapters}/${resume.totalChapters} capítulos já concluídos; continuando de ${resume.nextChapterId ?? "—"}`,
      );

    // pedido de cliente (tipo de tradução): o serviço é escolhido por dentro, na ordem do painel,
    // pulando os que estão sem cota. Sem tipo: usa SEMPRE o provedor escolhido para o livro.
    const settings = await readSettings();
    let providerId: string;
    if (meta.level) {
      const route = await routeProvider(meta.level, settings, this.excluded.get(bookId));
      if (!route.ok) {
        await this.waitForService(bookId, route);
        return;
      }
      providerId = route.provider.id;
    } else {
      providerId = meta.provider?.id ?? defaultProviderId(settings);
    }
    let provider: TranslationProvider;
    try {
      provider = this.providerFactory(providerId, settings);
    } catch (err) {
      await store.update(bookId, (m) => {
        m.status = "paused";
        m.phase = "Pausado";
        m.error = err instanceof Error ? err.message : String(err);
        m.stopCode = err instanceof ProviderError ? err.code : "other";
      });
      return;
    }
    await store.update(bookId, (m) => {
      m.provider = { id: provider.id, model: provider.model };
      m.progress.startedAt ??= new Date().toISOString();
    });

    // registro da execução (custo real) e, em modo enforce com chave do Verso, reserva de créditos
    const doneAtStart = (await store.get(bookId))!.chapters.filter((c) => c.status === "done").length;
    let ledger: RunLedger;
    try {
      ledger = await RunLedger.open(
        (await store.get(bookId))!,
        "translation",
        {
          id: provider.id,
          model: provider.model,
          billing: billingOf(provider.id, settings),
        },
        { partial: this.partial.has(bookId) },
      );
    } catch (err) {
      if (!(err instanceof BillingStop)) throw err;
      await store.update(bookId, (m) => {
        m.status = "paused";
        m.phase = "Pausado";
        m.error = err.message;
        m.stopCode = err.code;
        m.activeChapterIds = [];
      });
      return;
    }
    let stopReason = "done";

    // medição de ritmo para estimar o tempo restante
    const runStart = Date.now();
    const base = (await store.get(bookId))!;
    const baseActive = base.progress.activeMs;
    const baseMeasured = base.progress.measuredWords;
    const wordsAtStart = base.progress.translatedWords;

    // sinal interno: cancela os outros grupos se um deles falhar de vez
    const inner = new AbortController();
    const forward = () => inner.abort(signal.reason);
    signal.addEventListener("abort", forward, { once: true });

    const hooks = {
      signal: inner.signal,
      analysisLock: <T>(fn: () => Promise<T>) => this.analysisMutex.run(`analysis:${bookId}`, fn),
      onUsage: async (usage: { inputTokens: number; outputTokens: number }) => {
        if (!usage.inputTokens && !usage.outputTokens) return;
        await store.update(
          bookId,
          (m) => {
            m.usage.inputTokens += usage.inputTokens;
            m.usage.outputTokens += usage.outputTokens;
          },
          { persist: false },
        );
        await ledger.usage(usage);
      },
      beforeBatch: (words: number) => ledger.beforeBatch(words),
      onProgress: async (chapterId: string, delta: { words: number; segments: number; failed: number }) => {
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
        await ledger.progress(delta);
      },
      onChapterSaved: (chapterId: string) => this.finishChapter(bookId, chapterId, provider),
      onActivity: (a: BookActivity | null) => {
        if (a) this.activities.set(bookId, a);
        else this.activities.delete(bookId);
      },
    };

    try {
      if (!base.profile) await this.analyzeBook(bookId, provider, signal, ledger);

      await store.update(bookId, (m) => {
        m.status = "translating";
        m.phase = "Traduzindo";
      });

      // várias passagens: capítulos marcados para retradução durante a execução também entram
      const translatePending = async () => {
        for (let pass = 0; pass < 3; pass++) {
          const fresh = (await store.get(bookId))!;
          const todo = fresh.chapters.filter((c) => c.status !== "done");
          if (!todo.length || inner.signal.aborted) break;

          // capítulos pequenos e consecutivos vão juntos no mesmo pedido (menos chamadas)
          const groups: (typeof todo)[] = [];
          let group: typeof todo = [];
          let chars = 0;
          for (const c of todo) {
            const n = await pendingChars(bookId, c);
            if (group.length && (chars + n > provider.limits.batchChars || group.length >= 40)) {
              groups.push(group);
              group = [];
              chars = 0;
            }
            group.push(c);
            chars += n;
          }
          if (group.length) groups.push(group);

          await mapLimit(
            groups,
            provider.limits.concurrency,
            async (chapters) => {
              if (inner.signal.aborted) return;
              try {
                await store.update(bookId, (m) => {
                  for (const ch of chapters) {
                    const c = m.chapters.find((x) => x.id === ch.id)!;
                    c.status = "translating";
                    if (!m.activeChapterIds.includes(c.id)) m.activeChapterIds.push(c.id);
                  }
                });
                const latest = (await store.get(bookId))!;
                const ids = new Set(chapters.map((c) => c.id));
                await processChapters(
                  latest,
                  latest.chapters.filter((c) => ids.has(c.id)),
                  provider,
                  hooks,
                );
                for (const c of chapters) await this.finishChapter(bookId, c.id, provider);
              } catch (err) {
                if (!inner.signal.aborted) inner.abort(err);
                throw err;
              }
            },
            inner.signal,
          );
        }
      };
      await translatePending();
      if (signal.aborted) throw signal.reason ?? new Error("aborted");

      // revisão automática (pedido de cliente): uma rodada que refaz os trechos que falharam
      // e os que voltaram iguais ao original. Se a execução for retomada no meio, só termina
      // o que ficou pendente (não marca de novo).
      const reviewing = (await store.get(bookId))!;
      if (reviewing.level && !reviewing.review?.finishedAt) {
        const segments = reviewing.review ? 0 : await markForReview(bookId);
        await store.update(bookId, (m) => {
          m.phase = "Revisando";
          m.review = { startedAt: m.review?.startedAt ?? new Date().toISOString(), segments: m.review?.segments ?? segments };
        });
        if (segments) await translatePending();
        if (signal.aborted) throw signal.reason ?? new Error("aborted");
        await store.update(bookId, (m) => {
          if (m.review) m.review.finishedAt = new Date().toISOString();
        });
      }

      // capítulos que ficaram prontos sem passar por aqui (ex.: inteiros na amostra): falta o título traduzido
      for (const c of (await store.get(bookId))!.chapters) if (c.status === "done" && !c.translatedTitle) await this.finishChapter(bookId, c.id);

      await store.update(bookId, (m) => {
        m.status = "done";
        m.phase = undefined;
        m.activeChapterIds = [];
        m.progress.finishedAt = new Date().toISOString();
      });
      await store.clearExports(bookId);
    } catch (err) {
      stopReason = signal.aborted ? "paused" : err instanceof ProviderError ? err.code : "error";
      // pedido de cliente: se este serviço ficou sem cota (ou recusou a chave), segue com o próximo da lista
      const leveled = !signal.aborted && (await store.get(bookId))?.level;
      if (leveled && err instanceof ProviderError && ["quota", "auth", "model"].includes(err.code)) {
        console.info(`[runner] ${bookId}: ${provider.id} indisponível (${err.code}); procurando outro serviço`);
        if (err.code !== "quota") this.excluded.set(bookId, new Set([...(this.excluded.get(bookId) ?? []), provider.id]));
        await recountProgress(bookId);
        const route = await routeProvider(leveled, settings, this.excluded.get(bookId));
        if (route.ok) {
          await store.update(bookId, (m) => {
            m.status = "queued";
            m.phase = "Na fila";
            m.activeChapterIds = [];
            m.error = undefined;
            m.stopCode = undefined;
            for (const c of m.chapters) if (c.status === "translating" || c.status === "analyzing") c.status = "pending";
          });
          this.restart.add(bookId);
        } else {
          await this.waitForService(bookId, route);
        }
        return;
      }
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
      console.error(`[runner] livro ${bookId} parou`, err);
      // nada é apagado: o que já foi traduzido continua salvo e a tradução fica pausada, pronta para continuar
      await recountProgress(bookId);
      await store.update(bookId, (m) => {
        m.status = err instanceof ProviderError && err.fatal ? "paused" : "error";
        m.error = message;
        m.stopCode = err instanceof ProviderError ? err.code : "other";
        m.phase = m.status === "paused" ? "Pausado" : undefined;
        m.activeChapterIds = [];
        for (const c of m.chapters) if (c.status === "translating" || c.status === "analyzing") c.status = "pending";
      });
    } finally {
      this.activities.delete(bookId);
      this.partial.delete(bookId);
      signal.removeEventListener("abort", forward);
      const latest = await store.get(bookId);
      const doneNow = latest?.chapters.filter((c) => c.status === "done").length ?? doneAtStart;
      await ledger.close(stopReason, Math.max(0, doneNow - doneAtStart)).catch((e) => console.warn("[runner] falha ao fechar registro", e));
      if (latest) await store.flush(bookId);
    }
  }

  /** Conhece o livro: perfil literário, glossário inicial, título e sumário traduzidos. */
  private async analyzeBook(bookId: string, provider: TranslationProvider, signal: AbortSignal, ledger?: RunLedger) {
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
      if (total >= Math.min(16000, provider.limits.batchChars)) break;
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
    if ("usage" in analysis && analysis.usage) await ledger?.usage(analysis.usage);
  }

  private async finishChapter(bookId: string, chapterId: string, provider?: TranslationProvider) {
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
      if (allDone && provider && c.translatedSegments > 0 && !c.provider) {
        c.provider = provider.id;
        c.model = provider.model;
      }
      if (translatedTitle) c.translatedTitle = translatedTitle;
      m.activeChapterIds = m.activeChapterIds.filter((id) => id !== chapterId);
    });
  }
}

/** Trecho que voltou igual ao original (frase de verdade, não um nome ou “* * *”). */
function looksUntranslated(src: string, out: string): boolean {
  const a = toPlainText(src).replace(/\s+/g, " ").trim();
  return a === toPlainText(out).replace(/\s+/g, " ").trim() && a.split(" ").length >= 4 && /\p{L}{3}/u.test(a);
}

/**
 * Revisão automática: libera para nova tradução os trechos que falharam e os
 * que voltaram iguais ao original. Trechos editados à mão nunca são tocados.
 * Devolve quantos trechos serão refeitos.
 */
export async function markForReview(bookId: string): Promise<number> {
  const meta = await store.get(bookId);
  if (!meta) return 0;
  const source = findLanguage(meta.sourceLanguage ?? meta.detectedLanguage);
  const sameLanguage = !source || source.code === findLanguage(meta.targetLanguage)?.code;
  let count = 0;
  for (const d of meta.docs) {
    const doc = await store.readDoc(bookId, d.id);
    const needs = (s: (typeof doc.segments)[number]) =>
      !s.edited && ((s.failed && s.out === undefined) || (!sameLanguage && s.out !== undefined && looksUntranslated(s.src, s.out)));
    if (!doc.segments.some(needs)) continue;
    await store.updateDoc(bookId, d.id, (content) => {
      for (const s of content.segments) {
        if (!needs(s)) continue;
        delete s.failed;
        delete s.out;
        count++;
      }
    });
  }
  if (count) await recountProgress(bookId);
  return count;
}

/**
 * Reconcilia o progresso com o que está gravado em disco (fonte da verdade):
 * conta palavras/segmentos traduzidos e marca como concluído todo capítulo
 * cujos trechos já têm tradução. Nunca apaga traduções.
 * Retorna o resumo da retomada (capítulos concluídos e próximo capítulo).
 */
export async function recountProgress(bookId: string) {
  const meta = await store.get(bookId);
  if (!meta) return null;
  const docs = new Map<string, Awaited<ReturnType<typeof store.readDoc>>>();
  for (const d of meta.docs) docs.set(d.id, await store.readDoc(bookId, d.id));
  const updated = await store.update(bookId, (m) => {
    let words = 0;
    let segs = 0;
    for (const c of m.chapters) {
      const range = docs.get(c.docId)?.segments.slice(c.start, c.end) ?? [];
      const translated = range.filter((s) => s.out !== undefined);
      c.translatedWords = translated.reduce((a, s) => a + s.words, 0);
      c.translatedSegments = translated.length;
      c.failedSegments = range.filter((s) => s.failed && s.out === undefined).length;
      const complete = range.every((s) => s.out !== undefined || s.failed);
      if (complete && c.status !== "translating") c.status = "done";
      else if (!complete && c.status === "done") c.status = "pending";
      words += c.translatedWords;
      segs += c.translatedSegments;
    }
    m.progress.translatedWords = words;
    m.progress.translatedSegments = segs;
  });
  const next = updated.chapters.find((c) => c.status !== "done");
  return {
    totalChapters: updated.chapters.length,
    doneChapters: updated.chapters.filter((c) => c.status === "done").length,
    nextChapterId: next?.id ?? null,
    nextChapterIndex: next ? updated.chapters.indexOf(next) : -1,
  };
}

const g = globalThis as unknown as { __versoRunner?: JobRunner };
export const jobRunner: JobRunner = g.__versoRunner ?? (g.__versoRunner = new JobRunner());
