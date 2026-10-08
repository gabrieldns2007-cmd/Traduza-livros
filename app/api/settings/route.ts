import { z } from "zod";
import { fail, json } from "@/lib/api";
import { config, providerConfigs } from "@/lib/config";
import { authEnabled } from "@/lib/auth";
import { readSettings, writeSettings } from "@/lib/storage";
import { findLanguage } from "@/lib/languages";
import { getTranslationProvider } from "@/services/translation";

async function payload() {
  const settings = await readSettings();
  const active = getTranslationProvider(settings.providerId);
  return {
    settings,
    providers: providerConfigs().map(({ id, label, available, model, hint }) => ({ id, label, available, model: available ? model : "", hint })),
    activeProvider: { id: active.id, model: active.model },
    dataDir: config.dataDir,
    authEnabled: authEnabled(),
    maxUploadMb: Math.round(config.maxUploadBytes / 1024 / 1024),
  };
}

export async function GET() {
  return json(await payload());
}

const Body = z.object({
  providerId: z.enum(["anthropic", "openai", "demo"]).optional(),
  targetLanguage: z.string().max(20).optional(),
  dialogueStyle: z.enum(["target", "source"]).optional(),
  deepContext: z.boolean().optional(),
  instructions: z.string().max(4000).optional(),
});

export async function PUT(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("Configurações inválidas.");
  const current = await readSettings();
  const b = parsed.data;
  await writeSettings({
    ...current,
    ...b,
    targetLanguage: b.targetLanguage ? (findLanguage(b.targetLanguage)?.code ?? current.targetLanguage) : current.targetLanguage,
    instructions: b.instructions?.trim() ?? current.instructions,
  });
  return json(await payload());
}
