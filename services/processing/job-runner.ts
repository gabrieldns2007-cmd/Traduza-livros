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
import type { BookActivity, BookMeta, BookOrder, Segment } from "@/types/book";
import { store, readSettings, type Settings } from "@/lib/storage";
import { billingOf, defaultProviderId, freeProviderIds, isPaidProviderId, providerConfigs } from "@/lib/config";
import { PUBLIC_MODE } from "@/lib/mode";
import { billingMode } from "@/lib/billing/mode";
import { activeRunIds, BillingStop, RunLedger } from "@/services/billing/run-ledger";
import { wallet } from "@/services/billing/wallet";
import { modalityOf, routeProvider, type LevelId, type Modality, type Route } from "@/services/commerce/routing";
import { isFreeProvider, recordExhausted } from "@/services/quota/usage";
import { MIN_COOLDOWN_MS, recordFailure, recordSuccess } from "@/services/providers/health";
import { toPlainText } from "@/lib/markup";
import { checkSegment, type HardIssue } from "@/lib/quality";
import { mergeCandidates } from "@/services/glossary/glossary";
import { createProvider, type TranslationProvider } from "@/services/translation";
import { ProviderError } from "@/services/translation/llm/types";
import { KeyedMutex, mapLimit } from "@/utils/async";
import { batchLimits, bookContext, pendingLoad, processChapters, translateRange } from "./chapter-processor";

const ACTIVE: BookMeta["status"][] = ["queued", "analyzing", "translating"];

/** Grátis sem hora conhecida para voltar: tenta de novo em 15 min, 30, 60… até 6 h. */
export const WAIT_FIRST_MS = 15 * 60_000;
export const WAIT_MAX_MS = 6 * 3600_000;

/**
 * Troca da Grátis para a Literária ainda sem pagamento: a Grátis espera parada por
 * no máximo este tempo. Depois, o pedido da troca é cancelado e a Grátis segue sozinha.
 */
export const UPGRADE_HOLD_MS = 2 * 3600_000;

