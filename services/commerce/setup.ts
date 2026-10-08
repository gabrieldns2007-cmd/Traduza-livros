/** Idiomas e preferências de tradução, aplicados antes da amostra, do pedido ou do início. */
import type { BookMeta } from "@/types/book";
import { store } from "@/lib/storage";
import { findLanguage } from "@/lib/languages";
import { recountProgress } from "@/services/processing/job-runner";

export interface SetupBody {
  targetLanguage?: string;
  sourceLanguage?: string | null;
  options?: { instructions?: string; dialogueStyle?: "target" | "source"; deepContext?: boolean };
}

/**
 * Aplica idiomas e opções. Se os idiomas mudarem depois de uma amostra, o
 * trecho da amostra é descartado (ele estava em outro idioma).
 */
export async function applySetup(meta: BookMeta, body: SetupBody) {
  const { targetLanguage, sourceLanguage, options } = body;
  const notStarted = meta.status === "ready";
  const nextTarget = notStarted && targetLanguage ? (findLanguage(targetLanguage)?.code ?? meta.targetLanguage) : meta.targetLanguage;
  const nextSource =
    notStarted && sourceLanguage !== undefined
      ? sourceLanguage && sourceLanguage !== "auto"
        ? (findLanguage(sourceLanguage)?.code ?? null)
        : null
      : meta.sourceLanguage;
  const languagesChanged = nextTarget !== meta.targetLanguage || nextSource !== meta.sourceLanguage;
  if (languagesChanged && meta.preview) {
    const p = meta.preview;
    await store.updateDoc(meta.id, p.docId, (content) => {
      for (const s of content.segments.slice(p.start, p.end)) if (!s.edited) delete s.out;
    });
  }
  await store.update(meta.id, (m) => {
    m.targetLanguage = nextTarget;
    m.sourceLanguage = nextSource;
    if (languagesChanged) delete m.preview;
    if (options) {
      m.options = {
        dialogueStyle: options.dialogueStyle ?? m.options.dialogueStyle,
        deepContext: options.deepContext ?? m.options.deepContext,
        instructions: options.instructions?.trim() || undefined,
      };
    }
  });
  if (languagesChanged && meta.preview) await recountProgress(meta.id);
}
