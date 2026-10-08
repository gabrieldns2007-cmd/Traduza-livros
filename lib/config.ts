/**
 * Configuração vinda de variáveis de ambiente (somente no servidor).
 * Nenhum segredo daqui é enviado ao navegador.
 */
import path from "node:path";

function int(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const config = {
  /** lido sob demanda, para respeitar DATA_DIR definido depois do carregamento */
  get dataDir() {
    // na versão pública os dados ficam no navegador (IndexedDB), separados por conta
    if (typeof window !== "undefined") return (globalThis as { __versoDataDir?: string }).__versoDataDir ?? "/data";
    return path.resolve(/*turbopackIgnore: true*/ process.env.DATA_DIR || path.join(process.cwd(), "data"));
  },
  maxUploadBytes: int("MAX_UPLOAD_MB", 100) * 1024 * 1024,
  /** capítulos traduzidos em paralelo */
  concurrency: Math.min(int("TRANSLATION_CONCURRENCY", 2), 8),
  /** tamanho aproximado (em caracteres) de cada lote enviado ao modelo */
  batchChars: int("TRANSLATION_BATCH_CHARS", 5000),
  appPassword: process.env.APP_PASSWORD || "",
};

export type ProviderId = "gemini" | "github" | "groq" | "anthropic" | "openai" | "demo";

/** Serviços gratuitos (sem cartão), na ordem em que são sugeridos. */
export const FREE_PROVIDERS = ["gemini", "github", "groq"] as const;
export type FreeProviderId = (typeof FREE_PROVIDERS)[number];

export interface ProviderConfig {
  id: ProviderId;
  label: string;
  available: boolean;
  model: string;
  analysisModel: string;
  /** pode gerar cobrança? (exige confirmação antes de usar) */
  paid: boolean;
  /**
   * Quem paga o processamento:
   *  - "byok": a chave é da própria pessoa (custo zero para o dono do Verso; não consome créditos);
   *  - "hosted": a chave é do dono do Verso (consome créditos quando BILLING_MODE=enforce);
   *  - "none": não usa IA (demonstração).
   */
  billing: "byok" | "hosted" | "none";
  /** motivo de indisponibilidade (para a tela de configurações) */
  hint?: string;
}

/** Valores salvos pela tela de Ajustes que afetam provedores (nunca enviados ao navegador). */
export interface ProviderSettings {
  geminiApiKey?: string;
  geminiModel?: string;
  githubToken?: string;
  githubModel?: string;
  groqApiKey?: string;
  groqModel?: string;
}

export const GEMINI_MODELS = [
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", note: "melhor qualidade · poucos pedidos por dia" },
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", note: "mais pedidos por dia · qualidade um pouco menor" },
];

export const GITHUB_MODELS = [
  { id: "openai/gpt-4.1", label: "GPT-4.1", note: "melhor qualidade · cerca de 50 pedidos por dia" },
  { id: "openai/gpt-4.1-mini", label: "GPT-4.1 mini", note: "mais pedidos por dia · qualidade um pouco menor" },
];

export const GROQ_MODELS = [
  { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", note: "boa qualidade · limite de texto por dia" },
  { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B", note: "modelo aberto da OpenAI · limite de texto por dia" },
];

export function geminiApiKey(s?: ProviderSettings): string {
  return (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || s?.geminiApiKey || "").trim();
}

/** Token do GitHub com permissão “Models: read”. (O GITHUB_TOKEN automático do Codespaces não é usado.) */
export function githubToken(s?: ProviderSettings): string {
  return (process.env.GITHUB_MODELS_TOKEN || s?.githubToken || "").trim();
}

export function groqApiKey(s?: ProviderSettings): string {
  return (process.env.GROQ_API_KEY || s?.groqApiKey || "").trim();
}

export const FREE_KEY_FIELDS = { gemini: "geminiApiKey", github: "githubToken", groq: "groqApiKey" } as const;
export const FREE_MODEL_FIELDS = { gemini: "geminiModel", github: "githubModel", groq: "groqModel" } as const;
export const FREE_MODELS: Record<FreeProviderId, { id: string; label: string; note: string }[]> = {
  gemini: GEMINI_MODELS,
  github: GITHUB_MODELS,
  groq: GROQ_MODELS,
};

export function providerConfigs(s?: ProviderSettings): ProviderConfig[] {
  const anthropicModel = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
  const openaiModel = process.env.OPENAI_MODEL || "";
  const geminiModel = process.env.GEMINI_MODEL || s?.geminiModel || "gemini-3.8-flash";
  return [
    {
      id: "gemini",
      label: "Gemini Free",
      available: Boolean(geminiApiKey(s)),
      model: geminiModel,
      analysisModel: geminiModel,
      paid: false,
      billing: "byok",
      hint: "Adicione sua chave gratuita do Google AI Studio em Ajustes",
    },
    {
      id: "github",
      label: "GitHub Models",
      available: Boolean(githubToken(s)),
      model: process.env.GITHUB_MODELS_MODEL || s?.githubModel || GITHUB_MODELS[0].id,
      analysisModel: process.env.GITHUB_MODELS_MODEL || s?.githubModel || GITHUB_MODELS[0].id,
      paid: false,
      billing: "byok",
      hint: "Adicione um token gratuito do GitHub em Ajustes",
    },
    {
      id: "groq",
      label: "Groq",
      available: Boolean(groqApiKey(s)),
      model: process.env.GROQ_MODEL || s?.groqModel || GROQ_MODELS[0].id,
      analysisModel: process.env.GROQ_MODEL || s?.groqModel || GROQ_MODELS[0].id,
      paid: false,
      billing: "byok",
      hint: "Adicione sua chave gratuita do Groq em Ajustes",
    },
    {
      id: "anthropic",
      label: "Anthropic (Claude)",
      available: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
      model: anthropicModel,
      analysisModel: process.env.ANTHROPIC_ANALYSIS_MODEL || anthropicModel,
      paid: true,
      billing: "hosted",
      hint: "Defina ANTHROPIC_API_KEY no arquivo .env.local",
    },
    {
      id: "openai",
      label: process.env.OPENAI_PROVIDER_LABEL || "OpenAI ou compatível",
      available: Boolean(process.env.OPENAI_API_KEY && openaiModel) || Boolean(process.env.OPENAI_BASE_URL && openaiModel),
      model: openaiModel,
      analysisModel: process.env.OPENAI_ANALYSIS_MODEL || openaiModel,
      paid: true,
      billing: "hosted",
      hint: "Defina OPENAI_API_KEY e OPENAI_MODEL (e OPENAI_BASE_URL para provedores compatíveis)",
    },
    {
      id: "demo",
      label: "Demonstração (sem IA)",
      // na versão pública, só para testes (copiaria o texto sem traduzir)
      available: process.env.NEXT_PUBLIC_VERSO_MODE !== "public" || process.env.NEXT_PUBLIC_VERSO_TEST_LOGIN === "1",
      model: "demo",
      analysisModel: "demo",
      paid: false,
      billing: "none",
      hint: "Copia o texto original — útil para testar o fluxo sem chave de API",
    },
  ];
}

/**
 * Provedor sugerido para novas traduções: sempre um GRATUITO.
 * Provedores pagos só são usados quando escolhidos e confirmados pelo usuário.
 */
export function defaultProviderId(s?: ProviderSettings & { providerId?: string }): ProviderId {
  const all = providerConfigs(s);
  const preferred = all.find((p) => p.id === s?.providerId && p.available && !p.paid);
  if (preferred) return preferred.id;
  return all.find((p) => (FREE_PROVIDERS as readonly string[]).includes(p.id) && p.available)?.id ?? "demo";
}

/** Quem paga o processamento de um serviço ("byok" quando desconhecido: nunca cobra por engano). */
export function billingOf(id: string, s?: ProviderSettings): ProviderConfig["billing"] {
  return providerConfigs(s).find((p) => p.id === id)?.billing ?? "byok";
}