type Usage = { inputTokens: number; outputTokens: number };

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
  /** prévias em andamento (canceladas ao excluir o livro ou antes de a tradução começar); `done` resolve quando terminam */
  private previews = new Map<string, { controller: AbortController; done: Promise<void> }>();
  /** livros cuja próxima execução pode usar só o saldo disponível (tradução parcial) */
  private partial = new Set<string>();
  /**
   * Literária: serviços que falharam de vez para um livro (chave recusada, modelo
   * indisponível). A Grátis não usa: a saúde de cada serviço (para todos os livros)
   * já tira de cena quem falhou, e devolve a hora em que ele volta.
   */
  private excluded = new Map<string, Set<string>>();
  /** trocas de serviço desde o último start() (trava contra trocas sem fim) */
  private switches = new Map<string, number>();
  /** esperas seguidas sem hora conhecida (cada uma dobra a próxima); zera quando a tradução anda */
  private waits = new Map<string, number>();
  /** retomadas agendadas para quando a cota voltar */
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** fim da espera pelo pagamento de uma troca para a Literária (a Grátis volta sozinha) */
  private holds = new Map<string, ReturnType<typeof setTimeout>>();
  /** fábrica do provedor (substituível em testes) */
  providerFactory: (id: string, settings?: Awaited<ReturnType<typeof readSettings>>) => TranslationProvider = createProvider;

  /** Retoma livros que estavam em andamento quando o servidor parou. */
  async init() {
    if (this.initialized) return;
    this.initialized = true;
    const books = await store.list();
    if (billingMode() === "enforce") await wallet.releaseStale(activeRunIds()).catch(() => {});
    for (const b of books) {
      // pedido Padrão confirmado no beta, de antes da Grátis (com preço): é a tradução grátis — R$ 0, sem cobrança
      if (b.order && isLegacyBetaFree(b.order)) {
        await store.update(b.id, (m) => {
          if (m.order && isLegacyBetaFree(m.order)) Object.assign(m.order, { priceBrl: 0, payment: "free" });
        });
      }
      // troca para a Literária esperando o pagamento: a Grátis volta sozinha no fim do prazo (mesmo depois de reiniciar)
      const o = b.order;
      if (o?.status === "awaiting_payment" && o.replaces) {
        let at = o.expiresAt ? Date.parse(o.expiresAt) : NaN;
        if (!Number.isFinite(at)) {
          // pedido de antes do prazo: ganha o prazo a partir de agora
          at = Date.now() + UPGRADE_HOLD_MS;
          await store.update(b.id, (m) => {
            if (m.order?.id === o.id) m.order.expiresAt = new Date(at).toISOString();
          });
        }
        this.scheduleUpgradeExpiry(b.id, at);
      }
    }
    // prévia interrompida por reinício do servidor: pode ser pedida de novo
    for (const b of books.filter((x) => x.preview?.status === "running")) {
      await store.update(b.id, (m) => {
        if (m.preview) Object.assign(m.preview, { status: "error", error: "O servidor reiniciou. Peça a prévia de novo." });
      });
    }
    // traduções à espera de cota continuam sozinhas na hora marcada
    for (const b of books) {
      if (b.status !== "paused") continue;
      if (b.stopCode === "waiting" && b.resumeAt) this.scheduleResume(b.id, Date.parse(b.resumeAt));
      else if (b.level && modalityOf(b.level) === "free" && (b.stopCode === "unavailable" || b.stopCode === "waiting")) {
        // Grátis pausada “até o serviço voltar”, sem hora marcada (versão anterior): ganha uma hora para tentar de novo
        const at = Date.now() + WAIT_FIRST_MS;
        await store.update(b.id, (m) => {
          m.stopCode = "waiting";
          m.resumeAt = new Date(at).toISOString();
        });
        this.scheduleResume(b.id, at);
      }
    }
    const pending = books.filter((b) => ACTIVE.includes(b.status)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    for (const b of pending) {
      // provedor pago nunca recomeça sozinho: fica pausado até o usuário confirmar —
      // a não ser que o cliente já tenha pago a tradução (o preço cobre esse custo)
      const paid = b.provider && isPaidProviderId(b.provider.id) && b.order?.status !== "paid";
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

  /**
   * Sem serviço com cota agora: pausa com aviso amigável e agenda a retomada.
   * Grátis: sempre volta sozinha — na hora em que a primeira cota ou o primeiro
   * serviço com falha volta; sem hora conhecida, em 15 min, depois 30, 60… até 6 h.
   */
  private async waitForService(bookId: string, route: Extract<Route, { ok: false }>, modality?: Modality, signal?: AbortSignal) {
    // pausado (ou excluído) enquanto procurava outro serviço: a pausa vale, nada é agendado
    if (signal?.aborted) return this.settleAborted(bookId);
    let resumeAt = route.retryAt;
    if (!resumeAt && modality === "free") {
      const n = this.waits.get(bookId) ?? 0;
      this.waits.set(bookId, n + 1);
      resumeAt = Date.now() + Math.min(WAIT_FIRST_MS * 2 ** n, WAIT_MAX_MS);
    }
    let applied = false;
    await store.update(bookId, (m) => {
      // conferido dentro da trava: uma pausa que chegou agora não é desfeita
      if (signal?.aborted) return;
      applied = true;
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
    if (!applied || signal?.aborted) return this.settleAborted(bookId);
    if (resumeAt) this.scheduleResume(bookId, resumeAt);
  }

  /**
   * O dono salvou chave, conta ou modelo novos de um serviço gratuito: os livros da
   * Grátis à espera de um serviço tentam de novo agora (sem esperar a hora marcada).
   */
  async wakeWaiting() {
    await this.init();
    for (const b of await store.list()) {
      if (b.status !== "paused" || b.stopCode !== "waiting" || !b.level || modalityOf(b.level) !== "free") continue;
      this.waits.delete(b.id);
      this.scheduleResume(b.id, Date.now() - 5_000);
    }
  }

  /** Agenda o fim do prazo de uma troca para a Literária sem pagamento (`at`: ms). */
  scheduleUpgradeExpiry(bookId: string, at: number) {
    clearTimeout(this.holds.get(bookId));
    const delay = Math.min(Math.max(at - Date.now() + 1_000, 1_000), 2 ** 31 - 1);
    const t = setTimeout(() => {
      this.holds.delete(bookId);
      void this.expireUpgrade(bookId).catch((e) => console.warn(`[runner] ${bookId}: não foi possível encerrar a troca sem pagamento`, e));
    }, delay);
    (t as { unref?: () => void }).unref?.();
    this.holds.set(bookId, t);
  }

  /** A troca foi paga (ou trocada por outra escolha): o prazo deixa de valer. */
  clearUpgradeHold(bookId: string) {
    clearTimeout(this.holds.get(bookId));
    this.holds.delete(bookId);
  }

  /**
   * Troca para a Literária não paga no prazo: o pedido da troca é cancelado, o
   * pedido grátis volta a valer e a Grátis segue sozinha do mesmo ponto (ou espera
   * um serviço gratuito, com a volta agendada). Devolve true se cancelou.
   */
  async expireUpgrade(bookId: string, now = Date.now()): Promise<boolean> {
    let expired = false;
    if (!(await store.get(bookId))) return false;
    await store.update(bookId, (m) => {
      const o = m.order;
      if (!o || o.status !== "awaiting_payment" || !o.replaces || !o.expiresAt || Date.parse(o.expiresAt) > now) return;
      const history = m.orderHistory ?? [];
      const free = history.find((x) => x.id === o.replaces && x.status === "paid");
      const at = new Date(now).toISOString();
      m.orderHistory = [...history.filter((x) => x !== free), { ...o, status: "canceled", canceledAt: at }];
      // o pedido grátis de antes (ou, num livro antigo sem histórico, um igual a ele)
      m.order = free ?? {
        id: o.replaces,
        level: "padrao",
        words: o.words,
        priceBrl: 0,
        status: "paid",
        payment: "free",
        createdAt: o.createdAt,
        paidAt: at,
      };
      m.level = "padrao";
      expired = true;
    });
    this.clearUpgradeHold(bookId);
    if (!expired) return false;
    console.info(`[runner] ${bookId}: a troca para a Literária não foi paga no prazo; a tradução grátis segue sozinha`);
    const m = await store.get(bookId);
    if (m && (m.status === "paused" || m.status === "error")) await this.start(bookId);
    return true;
  }

  /** Ao abrir o livro: uma troca sem pagamento com o prazo vencido é encerrada na hora (sem esperar o temporizador). */
  async checkUpgrade(meta: BookMeta): Promise<BookMeta> {
    const o = meta.order;
    if (o?.status !== "awaiting_payment" || !o.replaces || !o.expiresAt || Date.parse(o.expiresAt) > Date.now()) return meta;
    await this.expireUpgrade(meta.id);
    return (await store.get(meta.id)) ?? meta;
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
    // já está traduzindo: nada muda (não volta para “na fila” nem esquece os serviços que falharam)
    if (this.current?.bookId === bookId && !this.current.controller.signal.aborted) return;
    // a amostra grátis nunca roda junto com a tradução do livro (as duas gravariam os mesmos trechos)
    await this.cancelPreview(bookId);
    this.excluded.delete(bookId);
    this.switches.delete(bookId);
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
    // pausada de propósito: não volta sozinha na hora marcada
    clearTimeout(this.timers.get(bookId));
    this.timers.delete(bookId);
    await store.update(bookId, (m) => {
      if (m.status !== "done") {
        m.status = "paused";
        m.phase = "Pausado";
      }
      if (m.stopCode === "waiting") {
        m.stopCode = undefined;
        m.resumeAt = undefined;
      }
      m.activeChapterIds = [];
    });
  }

  isPreviewing(bookId: string) {
    return this.previews.has(bookId);
  }

  /** Cancela a prévia em andamento (se houver) e espera ela terminar de verdade. */
  async cancelPreview(bookId: string) {
    const p = this.previews.get(bookId);
    if (!p) return;
    p.controller.abort(new Error("canceled"));
    await p.done;
  }

  /**
   * Prévia grátis: traduz um trecho curto do primeiro capítulo de verdade
   * (pula capa, sumário e direitos autorais). Um único pedido; o trecho fica
   * salvo e não é traduzido de novo quando o livro todo for traduzido.
   * Nunca roda num livro da Literária (o livro pago é todo traduzido pelo serviço
   * pago) nem com a tradução do livro em andamento.
   */
  async preview(bookId: string, providerId: string) {
    await this.init();
    if (this.previews.has(bookId)) return;
    // a vaga é reservada já (antes de qualquer espera): duas prévias do mesmo livro nunca rodam juntas
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((r) => (finish = r));
    this.previews.set(bookId, { controller, done });
    let launched = false;
    try {
      if (this.current?.bookId === bookId || this.queue.includes(bookId)) {
        throw new ProviderError("A tradução deste livro já começou.", { fatal: true, code: "other" });
      }
      const settings = await readSettings();
      const provider = this.providerFactory(providerId, settings);
      const meta = (await store.get(bookId))!;
      const cfg = providerConfigs(settings).find((p) => p.id === provider.id);
      // servidor próprio: a amostra é grátis e nunca chama um serviço pago sem pedido pago
      if (!PUBLIC_MODE && (provider.paid || cfg?.paid) && meta.order?.status !== "paid") {
        throw new ProviderError("A amostra grátis não usa serviços pagos.", { fatal: true, code: "other" });
      }
      // livro da Literária (ou com pedido dela): nada de texto de serviço gratuito dentro do livro pago
      if (!PUBLIC_MODE && paidLevel(meta)) {
        throw new ProviderError("A amostra grátis não está disponível depois de escolher a Literária.", { fatal: true, code: "other" });
      }
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

      const ledger = await RunLedger.open((await store.get(bookId))!, "preview", {
        id: provider.id,
        model: provider.model,
        billing: billingOf(provider.id, settings),
      });
      launched = true;
      void (async () => {
        let reason = "preview";
        try {
          await translateRange(meta, chapter, chapter.start, end, provider, {
            signal: controller.signal,
            engine: `${provider.id}/${provider.model}`,
            analysisLock: (fn) => fn(),
            onChapterSaved: async () => {},
            onUsage: async (usage, info) => {
              await store.update(
                bookId,
                (m) => {
                  m.usage.inputTokens += usage.inputTokens;
                  m.usage.outputTokens += usage.outputTokens;
                },
                { persist: false },
              );
              await ledger.usage(usage, info);
            },
            onLocal: (segments) => ledger.local(segments),
            onProgress: async (chapterId, delta) => {
              await ledger.progress(delta);
              await store.update(bookId, (m) => {
                const c = m.chapters.find((x) => x.id === chapterId)!;
                // o capítulo é de quem gravou o primeiro trecho dele
                if (delta.segments > 0 && !c.provider) {
                  c.provider = provider.id;
                  c.model = provider.model;
                }
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
          // a falha conta na saúde do serviço gratuito (vale para todos os livros)
          if (err instanceof ProviderError && cfg?.free && !controller.signal.aborted) await this.noteFailure(provider, err);
          const message = err instanceof ProviderError ? err.message : "Não foi possível fazer a prévia agora. Tente de novo.";
          if (!controller.signal.aborted) console.warn(`[runner] prévia do livro ${bookId} falhou`, err);
          await store.update(bookId, (m) => {
            if (m.preview) Object.assign(m.preview, { status: "error", error: message });
          });
        } finally {
          this.previews.delete(bookId);
          this.activities.delete(bookId);
          await ledger.close(reason).catch(() => {});
          finish();
        }
      })();
    } finally {
      // não chegou a começar (erro antes do pedido): libera a vaga
      if (!launched) {
        this.previews.delete(bookId);
        finish();
      }
    }
  }

  /** Para tudo antes de apagar um livro. */
  async stop(bookId: string) {
    clearTimeout(this.timers.get(bookId));
    this.timers.delete(bookId);
    clearTimeout(this.holds.get(bookId));
    this.holds.delete(bookId);
    this.previews.get(bookId)?.controller.abort(new Error("deleted"));
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
    // pulando os que estão sem cota ou com falhas — e de preferência quem começou o próximo
    // capítulo pela metade. Sem tipo: usa SEMPRE o provedor escolhido para o livro.
    const settings = await readSettings();
    const modality = meta.level ? modalityOf(meta.level) : undefined;
    let providerId: string;
    /** só este capítulo nesta execução: o serviço foi escolhido por ter começado o capítulo pela metade */
    let onlyChapter: string | undefined;
    if (meta.level) {
      const owner = await this.chapterOwner(bookId);
      const route = await routeProvider(meta.level, settings, this.excluded.get(bookId), owner?.provider);
      if (!route.ok) {
        await this.waitForService(bookId, route, modality, signal);
        return;
      }
      providerId = route.provider.id;
      // a mesma voz até o fim do capítulo começado — e só dele: depois, o rodízio escolhe de novo
      if (route.preferred) onlyChapter = owner?.chapterId;
    } else {
      providerId = meta.provider?.id ?? defaultProviderId(settings);
    }
    let provider: TranslationProvider;
    try {
      provider = this.providerFactory(providerId, settings);
    } catch (err) {
      // Grátis: um serviço que não abre (chave apagada, modelo encerrado) passa a vez para o próximo
      if (meta.level && modality === "free" && err instanceof ProviderError) {
        await this.rotateFree(bookId, meta.level, settings, { id: providerId, model: configModel(settings, providerId) }, err, signal);
        return;
      }
      await store.update(bookId, (m) => {
        m.status = "paused";
        m.phase = "Pausado";
        m.error = err instanceof Error ? err.message : String(err);
        m.stopCode = err instanceof ProviderError ? err.code : "other";
      });
      return;
    }

    // Grátis só com serviço gratuito, Literária só com pago — nunca misturados, nem por engano
    const cfg = providerConfigs(settings).find((p) => p.id === provider.id);
    const paidProvider = provider.paid || Boolean(cfg?.paid);
    if (modality && (modality === "free" ? paidProvider || !cfg?.free : !paidProvider)) {
      console.error(`[runner] ${bookId}: ${provider.id} não é da modalidade ${modality}; nada foi enviado`);
      await this.halt(
        bookId,
        "modality",
        `Erro interno: o serviço ${provider.id} não pode traduzir a tradução ${modality === "free" ? "grátis" : "paga"}. Nada foi enviado.`,
      );
      return;
    }
    // servidor próprio: um serviço pago só traduz um pedido pago (o preço cobre o custo)
    if (!PUBLIC_MODE && paidProvider && meta.order?.status !== "paid") {
      console.warn(`[runner] ${bookId}: ${provider.id} é pago e o livro não tem pedido pago; nada foi enviado`);
      await this.halt(bookId, "unpaid", "Esta tradução usaria um serviço pago, mas o livro não tem um pedido pago. Nada foi enviado.");
      return;
    }
    const free = Boolean(cfg?.free) && !paidProvider;

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
      // quem traduz: gravado em cada trecho (`by`), para o painel e os custos
      engine: `${provider.id}/${provider.model}`,
      analysisLock: <T>(fn: () => Promise<T>) => this.analysisMutex.run(`analysis:${bookId}`, fn),
      onUsage: async (usage: { inputTokens: number; outputTokens: number }, info?: { retry?: boolean; refused?: boolean }) => {
        // uma resposta voltou: o serviço está de pé (fecha o disjuntor dele)
        if (free) await recordSuccess(provider.id, provider.model).catch(() => {});
        // uma recusa sem tokens informados ainda gastou um pedido da cota
        if (!usage.inputTokens && !usage.outputTokens && !info?.refused) return;
        await store.update(
          bookId,
          (m) => {
            m.usage.inputTokens += usage.inputTokens;
            m.usage.outputTokens += usage.outputTokens;
          },
          { persist: false },
        );
        await ledger.usage(usage, info);
      },
      onLocal: (segments: number) => ledger.local(segments),
      beforeBatch: (words: number) => ledger.beforeBatch(words),
      onProgress: async (chapterId: string, delta: { words: number; segments: number; failed: number }) => {
        // a tradução andou: a próxima espera sem hora volta a ser curta
        if (delta.segments > 0) this.waits.delete(bookId);
        await store.update(bookId, (m) => {
          const c = m.chapters.find((x) => x.id === chapterId)!;
          // o capítulo é de quem gravou o primeiro trecho dele (a retomada prefere o mesmo serviço)
          if (delta.segments > 0 && !c.provider) {
            c.provider = provider.id;
            c.model = provider.model;
          }
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
          const todo = fresh.chapters.filter((c) => c.status !== "done" && (!onlyChapter || c.id === onlyChapter));
          if (!todo.length || inner.signal.aborted) break;

          // capítulos pequenos e consecutivos vão juntos no mesmo pedido (menos chamadas). A conta é a
          // mesma dos lotes (caracteres com a moldura de cada trecho e limite de trechos): um grupo
          // cabe num pedido só, sem sobrar um pedacinho para um pedido extra
          const limit = batchLimits(provider.limits);
          const groups: (typeof todo)[] = [];
          let group: typeof todo = [];
          let chars = 0;
          let segments = 0;
          for (const c of todo) {
            const load = await pendingLoad(bookId, c);
            if (group.length && (chars + load.chars > limit.chars || segments + load.segments > limit.segments || group.length >= 40)) {
              groups.push(group);
              group = [];
              chars = 0;
              segments = 0;
            }
            group.push(c);
            chars += load.chars;
            segments += load.segments;
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

      // o capítulo começado pela metade terminou com quem o começou: o resto do livro volta ao rodízio
      if (onlyChapter && (await store.get(bookId))!.chapters.some((c) => c.status !== "done")) {
        stopReason = "chapter";
        await this.requeue(bookId, signal);
        return;
      }

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
      const leveled = !signal.aborted ? (await store.get(bookId))?.level : undefined;
      // Grátis: nunca para com erro por causa de um serviço — passa para o próximo gratuito ou espera
      if (leveled && modalityOf(leveled) === "free") {
        await this.rotateFree(bookId, leveled, settings, provider, err, signal);
        return;
      }
      // Literária: se este serviço pago ficou sem cota (ou recusou a chave), segue com o próximo pago da lista
      if (leveled && err instanceof ProviderError && ["quota", "auth", "model"].includes(err.code)) {
        console.info(`[runner] ${bookId}: ${provider.id} indisponível (${err.code}); procurando outro serviço`);
        if (err.code !== "quota") this.excluded.set(bookId, new Set([...(this.excluded.get(bookId) ?? []), provider.id]));
        await recountProgress(bookId);
        if (signal.aborted) return this.settleAborted(bookId);
        const route = await routeProvider(leveled, settings, this.excluded.get(bookId));
        if (route.ok) await this.requeue(bookId, signal);
        else await this.waitForService(bookId, route, modalityOf(leveled), signal);
        return;
      }
      if (signal.aborted) {
        // pausa ou exclusão: pause()/stop() já ajustaram o estado
        await this.settleAborted(bookId);
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

  /**
   * Pausa ou exclusão no meio da execução: pause()/stop() já ajustaram o estado.
   * Só solta os capítulos que estavam em andamento (e nunca desfaz a pausa).
   */
  private async settleAborted(bookId: string) {
    if (!(await store.get(bookId))) return; // livro excluído
    await store.update(bookId, (m) => {
      m.activeChapterIds = [];
      for (const c of m.chapters) if (c.status === "translating" || c.status === "analyzing") c.status = "pending";
      // “continuar” tocado logo depois da pausa: fica na fila
      if (m.status !== "queued") {
        m.status = "paused";
        m.phase = "Pausado";
      }
    });
  }

  /** Volta para a fila logo em seguida (outro serviço continua do mesmo ponto). Uma pausa que chegou no meio vale. */
  private async requeue(bookId: string, signal?: AbortSignal) {
    if (signal?.aborted) return this.settleAborted(bookId);
    let applied = false;
    await store.update(bookId, (m) => {
      // conferido dentro da trava: uma pausa que chegou agora não é desfeita
      if (signal?.aborted) return;
      applied = true;
      m.status = "queued";
      m.phase = "Na fila";
      m.activeChapterIds = [];
      m.error = undefined;
      m.stopCode = undefined;
      for (const c of m.chapters) if (c.status === "translating" || c.status === "analyzing") c.status = "pending";
    });
    if (!applied || signal?.aborted) return this.settleAborted(bookId);
    this.restart.add(bookId);
  }

  /** Para sem chamar nada (motivo interno, para o painel). */
  private async halt(bookId: string, stopCode: string, message: string) {
    await store.update(bookId, (m) => {
      m.status = "paused";
      m.phase = "Pausado";
      m.error = message;
      m.stopCode = stopCode;
      m.activeChapterIds = [];
      for (const c of m.chapters) if (c.status === "translating" || c.status === "analyzing") c.status = "pending";
    });
  }

  /** O próximo capítulo começado pela metade e quem o começou (a retomada prefere o mesmo serviço, para manter a voz). */
  private async chapterOwner(bookId: string): Promise<{ chapterId: string; provider: string } | undefined> {
    const m = await store.get(bookId);
    const c = m?.chapters.find((x) => x.status !== "done" && x.translatedSegments > 0 && x.provider);
    return c ? { chapterId: c.id, provider: c.provider! } : undefined;
  }

  /**
   * Anota a falha de um serviço gratuito para todos os livros: cota esgotada até a
   * hora informada (no mínimo 1 minuto) ou falha no disjuntor (services/providers/health.ts:
   * 6 h só para falhas da conta; as outras, 1 minuto ou mais — nunca menos que o Retry-After).
   */
  private async noteFailure(provider: { id: string; model: string }, err: ProviderError) {
    try {
      if (err.code === "quota") {
        if (isFreeProvider(provider.id)) await recordExhausted(provider.id, provider.model, err.retryAt, { minMs: MIN_COOLDOWN_MS });
      } else {
        await recordFailure(provider.id, provider.model, { code: err.code, fatal: err.fatal, message: err.message, retryAt: err.retryAt });
      }
    } catch (e) {
      console.warn("[runner] não foi possível anotar a falha do serviço", e);
    }
  }

  /**
   * Grátis: um serviço falhou (cota, chave, modelo, servidor fora do ar, rede, limite
   * que não passou). Anota a falha (para todos os livros: quem falhou fica de fora
   * até a hora em que volta), passa para o próximo gratuito do mesmo ponto ou, sem
   * nenhum agora, espera e continua sozinha. Nunca fica em “erro” e nunca usa um
   * serviço pago. Trava: no máximo 2 trocas por serviço gratuito a cada start().
   * Uma pausa do cliente no meio do caminho (`signal`) sempre vale.
   */
  private async rotateFree(
    bookId: string,
    level: LevelId,
    settings: Settings,
    provider: { id: string; model: string },
    err: unknown,
    signal: AbortSignal,
  ) {
    if (err instanceof ProviderError) {
      console.info(`[runner] ${bookId}: ${provider.id} falhou (${err.code}); procurando outro serviço gratuito`);
      await this.noteFailure(provider, err);
    } else {
      console.error(`[runner] livro ${bookId} parou`, err);
    }
    if (signal.aborted) return this.settleAborted(bookId);
    await recountProgress(bookId);
    if (signal.aborted) return this.settleAborted(bookId);
    const switches = (this.switches.get(bookId) ?? 0) + 1;
    this.switches.set(bookId, switches);
    const limit = Math.max(1, freeProviderIds(settings).length) * 2;
    if (err instanceof ProviderError && switches <= limit) {
      const route = await routeProvider(level, settings);
      if (route.ok) await this.requeue(bookId, signal);
      else await this.waitForService(bookId, route, "free", signal);
      return;
    }
    // erro que não é de um serviço, ou trocas demais nesta rodada: espera e tenta de novo mais tarde
    if (switches > limit) console.warn(`[runner] ${bookId}: ${switches - 1} trocas de serviço seguidas; esperando antes de tentar de novo`);
    await this.waitForService(bookId, { ok: false, reason: "no_provider" }, "free", signal);
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
      // a resposta veio (e gastou tokens), mas não serviu (cortada, fora do formato): o gasto conta igual
      const spent = (err as { usage?: Usage } | null)?.usage;
      if (spent && (spent.inputTokens || spent.outputTokens)) {
        await store.update(
          bookId,
          (m) => {
            m.usage.inputTokens += spent.inputTokens;
            m.usage.outputTokens += spent.outputTokens;
          },
          { persist: false },
        );
        await ledger?.usage(spent, { retry: true });
      }
      // pedido recusado só desta vez (400, ex.: o modelo não conseguiu escrever o JSON): segue sem perfil,
      // como numa falha passageira. Falhas da conta, cota e afins param e o rodízio decide
      if (err instanceof ProviderError && err.fatal && err.code !== "bad_request") throw err;
      if (signal.aborted) throw err;
      if (!meta.analysisFailed) {
        // falha passageira: traduz sem perfil agora e tenta de novo na próxima execução (uma vez só)
        console.warn("[runner] análise do livro falhou; seguindo sem perfil, nova tentativa na próxima execução", err);
        await store.update(bookId, (m) => {
          m.analysisFailed = true;
        });
        return;
      }
      console.warn("[runner] análise do livro falhou de novo; seguindo sem perfil", err);
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
      delete m.analysisFailed;
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

/** Modelo configurado de um serviço (para anotar uma falha antes mesmo de criar o provedor). */
function configModel(settings: Settings, id: string): string {
  return providerConfigs(settings).find((p) => p.id === id)?.model ?? "";
}

/** Defeitos da conferência de qualidade que querem dizer “não foi traduzido” (os únicos que a revisão refaz). */
const UNTRANSLATED: readonly HardIssue[] = ["echo", "partial-echo", "wrong-language"];

/**
 * Trecho gravado que ficou sem traduzir: voltou igual ao original, boa parte voltou
 * sem traduzir ou ficou no idioma de origem (lib/quality.ts). Só esses defeitos:
 * outros avisos (tamanho, formatação…) nunca fazem a revisão refazer um trecho —
 * nem nos livros antigos, gravados antes da conferência.
 */
function looksUntranslated(src: string, out: string, ctx: { sourceLang: string | null; targetLang: string; languageChecks: boolean }): boolean {
  const hard = checkSegment(src, out, ctx).hard;
  return hard !== undefined && UNTRANSLATED.includes(hard);
}

/**
 * Revisão automática: libera para nova tradução os trechos que falharam e os
 * que ficaram sem traduzir. Trechos editados à mão nunca são tocados.
 * `languageChecks`: confere o idioma (o provedor de demonstração devolve o original de propósito).
 * Devolve quantos trechos serão refeitos.
 */
export async function markForReview(bookId: string, opts: { languageChecks?: boolean } = {}): Promise<number> {
  const meta = await store.get(bookId);
  if (!meta) return 0;
  const ctx = {
    sourceLang: meta.sourceLanguage ?? meta.detectedLanguage ?? null,
    targetLang: meta.targetLanguage,
    languageChecks: opts.languageChecks !== false,
  };
  let count = 0;
  for (const d of meta.docs) {
    const doc = await store.readDoc(bookId, d.id);
    const needs = (s: (typeof doc.segments)[number]) =>
      !s.edited && ((s.failed && s.out === undefined) || (s.out !== undefined && looksUntranslated(s.src, s.out, ctx)));
    if (!doc.segments.some(needs)) continue;
    await store.updateDoc(bookId, d.id, (content) => {
      for (const s of content.segments) {
        if (!needs(s)) continue;
        delete s.failed;
        delete s.out;
        delete s.by;
        delete s.warn;
        count++;
      }
    });
  }
  if (count) await recountProgress(bookId);
  return count;
}

/** O trecho foi traduzido por um serviço gratuito (ou pela demonstração)? `by` é “serviço/modelo”. */
export function byFreeEngine(by: string | undefined): boolean {
  return Boolean(by) && !isPaidProviderId(by!.split("/")[0]);
}

/** Trecho que a Literária traduz num pedido novo: sem tradução, ou com a de um serviço gratuito (e não editado à mão). */
function forPaidTranslation(s: Segment): boolean {
  return s.out === undefined || (!s.edited && byFreeEngine(s.by));
}

/**
 * Palavras que um pedido NOVO da Literária cobre (não a troca do “restante”, que
 * fica com o que a Grátis já fez): tudo o que não foi traduzido por um serviço pago
 * — inclusive o trecho da amostra grátis, que sai do livro quando o pedido é pago
 * (discardFreeText). Trechos editados à mão ficam e não entram.
 */
export async function wordsForPaidOrder(meta: BookMeta): Promise<number> {
  let words = 0;
  for (const c of meta.chapters) {
    const doc = await store.readDoc(meta.id, c.docId);
    for (const s of doc.segments.slice(c.start, c.end)) if (forPaidTranslation(s)) words += s.words;
  }
  return words;
}

/**
 * Pedido novo da Literária pago: o texto de serviços gratuitos (a amostra grátis)
 * sai do livro antes de começar — o livro pago é todo traduzido pelo serviço pago.
 * Trechos editados à mão ficam. Devolve quantos trechos saíram.
 */
export async function discardFreeText(bookId: string): Promise<number> {
  const meta = await store.get(bookId);
  if (!meta) return 0;
  let count = 0;
  const touched = new Set<string>();
  for (const d of meta.docs) {
    const doc = await store.readDoc(bookId, d.id);
    const free = (s: Segment) => s.out !== undefined && forPaidTranslation(s);
    if (!doc.segments.some(free)) continue;
    await store.updateDoc(bookId, d.id, (content) => {
      for (const s of content.segments) {
        if (!free(s)) continue;
        delete s.out;
        delete s.by;
        delete s.warn;
        delete s.failed;
        count++;
        for (const c of meta.chapters) if (c.docId === d.id && s.i >= c.start && s.i < c.end) touched.add(c.id);
      }
    });
  }
  await store.update(bookId, (m) => {
    // a amostra deixou de existir no livro
    delete m.preview;
    for (const c of m.chapters) {
      if (!touched.has(c.id)) continue;
      // o capítulo volta a ser de quem gravar o primeiro trecho dele (o serviço pago)
      if (c.provider && !isPaidProviderId(c.provider)) {
        delete c.provider;
        delete c.model;
      }
      if (c.status === "done") c.status = "pending";
    }
  });
  await recountProgress(bookId);
  return count;
}

/** Pedido Padrão confirmado no beta, de antes da Grátis (com preço): conta como a tradução grátis. */
export function isLegacyBetaFree(order: BookOrder): boolean {
  return order.level === "padrao" && order.status === "paid" && order.payment === "beta";
}

/** O livro é (ou vai ser, com um pedido feito) da Literária: nada de texto de serviço gratuito nele. */
function paidLevel(meta: BookMeta): boolean {
  if (meta.level && modalityOf(meta.level) === "paid") return true;
  const o = meta.order;
  return Boolean(o && o.status !== "canceled" && modalityOf(o.level) === "paid");
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
