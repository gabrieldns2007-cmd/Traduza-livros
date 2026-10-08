import type { BookActivity, BookMeta, BookSummary } from "@/types/book";
import { store, isValidBookId } from "@/lib/storage";
import { jobRunner } from "@/services/processing/job-runner";
import { PUBLIC_MODE } from "@/lib/mode";

export function json(data: unknown, status = 200) {
  // Response.json (padrão da web): o mesmo código responde no servidor e no navegador
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

export function fail(message: string, status = 400) {
  return json({ error: message }, status);
}

export async function loadBook(id: string): Promise<BookMeta | null> {
  if (!isValidBookId(id)) return null;
  await jobRunner.init();
  return store.get(id);
}

export function percentOf(meta: BookMeta): number {
  if (meta.status === "done") return 100;
  if (!meta.totals.words) return 0;
  return Math.min(99.9, (meta.progress.translatedWords / meta.totals.words) * 100);
}

/** Estimativa de tempo restante (segundos), a partir do ritmo medido. */
export function etaSeconds(meta: BookMeta): number | null {
  const { measuredWords, activeMs, translatedWords } = meta.progress;
  if (measuredWords < 150 || activeMs < 5000) return null;
  const remaining = Math.max(0, meta.totals.words - translatedWords);
  return Math.round((remaining * activeMs) / measuredWords / 1000);
}

export type BookView = BookMeta & {
  percent: number;
  eta: number | null;
  queuePosition: number;
  isDemo: boolean;
  /** capítulos concluídos e de onde a tradução continua (índice 0-based, -1 se terminou) */
  doneChapters: number;
  resumeIndex: number;
  /** o que está acontecendo agora (pedido em andamento, espera de limite) */
  activity: BookActivity | null;
};

export function viewOf(meta: BookMeta): BookView {
  return {
    ...(PUBLIC_MODE ? meta : forCustomer(meta)),
    percent: percentOf(meta),
    eta: etaSeconds(meta),
    queuePosition: jobRunner.queuePosition(meta.id),
    isDemo: meta.provider?.id === "demo",
    doneChapters: meta.chapters.filter((c) => c.status === "done").length,
    resumeIndex: meta.chapters.findIndex((c) => c.status !== "done"),
    activity: jobRunner.activity(meta.id),
  };
}

/**
 * O cliente compra uma tradução, não um serviço de IA: no servidor, a resposta da
 * API não leva qual serviço/modelo traduziu, tokens, custos nem mensagens de erro
 * técnicas (isso fica no painel administrativo). Na versão pública a pessoa usa a
 * própria chave e escolhe o serviço, então vê tudo.
 */
function forCustomer(meta: BookMeta): BookMeta {
  const { runs: _runs, error: _error, ...rest } = meta;
  return {
    ...rest,
    provider: meta.provider?.id === "demo" ? meta.provider : undefined,
    usage: { inputTokens: 0, outputTokens: 0 },
    chapters: meta.chapters.map(({ provider: _p, model: _m, ...c }) => c),
    preview: meta.preview && { ...meta.preview, provider: { id: "", model: "" }, error: undefined },
  };
}

export function summaryOf(meta: BookMeta): BookSummary {
  return {
    id: meta.id,
    title: meta.title,
    translatedTitle: meta.translatedTitle,
    author: meta.author,
    sourceLanguage: meta.sourceLanguage,
    detectedLanguage: meta.detectedLanguage,
    targetLanguage: meta.targetLanguage,
    status: meta.status,
    percent: percentOf(meta),
    chapters: meta.totals.chapters,
    words: meta.totals.words,
    originalFormat: meta.originalFormat,
    hasCover: Boolean(meta.cover),
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
}
