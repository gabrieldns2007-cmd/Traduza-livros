import { z } from "zod";
import { fail, json, loadBook, viewOf } from "@/lib/api";
import { readSettings, store } from "@/lib/storage";
import { defaultProviderId, providerConfigs } from "@/lib/config";
import { estimateCost } from "@/lib/cost";
import type { BookMeta } from "@/types/book";
import { findLanguage } from "@/lib/languages";
import { jobRunner, recountProgress } from "@/services/processing/job-runner";
import { applySetup } from "@/services/commerce/setup";
import { routeProvider } from "@/services/commerce/routing";
import { checkoutMode } from "@/services/commerce/orders";
import { PUBLIC_MODE } from "@/lib/mode";
import { billingMode } from "@/lib/billing/mode";
import { milliFor, quoteWords } from "@/lib/billing/quote";
import { CREDIT, PLANS, planById, qualityOfModel } from "@/lib/billing/catalog";
import { availableMilli, wallet, WalletError } from "@/services/billing/wallet";

type Ctx = { params: Promise<{ id: string }> };

const Body = z.object({
  action: z.enum(["preview", "start", "pause", "resume", "retry-failed"]),
  /** provedor escolhido pelo usuário (padrão: o gratuito) */
  providerId: z.enum(["gemini", "github", "groq", "anthropic", "openai", "demo"]).optional(),
  /** confirmação explícita de que a tradução pode gerar custos */
  confirmCost: z.boolean().optional(),
  /** créditos insuficientes: traduzir só o que o saldo cobre */
  partial: z.boolean().optional(),
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

/**
 * Créditos (só com BILLING_MODE=enforce e serviço “hosted”): sem saldo para o
 * que falta traduzir, responde 402 com quantos créditos são necessários —
 * a menos que a pessoa tenha escolhido traduzir só o que o saldo cobre.
 */
async function checkCredits(meta: BookMeta, cfg: { id: string; model: string; billing: "byok" | "hosted" | "none" }, partial?: boolean) {
  if (billingMode() !== "enforce" || cfg.billing !== "hosted") return null;
  const remaining = Math.max(0, meta.totals.words - meta.progress.translatedWords);
  const quote = quoteWords(cfg, remaining, meta.options.deepContext);
  const available = availableMilli(await wallet.read());
  if (available >= quote.milli) return null;
  if (partial && available >= milliFor(50, quote.quality.per1k)) return null;
  return json(
    {
      error: `Você precisa de ${quote.credits} créditos para traduzir este livro.`,
      requiresCredits: true,
      needed: quote.credits,
      available: Math.floor(available / CREDIT.milli),
      coverWords: Math.floor((available / CREDIT.milli) * (CREDIT.wordsPerCredit / quote.quality.per1k)),
    },
    402,
  );
}

/** Cada plano libera certas qualidades (modelos mais caros só nos planos pagos). */
async function checkPlanQuality(cfg: { model: string; billing: "byok" | "hosted" | "none" }) {
  if (billingMode() !== "enforce" || cfg.billing !== "hosted") return null;
  const plan = planById((await wallet.read()).plan);
  const quality = qualityOfModel(cfg.model);
  if (plan.qualities.includes(quality.id)) return null;
  const needed = PLANS.find((p) => p.qualities.includes(quality.id));
  return fail(`A qualidade ${quality.label} está disponível no plano ${needed?.name ?? "Pro"}.`, 403);
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
  } else if (action === "preview" && !parsed.data.providerId && !PUBLIC_MODE) {
    // cliente: a amostra grátis usa a tradução Padrão, com o serviço escolhido por dentro
    if (meta.status !== "ready") return fail("A amostra é feita antes de começar a tradução.", 409);
    const route = await routeProvider("padrao", await readSettings());
    if (!route.ok) return fail("A amostra grátis não está disponível agora. Tente de novo mais tarde.", 503);
    await applySetup(meta, parsed.data);
    try {
      await jobRunner.preview(id, route.provider.id);
    } catch {
      return fail("Não foi possível fazer a amostra agora. Tente de novo.", 400);
    }
  } else if (action === "resume" && !parsed.data.providerId && !PUBLIC_MODE) {
    // cliente: continua com o tipo de tradução do livro (ou Padrão); o serviço é escolhido por dentro
    if (meta.status === "done") return fail("Este livro já foi traduzido.", 409);
    if (checkoutMode() === "live" && meta.order?.status !== "paid") return fail("Confirme o pedido para continuar a tradução.", 402);
    await store.update(id, (m) => {
      m.level ??= "padrao";
    });
    await jobRunner.start(id);
  } else if (action === "preview") {
    if (meta.status !== "ready") return fail("A prévia é feita antes de começar a tradução.", 409);
    const chosen = await chooseProvider(meta, parsed.data.providerId, parsed.data.confirmCost);
    if (chosen.error) return chosen.error;
    const notInPlan = await checkPlanQuality(chosen.cfg);
    if (notInPlan) return notInPlan;
    // prévia é grátis para a pessoa, mas tem custo quando usa a chave do Verso: limite diário por plano
    if (billingMode() === "enforce" && chosen.cfg.billing === "hosted") {
      try {
        await wallet.notePreview();
      } catch (err) {
        if (err instanceof WalletError) return fail(err.message, 429);
        throw err;
      }
    }
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
    const notInPlan = await checkPlanQuality(chosen.cfg);
    if (notInPlan) return notInPlan;
    const noCredits = await checkCredits(meta, chosen.cfg, parsed.data.partial);
    if (noCredits) return noCredits;
    await applySetup(meta, parsed.data);
    await store.update(id, (m) => {
      m.provider = { id: chosen.cfg.id, model: chosen.cfg.model };
    });
    await jobRunner.start(id, { partial: parsed.data.partial });
  } else if (action === "resume") {
    if (meta.status === "done") return fail("Este livro já foi traduzido.", 409);
    const chosen = await chooseProvider(meta, parsed.data.providerId, parsed.data.confirmCost);
    if (chosen.error) return chosen.error;
    const notInPlan = await checkPlanQuality(chosen.cfg);
    if (notInPlan) return notInPlan;
    const noCredits = await checkCredits(meta, chosen.cfg, parsed.data.partial);
    if (noCredits) return noCredits;
    await store.update(id, (m) => {
      m.provider = { id: chosen.cfg.id, model: chosen.cfg.model };
    });
    await jobRunner.start(id, { partial: parsed.data.partial });
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
