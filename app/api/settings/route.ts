import { z } from "zod";
import { fail, json } from "@/lib/api";
import { config, defaultProviderId, GEMINI_MODELS, geminiApiKey, providerConfigs } from "@/lib/config";
import { authEnabled } from "@/lib/auth";
import { readSettings, writeSettings } from "@/lib/storage";
import { findLanguage } from "@/lib/languages";

async function payload() {
  const settings = await readSettings();
  const key = geminiApiKey(settings);
  // a chave nunca volta para o navegador: só os 4 últimos caracteres
  const { geminiApiKey: _secret, ...publicSettings } = settings;
  void _secret;
  return {
    settings: publicSettings,
    gemini: {
      hasKey: Boolean(key),
      keyHint: key ? `••••${key.slice(-4)}` : "",
      fromEnv: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
      models: GEMINI_MODELS,
    },
    providers: providerConfigs(settings).map(({ id, label, available, model, hint, paid }) => ({
      id,
      label,
      available,
      paid,
      model: available ? model : "",
      hint,
    })),
    defaultProvider: defaultProviderId(settings),
    dataDir: config.dataDir,
    authEnabled: authEnabled(),
    maxUploadMb: Math.round(config.maxUploadBytes / 1024 / 1024),
  };
}

export async function GET() {
  return json(await payload());
}

const Body = z.object({
  providerId: z.enum(["gemini", "anthropic", "openai", "demo"]).optional(),
  targetLanguage: z.string().max(20).optional(),
  dialogueStyle: z.enum(["target", "source"]).optional(),
  deepContext: z.boolean().optional(),
  instructions: z.string().max(4000).optional(),
  /** string vazia remove a chave salva */
  geminiApiKey: z.string().max(200).optional(),
  geminiModel: z.string().max(60).optional(),
});

export async function PUT(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("Configurações inválidas.");
  const current = await readSettings();
  const b = parsed.data;
  const next = {
    ...current,
    ...b,
    targetLanguage: b.targetLanguage ? (findLanguage(b.targetLanguage)?.code ?? current.targetLanguage) : current.targetLanguage,
    instructions: b.instructions?.trim() ?? current.instructions,
    geminiApiKey: b.geminiApiKey === undefined ? current.geminiApiKey : b.geminiApiKey.trim() || undefined,
    geminiModel: b.geminiModel && GEMINI_MODELS.some((m) => m.id === b.geminiModel) ? b.geminiModel : current.geminiModel,
  };
  await writeSettings(next);
  return json(await payload());
}

/** Testa a chave do Gemini sem gastar cota (só lista os modelos). */
export async function POST() {
  const key = geminiApiKey(await readSettings());
  if (!key) return fail("Nenhuma chave do Gemini salva.");
  try {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": key } });
    if (!res.ok)
      return json({
        ok: false,
        message: res.status === 400 || res.status === 403 ? "A chave foi recusada pelo Google." : `O Google respondeu ${res.status}.`,
      });
    const data = (await res.json()) as { models?: { name: string }[] };
    const names = new Set((data.models ?? []).map((m) => m.name.replace(/^models\//, "")));
    return json({ ok: true, models: GEMINI_MODELS.map((m) => ({ id: m.id, available: names.has(m.id) })) });
  } catch {
    return json({ ok: false, message: "Não foi possível falar com o Google agora." });
  }
}
