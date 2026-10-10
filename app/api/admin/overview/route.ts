import { json, percentOf } from "@/lib/api";
import { store, readSettings } from "@/lib/storage";
import { providerConfigs } from "@/lib/config";
import { brlPerUsd } from "@/lib/billing/catalog";
import { billingMode } from "@/lib/billing/mode";
import { breakdown, OPERATIONS, SERVICE_LEVELS } from "@/lib/billing/pricing";
import { checkoutConfig } from "@/services/commerce/orders";
import { paymentSetup } from "@/services/billing/payments";
import { adminPasswordSource } from "@/services/admin/access";
import { netFactor } from "@/lib/billing/catalog";
import { routingFor } from "@/services/commerce/routing";
import { isFreeProvider, quotaFor } from "@/services/quota/usage";
import { jobRunner } from "@/services/processing/job-runner";

/** Painel administrativo: pedidos, custo real, margem, serviços e preços. */
export async function GET() {
  await jobRunner.init();
  const settings = await readSettings();
  const checkout = await checkoutConfig(settings);
  const books = await store.list();
  const fx = brlPerUsd();

  const rows = books.map((m) => {
    const costUsd = (m.runs ?? []).reduce((n, r) => n + (r.costUsd ?? 0), 0);
    // custo de verdade: só o que passou por serviço pago (os gratuitos não cobram)
    const realUsd = (m.runs ?? []).filter((r) => r.billing === "hosted").reduce((n, r) => n + (r.costUsd ?? 0), 0);
    const order = m.order ?? null;
    const paid = order?.status === "paid";
    const revenueBrl = paid ? order.priceBrl : 0;
    const tokens = (m.runs ?? []).reduce((n, r) => n + r.inputTokens + r.outputTokens, 0);
    // conta do pedido: estimado na hora do pedido x real (o que de fato custou)
    const estimate = order ? breakdown(order.words, order.level, order.priceBrl) : null;
    const netBrl = paid ? order.priceBrl * netFactor() : 0;
    const profitBrl = paid ? netBrl - realUsd * fx - OPERATIONS.fixedCostPerOrderBrl : 0;
    return {
      id: m.id,
      title: m.title,
      status: m.status,
      percent: percentOf(m),
      words: m.totals.words,
      level: m.level ?? null,
      order: order && {
        priceBrl: order.priceBrl,
        status: order.status,
        payment: order.payment,
        paymentProvider: order.paymentProvider ?? null,
        words: order.words,
        paidAt: order.paidAt ?? null,
      },
      provider: m.provider ?? null,
      runs: m.runs ?? [],
      costUsd,
      costBrl: costUsd * fx,
      realCostBrl: realUsd * fx,
      revenueBrl,
      tokens,
      estimatedCostBrl: estimate ? estimate.processingExpectedBrl : null,
      netBrl,
      profitBrl,
      margin: paid && order.priceBrl > 0 ? profitBrl / order.priceBrl : null,
      stopCode: m.stopCode ?? null,
      error: m.error ?? null,
      resumeAt: m.resumeAt ?? null,
      updatedAt: m.updatedAt,
    };
  });

  const paid = rows.filter((r) => r.order?.status === "paid");
  const configs = providerConfigs(settings);
  const routing = Object.fromEntries(
    await Promise.all(
      SERVICE_LEVELS.map(async (l) => [
        l.id,
        await Promise.all(
          routingFor(l.id, settings).map(async (id) => {
            const c = configs.find((x) => x.id === id);
            const q = c && c.available && isFreeProvider(id) ? await quotaFor(id, c.model) : null;
            return {
              id,
              label: c?.label ?? id,
              model: c?.model ?? "",
              available: Boolean(c?.available),
              paid: Boolean(c?.paid),
              exhaustedUntil: q?.exhaustedUntil ?? null,
            };
          }),
        ),
      ]),
    ),
  );

  return json({
    checkout: checkout.mode,
    checkoutFromEnv: checkout.fromEnv,
    payments: paymentSetup(checkout.provider),
    business: settings.business ?? {},
    billing: billingMode(),
    totals: {
      books: rows.length,
      orders: rows.filter((r) => r.order).length,
      paidBeta: paid.filter((r) => r.order?.payment === "beta").length,
      paidProvider: paid.filter((r) => r.order?.payment === "provider").length,
      // receita só de pagamentos reais; no beta, o “valor dos pedidos” mostra quanto teria entrado
      revenueBrl: paid.filter((r) => r.order?.payment === "provider").reduce((n, r) => n + r.revenueBrl, 0),
      betaValueBrl: paid.filter((r) => r.order?.payment === "beta").reduce((n, r) => n + r.revenueBrl, 0),
      costBrl: rows.reduce((n, r) => n + r.costBrl, 0),
      realCostBrl: rows.reduce((n, r) => n + r.realCostBrl, 0),
      profitBrl: paid.reduce((n, r) => n + r.profitBrl, 0),
      priceBrl: paid.reduce((n, r) => n + r.revenueBrl, 0),
    },
    books: rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    routing,
    allProviders: configs
      .filter((c) => c.billing !== "none")
      .map((c) => ({ id: c.id, label: c.label, model: c.model, available: c.available, paid: c.paid })),
    admin: { passwordSet: (await adminPasswordSource()) !== null, source: await adminPasswordSource() },
    offerLiteraria: Boolean(settings.offerLiteraria),
    pricing: {
      minimumBrl: OPERATIONS.minimumBrl,
      levels: SERVICE_LEVELS.map((l) => ({
        id: l.id,
        label: l.label,
        per1kBrl: l.per1kBrl,
        feeBrl: l.feeBrl,
        minWorstMargin: l.minWorstMargin,
        examples: [10_000, 44_152, 80_000, 150_000, 210_000, 300_000].map((w) => ({ words: w, ...breakdown(w, l.id) })),
      })),
    },
  });
}
