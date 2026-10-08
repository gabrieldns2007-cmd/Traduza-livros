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
  action: z.enum(["start", "pause", "resume", "retry-failed"]),
  /** provedor escolhido pelo usuário (padrão: o gratuito) */
  providerId: z.enum(["gemini", "anthropic", "openai", "demo"]).optional(),
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

export async function POST(request: Request, { params }: Ctx) {
  const id = (await params).id;
  const meta = await loadBook(id);
  if (!meta) return fail("Livro não encontrado.", 404);
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("Pedido inválido.");
  const { action } = parsed.data;

  if (action === "pause") {
    await jobRunner.pause(id);
  } else if (action === "start") {
    if (meta.status !== "ready" && meta.status !== "error" && meta.status !== "paused") return fail("Este livro já está sendo traduzido.", 409);
    const { targetLanguage, sourceLanguage, options } = parsed.data;
    const untouched = meta.progress.translatedSegments === 0;
    const chosen = await chooseProvider(meta, parsed.data.providerId, parsed.data.confirmCost);
    if (chosen.error) return chosen.error;
    await store.update(id, (m) => {
      m.provider = { id: chosen.cfg.id, model: chosen.cfg.model };
      if (untouched && targetLanguage) m.targetLanguage = findLanguage(targetLanguage)?.code ?? m.targetLanguage;
      if (untouched && sourceLanguage !== undefined) {
        m.sourceLanguage = sourceLanguage && sourceLanguage !== "auto" ? (findLanguage(sourceLanguage)?.code ?? null) : null;
      }
      if (options) {
        m.options = {
          dialogueStyle: options.dialogueStyle ?? m.options.dialogueStyle,
          deepContext: options.deepContext ?? m.options.deepContext,
          instructions: options.instructions?.trim() || undefined,
        };
      }
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
