import { z } from "zod";
import { fail, json } from "@/lib/api";
import {
  config,
  defaultProviderId,
  FREE_KEY_FIELDS,
  FREE_MODEL_FIELDS,
  FREE_MODELS,
  FREE_PROVIDERS,
  geminiApiKey,
  githubToken,
  groqApiKey,
  providerConfigs,
  type FreeProviderId,
} from "@/lib/config";
import { authEnabled } from "@/lib/auth";
import { readSettings, writeSettings, type Settings } from "@/lib/storage";
import { findLanguage } from "@/lib/languages";
import { quotaFor } from "@/services/quota/usage";

const ENV_KEYS: Record<FreeProviderId, string[]> = {
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  github: ["GITHUB_MODELS_TOKEN"],
  groq: ["GROQ_API_KEY"],
};

function keyOf(id: FreeProviderId, s: Settings) {
  return id === "gemini" ? geminiApiKey(s) : id === "github" ? githubToken(s) : groqApiKey(s);
}

async function payload() {
  const settings = await readSettings();
  const configs = providerConfigs(settings);
  // as chaves nunca voltam para o navegador: só os 4 últimos caracteres
  const publicSettings: Partial<Settings> = { ...settings };
  for (const field of Object.values(FREE_KEY_FIELDS)) delete publicSettings[field];
  const free = await Promise.all(
    FREE_PROVIDERS.map(async (id) => {
      const key = keyOf(id, settings);
      const cfg = configs.find((p) => p.id === id)!;
      return {
        id,
        label: cfg.label,
        hasKey: Boolean(key),
        keyHint: key ? `••••${key.slice(-4)}` : "",
        fromEnv: ENV_KEYS[id].some((k) => process.env[k]),
        model: cfg.model,
        models: FREE_MODELS[id],
        quota: key ? await quotaFor(id, cfg.model) : null,
      };
    }),
  );
  return {
    settings: publicSettings,
    free,
    providers: configs.map(({ id, label, available, model, hint, paid }) => ({
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
  providerId: z.enum(["gemini", "github", "groq", "anthropic", "openai", "demo"]).optional(),
  targetLanguage: z.string().max(20).optional(),
  dialogueStyle: z.enum(["target", "source"]).optional(),
  deepContext: z.boolean().optional(),
  instructions: z.string().max(4000).optional(),
  /** string vazia remove a chave salva */
  geminiApiKey: z.string().max(300).optional(),
  githubToken: z.string().max(300).optional(),
  groqApiKey: z.string().max(300).optional(),
  geminiModel: z.string().max(80).optional(),
  githubModel: z.string().max(80).optional(),
  groqModel: z.string().max(80).optional(),
});

export async function PUT(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("Configurações inválidas.");
  const current = await readSettings();
  const b = parsed.data;
  const next: Settings = {
    ...current,
    providerId: b.providerId ?? current.providerId,
    dialogueStyle: b.dialogueStyle ?? current.dialogueStyle,
    deepContext: b.deepContext ?? current.deepContext,
    targetLanguage: b.targetLanguage ? (findLanguage(b.targetLanguage)?.code ?? current.targetLanguage) : current.targetLanguage,
    instructions: b.instructions?.trim() ?? current.instructions,
  };
  for (const id of FREE_PROVIDERS) {
    const keyField = FREE_KEY_FIELDS[id];
    const value = b[keyField];
    if (value !== undefined) next[keyField] = value.trim() || undefined;
    const modelField = FREE_MODEL_FIELDS[id];
    const model = b[modelField];
    if (model && FREE_MODELS[id].some((m) => m.id === model)) next[modelField] = model;
  }
  await writeSettings(next);
  return json(await payload());
}

/**
 * Testa a chave de um serviço gratuito.
 *  - Gemini e Groq: lista os modelos (não gasta cota);
 *  - GitHub Models: um pedido mínimo (gasta 1 pedido da cota do dia).
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { service?: string };
  const service = (FREE_PROVIDERS as readonly string[]).includes(body.service ?? "") ? (body.service as FreeProviderId) : "gemini";
  const settings = await readSettings();
  const key = keyOf(service, settings);
  const cfg = providerConfigs(settings).find((p) => p.id === service)!;
  if (!key) return fail("Nenhuma chave salva para este serviço.");
  try {
    if (service === "gemini") {
      const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": key } });
      if (!res.ok)
        return json({
          ok: false,
          message: res.status === 400 || res.status === 403 ? "A chave foi recusada pelo Google." : `O Google respondeu ${res.status}.`,
        });
      const data = (await res.json()) as { models?: { name: string }[] };
      const names = new Set((data.models ?? []).map((m) => m.name.replace(/^models\//, "")));
      return json({
        ok: names.has(cfg.model),
        message: names.has(cfg.model) ? undefined : `A chave funciona, mas o modelo ${cfg.model} não aparece para ela.`,
      });
    }
    if (service === "groq") {
      const res = await fetch("https://api.groq.com/openai/v1/models", { headers: { authorization: `Bearer ${key}` } });
      if (!res.ok) return json({ ok: false, message: res.status === 401 ? "A chave foi recusada pelo Groq." : `O Groq respondeu ${res.status}.` });
      const data = (await res.json()) as { data?: { id: string }[] };
      const ids = new Set((data.data ?? []).map((m) => m.id));
      return json({
        ok: ids.has(cfg.model),
        message: ids.has(cfg.model) ? undefined : `A chave funciona, mas o modelo ${cfg.model} não está disponível. Escolha outro.`,
      });
    }
    const res = await fetch("https://models.github.ai/inference/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}`, accept: "application/vnd.github+json" },
      body: JSON.stringify({ model: cfg.model, max_tokens: 1, messages: [{ role: "user", content: "ok" }] }),
    });
    if (res.ok) return json({ ok: true });
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403)
      return json({ ok: false, message: "O GitHub recusou o token. Ele precisa da permissão “Models: Read-only”." });
    if (res.status === 429) return json({ ok: true, message: "Token funcionando, mas a cota de hoje deste modelo já acabou." });
    return json({ ok: false, message: `O GitHub respondeu ${res.status}: ${text.slice(0, 200)}` });
  } catch {
    return json({ ok: false, message: "Não foi possível falar com o serviço agora." });
  }
}
