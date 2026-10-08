import { fail, json, loadBook } from "@/lib/api";
import { readSettings } from "@/lib/storage";
import { defaultProviderId, providerConfigs } from "@/lib/config";
import { estimateCost } from "@/lib/cost";

/** Provedores disponíveis para este livro, com estimativa de custo dos pagos. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const meta = await loadBook((await params).id);
  if (!meta) return fail("Livro não encontrado.", 404);
  const settings = await readSettings();
  const remaining = Math.max(0, meta.totals.words - meta.progress.translatedWords);
  return json({
    defaultId: defaultProviderId(settings),
    remainingWords: remaining,
    providers: providerConfigs(settings)
      .filter((p) => p.available || p.id === "gemini" || p.id === "anthropic")
      .map((p) => ({
        id: p.id,
        label: p.label,
        model: p.model,
        available: p.available,
        paid: p.paid,
        hint: p.available ? undefined : p.hint,
        estimate: p.paid ? estimateCost(p.model, remaining, meta.options.deepContext) : null,
      })),
  });
}
