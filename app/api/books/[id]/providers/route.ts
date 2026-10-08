import { fail, json, loadBook } from "@/lib/api";
import { readSettings } from "@/lib/storage";
import { defaultProviderId, providerConfigs } from "@/lib/config";
import { estimateCost } from "@/lib/cost";
import { isFreeProvider, quotaFor } from "@/services/quota/usage";

/**
 * Serviços disponíveis para este livro: os gratuitos com os “créditos grátis
 * de hoje” e os pagos (se configurados) com a estimativa de custo.
 * O sugerido é sempre gratuito — de preferência um que ainda tenha cota.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const meta = await loadBook((await params).id);
  if (!meta) return fail("Livro não encontrado.", 404);
  const settings = await readSettings();
  const remaining = Math.max(0, meta.totals.words - meta.progress.translatedWords);
  const providers = await Promise.all(
    providerConfigs(settings)
      .filter((p) => p.available || isFreeProvider(p.id))
      .map(async (p) => ({
        id: p.id,
        label: p.label,
        model: p.model,
        available: p.available,
        paid: p.paid,
        hint: p.available ? undefined : p.hint,
        estimate: p.paid ? estimateCost(p.model, remaining, meta.options.deepContext) : null,
        quota: p.available && isFreeProvider(p.id) ? await quotaFor(p.id, p.model) : null,
      })),
  );
  const usable = (id?: string) => providers.find((p) => p.id === id && p.available && isFreeProvider(p.id) && !p.quota?.exhaustedUntil);
  const firstWithQuota = providers.find((p) => p.available && !p.paid && isFreeProvider(p.id) && !p.quota?.exhaustedUntil);
  return json({
    defaultId: usable(meta.provider?.id)?.id ?? firstWithQuota?.id ?? defaultProviderId(settings),
    remainingWords: remaining,
    providers,
  });
}
