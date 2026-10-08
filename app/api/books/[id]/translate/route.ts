import { z } from "zod";
import { fail, json, loadBook, viewOf } from "@/lib/api";
import { readSettings, store } from "@/lib/storage";
import { defaultProviderId, providerConfigs } from "@/lib/config";
import { estimateCost } from "@/lib/cost";
import type { BookMeta } from "@/types/book";
import { findLanguage } from "@/lib/languages";
import { jobRunner, recountProgress } from "@/services/processing/job-runner";

type Ctx = { params: Promise<{ id: string }> };

const Body = z.object({
  action: z.enum(["preview", "start", "pause", "resume", "retry-failed"]),
  /** provedor escolhido pelo usuário (padrão: o gratuito) */
  providerId: z.enum(["gemini", "github", "groq", "anthropic", "openai", "demo"]).optional(),
  /** confirmação explícita de que a tradução pode gerar custos */
  confirmCost: z.boolean().optional(),
  targetLanguage: z.string().max(20).optional(),
  sourceLanguage: z.string().max(20).nullable().optional(),
  options: z
    .object({
      instructions: z.string().max(4000).optional(),
      dialogueStyle: z.enum(["target", "source"]).optional(),
      deepContext: z.boolean().optional(),
    })
    .optional(),
});

/**
 * Decide o provedor desta execução. Provedor pago só com confirmação explícita;
 * nunca há troca automática de provedor.
 */
async function chooseProvider(meta: BookMeta, providerId: string | undefined, confirmCost: boolean | undefined) {
  const settings = await readSettings();
  const id = providerId ?? meta.provider?.id ?? defaultProviderId(settings);
  const cfg = providerConfigs(settings).find((p) => p.id === id);
  if (!cfg) return { error: fail("Provedor desconhecido.") };
  if (!cfg.available) return { error: fail(`${cfg.label} não está configurado. ${cfg.hint ?? ""}`.trim(), 400) };
  if (cfg.paid && !confirmCost) {
    const remaining = Math.max(0, meta.totals.words - meta.progress.translatedWords);
    return {
      error: json(
        {
          error: "Esta tradução pode gerar custos.",
          requiresConfirmation: true,
          provider: { id: cfg.id, label: cfg.label, model: cfg.model },
          estimate: estimateCost(cfg.model, remaining, meta.options.deepContext),
        },
        402,
      ),
    };
  }
  return { cfg };
}

type SetupBody = Pick<z.infer<typeof Body>, "targetLanguage" | "sourceLanguage" | "options">;

/**
 * Aplica idiomas e opções antes da prévia ou do início. Se os idiomas mudarem
 * depois de uma prévia, o trecho da prévia é descartado (ele estava em outro idioma).
 */
async function applySetup(meta: BookMeta, body: SetupBody) {
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

export async function POST(request: Request, { params }: Ctx) {
  const id = (await params).id;
  const meta = await loadBook(id);
  if (!meta) return fail("Livro não encontrado.", 404);
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("Pedido inválido.");
  const { action } = parsed.data;

  if (action !== "pause" && jobRunner.isPreviewing(id)) return fail("Aguarde a prévia terminar.", 409);

  if (action === "pause") {
    await jobRunner.pause(id);
  } else if (action === "preview") {
    if (meta.status !== "ready") return fail("A prévia é feita antes de começar a tradução.", 409);
    const chosen = await chooseProvider(meta, parsed.data.providerId, parsed.data.confirmCost);
    if (chosen.error) return chosen.error;
    // refazer a prévia: descarta o trecho anterior (as edições à mão ficam)
    const old = meta.preview;
    if (old) {
      await store.updateDoc(id, old.docId, (content) => {
        for (const s of content.segments.slice(old.start, old.end)) if (!s.edited) delete s.out;
      });
      await store.update(id, (m) => {
        delete m.preview;
      });
      await recountProgress(id);
    }
    await applySetup((await store.get(id))!, parsed.data);
    try {
      await jobRunner.preview(id, chosen.cfg.id);
    } catch (err) {
      return fail(err instanceof Error ? err.message : "Não foi possível fazer a prévia.", 400);
    }
  } else if (action === "start") {
    if (meta.status !== "ready" && meta.status !== "error" && meta.status !== "paused") return fail("Este livro já está sendo traduzido.", 409);
    const chosen = await chooseProvider(meta, parsed.data.providerId, parsed.data.confirmCost);
    if (chosen.error) return chosen.error;
    await applySetup(meta, parsed.data);
    await store.update(id, (m) => {
      m.provider = { id: chosen.cfg.id, model: chosen.cfg.model };
    });
    await jobRunner.start(id);
  } else if (action === "resume") {
    if (meta.status === "done") return fail("Este livro já foi traduzido.", 409);
    const chosen = await chooseProvider(meta, parsed.data.providerId, parsed.data.confirmCost);
    if (chosen.error) return chosen.error;
    await store.update(id, (m) => {
      m.provider = { id: chosen.cfg.id, model: chosen.cfg.model };
    });
    await jobRunner.start(id);
  } else if (action === "retry-failed") {
    const chosen = await chooseProvider(meta, parsed.data.providerId, parsed.data.confirmCost);
    if (chosen.error) return chosen.error;
    await store.update(id, (m) => {
      m.provider = { id: chosen.cfg.id, model: chosen.cfg.model };
    });
    // libera os trechos que falharam e volta a traduzir só eles
    const affected = new Set<string>();
    for (const c of meta.chapters) if (c.failedSegments > 0) affected.add(c.docId);
    for (const docId of affected) {
      await store.updateDoc(id, docId, (content) => {
        for (const s of content.segments) if (s.failed) delete s.failed;
      });
    }
    await store.update(id, (m) => {
      for (const c of m.chapters) if (c.failedSegments > 0) c.status = "pending";
      m.status = "paused";
    });
    await recountProgress(id);
    await jobRunner.start(id);
  }
  return json({ book: viewOf((await store.get(id))!) });
}
