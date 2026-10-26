import { json, percentOf } from "@/lib/api";
import { store, readSettings } from "@/lib/storage";
import { providerConfigs } from "@/lib/config";
import { brlPerUsd } from "@/lib/billing/catalog";
import { billingMode } from "@/lib/billing/mode";
import { breakdown, isFreeLevel, OPERATIONS, SERVICE_LEVELS } from "@/lib/billing/pricing";
import { checkoutConfig } from "@/services/commerce/orders";
import { paymentSetup } from "@/services/billing/payments";
import { adminPasswordSource } from "@/services/admin/access";
import { authEnabled } from "@/lib/auth";
import { netFactor } from "@/lib/billing/catalog";
import { levelOffered, routingFor } from "@/services/commerce/routing";
import { isFreeProvider, quotaFor } from "@/services/quota/usage";
import { snapshot as healthSnapshot } from "@/services/providers/health";
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
    // a Grátis nunca é receita — nem um pedido Padrão antigo confirmado no beta com preço (nunca foi cobrado)
    const freeOrder = Boolean(order && isFreeLevel(order.level) && order.payment !== "provider");
    const revenueBrl = paid && !freeOrder ? order.priceBrl : 0;
    const tokens = (m.runs ?? []).reduce((n, r) => n + r.inputTokens + r.outputTokens, 0);
    // conta do pedido: estimado na hora do pedido x real (o que de fato custou)
    const estimate = order ? breakdown(order.words, order.level, order.priceBrl) : null;
    // a Grátis (R$ 0) não tem receita nem tarifa de pagamento: fica fora do lucro e da margem
    const charged = paid && !freeOrder && order.priceBrl > 0;
    const netBrl = charged ? order.priceBrl * netFactor() : 0;
    const profitBrl = charged ? netBrl - realUsd * fx - OPERATIONS.fixedCostPerOrderBrl : 0;
    return {
      id: m.id,
      title: m.title,
      status: m.status,
      percent: percentOf(m),
      words: m.totals.words,
      level: m.level ?? null,
      order: order && {
        level: order.level,
        priceBrl: order.priceBrl,
        status: order.status,
        payment: order.payment,
        paymentProvider: order.paymentProvider ?? null,
        words: order.words,
        paidAt: order.paidAt ?? null,
        // troca da Grátis para a Literária (pedido grátis substituído)
        replaces: order.replaces ?? null,
        // troca sem pagamento: a Grátis volta a seguir sozinha nesta hora
        expiresAt: order.expiresAt ?? null,
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
      margin: charged ? profitBrl / order.priceBrl : null,
      // pagamentos que chegaram mas não valem como venda: o dono devolve o dinheiro
      toRefund: m.paymentsToRefund ?? [],
      stopCode: m.stopCode ?? null,
      error: m.error ?? null,
      resumeAt: m.resumeAt ?? null,
      updatedAt: m.updatedAt,
    };
  });

  const paid = rows.filter((r) => r.order?.status === "paid");
  const configs = providerConfigs(settings);
  // serviços: cota, saúde (disjuntor: falhas recentes e quando volta) e o que fazem com o texto
  const health = await healthSnapshot().catch(() => []);
  const routing = Object.fromEntries(
    await Promise.all(
      SERVICE_LEVELS.map(async (l) => [
        l.id,
        await Promise.all(
          routingFor(l.id, settings).map(async (id) => {
            const c = configs.find((x) => x.id === id);
            const q = c && c.available && isFreeProvider(id) ? await quotaFor(id, c.model) : null;
            const h = c ? health.find((x) => x.provider === id && x.model === c.model) : undefined;
            return {
              id,
              label: c?.label ?? id,
              model: c?.model ?? "",
              available: Boolean(c?.available),
              paid: Boolean(c?.paid),
              free: Boolean(c?.free),
              retired: Boolean(c?.retired),
              exhaustedUntil: q?.exhaustedUntil ?? null,
              health: h ? { state: h.state, blockedUntil: h.blockedUntil, kind: h.kind, lastError: h.lastError } : null,
              dataPolicy: c?.dataPolicy ?? null,
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
    // anúncios (painel → Anúncios); com a senha do site (APP_PASSWORD), o Google não vê as páginas
    ads: settings.ads ?? {},
    siteLocked: authEnabled(),
    // Tradução Grátis sem nenhum serviço gratuito que funcione: os clientes veem “Em breve”
    padraoOffered: levelOffered("padrao", settings),
    billing: billingMode(),
    totals: {
      books: rows.length,
      orders: rows.filter((r) => r.order).length,
      paidBeta: paid.filter((r) => r.order?.payment === "beta" && r.order.level !== "padrao").length,
      paidProvider: paid.filter((r) => r.order?.payment === "provider").length,
      // traduções grátis confirmadas (R$ 0, sem pagamento)
      paidFree: paid.filter((r) => r.order?.payment === "free" || (r.order?.level === "padrao" && r.order.payment === "beta")).length,
      // pagamentos recebidos para reembolsar (nunca entram na receita)
      toRefund: rows.reduce((n, r) => n + r.toRefund.length, 0),
      toRefundBrl: rows.reduce((n, r) => n + r.toRefund.reduce((x, p) => x + (p.amountBrl ?? 0), 0), 0),
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
      .filter((c) => c.billing !== "none" && !c.retired)
      .map((c) => ({
        id: c.id,
        label: c.label,
        model: c.model,
        available: c.available,
        paid: c.paid,
        free: c.free,
        dataPolicy: c.dataPolicy ?? null,
      })),
    health,
    admin: { passwordSet: (await adminPasswordSource()) !== null, source: await adminPasswordSource() },
    offerLiteraria: Boolean(settings.offerLiteraria),
    pricing: {
      minimumBrl: OPERATIONS.minimumBrl,
      levels: SERVICE_LEVELS.map((l) => ({
        id: l.id,
        label: l.label,
        // Grátis: R$ 0 em qualquer tamanho e custo de IA zero (só serviços gratuitos) — sem tabela de margem
        free: Boolean(l.free),
        per1kBrl: l.per1kBrl,
        feeBrl: l.feeBrl,
        minWorstMargin: l.minWorstMargin,
        examples: l.free ? [] : [10_000, 44_152, 80_000, 150_000, 210_000, 300_000].map((w) => ({ words: w, ...breakdown(w, l.id) })),
      })),
    },
  });
}
