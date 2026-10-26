/**
 * Configuração vinda de variáveis de ambiente (somente no servidor).
 * Nenhum segredo daqui é enviado ao navegador.
 */
import path from "node:path";
import { PUBLIC_MODE } from "@/lib/mode";

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

export type ProviderId = "gemini" | "github" | "groq" | "cloudflare" | "mistral" | "anthropic" | "openai" | "demo";

/**
 * Serviços com chave gratuita guardada em Ajustes (cota de hoje, chave nunca volta ao navegador).
 * O GitHub Models foi encerrado pelo GitHub (30/07/2026): continua na lista só
 * para que ajustes antigos carreguem e o token salvo nunca volte ao navegador —
 * ele não é `free` e nunca traduz.
 */
export const FREE_PROVIDERS = ["gemini", "github", "groq", "cloudflare", "mistral"] as const;
export type FreeProviderId = (typeof FREE_PROVIDERS)[number];

/** O que o serviço faz com o texto enviado (mostrado no painel; fonte: termos oficiais). */
export interface DataPolicy {
  /** resumo em uma ou duas frases, em português simples */
  note: string;
  /** usa o texto para treinar modelos: true, false ou "default" (sim, a menos que o dono desligue) */
  trains: boolean | "default";
  /** página oficial com os termos */
  url: string;
}

export interface ProviderConfig {
  id: ProviderId;
  label: string;
  available: boolean;
  model: string;
  analysisModel: string;
  /** pode gerar cobrança? (exige confirmação antes de usar) */
  paid: boolean;
  /**
   * Nível gratuito de verdade (sem cartão): só estes traduzem a tradução Grátis,
   * em rodízio automático. Um serviço nunca é `free` e `paid` ao mesmo tempo.
   */
  free: boolean;
  /**
   * Quem paga o processamento:
   *  - "byok": a chave é da própria pessoa (custo zero para o dono do Verso; não consome créditos);
   *  - "hosted": a chave é do dono do Verso (consome créditos quando BILLING_MODE=enforce);
   *  - "none": não usa IA (demonstração).
   */
  billing: "byok" | "hosted" | "none";
  /** motivo de indisponibilidade (para a tela de configurações) */
  hint?: string;
  /** encerrado pelo fornecedor: nunca é usado, mesmo com chave salva */
  retired?: boolean;
  /** só no servidor próprio (não existe na versão pública) */
  serverOnly?: boolean;
  /** uso dos dados no nível gratuito (painel) */
  dataPolicy?: DataPolicy;
  /** limites gratuitos publicados, em palavras simples (painel) */
  limitsNote?: string;
}

/** Valores salvos pela tela de Ajustes que afetam provedores (nunca enviados ao navegador). */
export interface ProviderSettings {
  geminiApiKey?: string;
  geminiModel?: string;
  githubToken?: string;
  githubModel?: string;
  groqApiKey?: string;
  groqModel?: string;
  cloudflareAccountId?: string;
  cloudflareApiToken?: string;
  cloudflareModel?: string;
  mistralApiKey?: string;
  mistralModel?: string;
}

export const GEMINI_MODELS = [
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", note: "melhor qualidade · poucos pedidos por dia" },
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", note: "mais pedidos por dia · qualidade um pouco menor" },
];

/** Aviso mostrado no lugar do GitHub Models, que deixou de existir. */
export const GITHUB_RETIRED_MESSAGE = "O GitHub encerrou o GitHub Models em 30/07/2026. Use o Gemini ou o Groq.";

export const GITHUB_MODELS = [
  { id: "openai/gpt-4.1", label: "GPT-4.1", note: "melhor qualidade · cerca de 50 pedidos por dia" },
  { id: "openai/gpt-4.1-mini", label: "GPT-4.1 mini", note: "mais pedidos por dia · qualidade um pouco menor" },
];

/** O Llama 3.3 70B saiu do plano grátis do Groq em 16/08/2026: só o GPT-OSS continua. */
export const GROQ_MODELS = [{ id: "openai/gpt-oss-120b", label: "GPT-OSS 120B", note: "modelo aberto da OpenAI · limite de texto por dia" }];

/** Modelos do Groq encerrados no plano grátis: um ajuste antigo passa a usar o substituto, sem aviso. */
const GROQ_SHUT_DOWN = new Set(["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]);

export function groqModelOf(model: string | undefined): string {
  const m = (model || "").trim();
  return !m || GROQ_SHUT_DOWN.has(m) ? GROQ_MODELS[0].id : m;
}

/** Cloudflare Workers AI: modelos que funcionam no plano Workers Free (sem cartão). */
export const CLOUDFLARE_MODELS = [
  { id: "@cf/google/gemma-4-26b-a4b-it", label: "Gemma 4 26B", note: "rende mais texto na cota grátis do dia" },
  { id: "@cf/openai/gpt-oss-120b", label: "GPT-OSS 120B", note: "gasta a cota do dia quase 3 vezes mais rápido" },
  { id: "@cf/mistralai/mistral-small-3.1-24b-instruct", label: "Mistral Small 3.1", note: "gasta a cota do dia cerca de 2 vezes mais rápido" },
];

export const MISTRAL_MODELS = [
  { id: "mistral-small-latest", label: "Mistral Small", note: "o modelo do teste oficial do modo Free" },
  { id: "mistral-medium-latest", label: "Mistral Medium", note: "melhor qualidade · pode gastar a cota do mês mais rápido" },
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

export function cloudflareAccountId(s?: ProviderSettings): string {
  return (process.env.CLOUDFLARE_ACCOUNT_ID || s?.cloudflareAccountId || "").trim();
}

export function cloudflareApiToken(s?: ProviderSettings): string {
  return (process.env.CLOUDFLARE_API_TOKEN || s?.cloudflareApiToken || "").trim();
}

export function mistralApiKey(s?: ProviderSettings): string {
  return (process.env.MISTRAL_API_KEY || s?.mistralApiKey || "").trim();
}

/** Endereço compatível com OpenAI do Workers AI (a conta faz parte do caminho). */
export function cloudflareBaseUrl(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1`;
}

export const MISTRAL_BASE_URL = "https://api.mistral.ai/v1";

/** Chave secreta de cada serviço gratuito (nunca volta ao navegador). */
export const FREE_KEY_FIELDS = {
  gemini: "geminiApiKey",
  github: "githubToken",
  groq: "groqApiKey",
  cloudflare: "cloudflareApiToken",
  mistral: "mistralApiKey",
} as const;
export const FREE_MODEL_FIELDS = {
  gemini: "geminiModel",
  github: "githubModel",
  groq: "groqModel",
  cloudflare: "cloudflareModel",
  mistral: "mistralModel",
} as const;
/** Tudo o que identifica uma conta de serviço de IA (chaves e o ID da conta da Cloudflare). */
export const PROVIDER_SECRET_FIELDS = [...Object.values(FREE_KEY_FIELDS), "cloudflareAccountId"] as const;
export const FREE_MODELS: Record<FreeProviderId, { id: string; label: string; note: string }[]> = {
  gemini: GEMINI_MODELS,
  github: GITHUB_MODELS,
  groq: GROQ_MODELS,
  cloudflare: CLOUDFLARE_MODELS,
  mistral: MISTRAL_MODELS,
};

/** Uso dos dados no nível gratuito de cada serviço (termos oficiais, conferidos em 18/10/2026). */
const DATA_POLICIES: Partial<Record<ProviderId, DataPolicy>> = {
  gemini: {
    note: "No nível gratuito, o Google usa o texto enviado e as respostas para melhorar os produtos dele, e revisores humanos podem ler. O próprio Google pede para não enviar nada confidencial.",
    trains: true,
    url: "https://ai.google.dev/gemini-api/terms",
  },
  groq: {
    note: "Não treina com o texto. Guarda registros só para resolver falhas e investigar abuso, por até 30 dias (dá para desligar com “Zero Data Retention” nas configurações de dados do Groq).",
    trains: false,
    url: "https://console.groq.com/docs/your-data",
  },
  cloudflare: {
    note: "Não treina com o texto e não guarda o pedido depois de responder (retenção zero na tradução comum).",
    trains: false,
    url: "https://developers.cloudflare.com/workers-ai/platform/data-usage/",
  },
  mistral: {
    note: "No modo Free, a Mistral treina com o texto por padrão: desligue em Admin → Privacy → “Anonymous improvement data”. Guarda os pedidos por 30 dias para monitorar abuso. A Mistral diz que o modo Free é para avaliação e protótipos.",
    trains: "default",
    url: "https://help.mistral.ai/en/articles/455207-can-i-opt-out-of-my-input-or-output-data-being-used-for-training",
  },
};

const LIMITS_NOTES: Partial<Record<ProviderId, string>> = {
  gemini:
    "O Google não publica os números do nível gratuito (veja no AI Studio). A cota do dia volta à meia-noite do Pacífico (4h ou 5h em Brasília).",
  groq: "Plano grátis do GPT-OSS 120B: 30 pedidos por minuto, 1.000 por dia, 8 mil tokens por minuto e 200 mil por dia — menos de um romance por dia.",
  cloudflare:
    "10.000 Neurons por dia na conta, que voltam às 21h de Brasília (meia-noite UTC). Pela nossa conta, dá no máximo um romance por dia com o Gemma 4.",
  mistral: "A Mistral não publica a cota do modo Free (veja em Admin → Limits). Quando a cota do mês acaba, ela volta no dia 1º.",
};

export function providerConfigs(s?: ProviderSettings): ProviderConfig[] {
  const anthropicModel = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
  const openaiModel = process.env.OPENAI_MODEL || "";
  const geminiModel = process.env.GEMINI_MODEL || s?.geminiModel || "gemini-3.8-flash";
  const groqModel = groqModelOf(process.env.GROQ_MODEL || s?.groqModel);
  const cloudflareModel = process.env.CLOUDFLARE_MODEL || s?.cloudflareModel || CLOUDFLARE_MODELS[0].id;
  const mistralModel = process.env.MISTRAL_MODEL || s?.mistralModel || MISTRAL_MODELS[0].id;
  const all: ProviderConfig[] = [
    {
      id: "gemini",
      label: "Gemini Free",
      available: Boolean(geminiApiKey(s)),
      model: geminiModel,
      analysisModel: geminiModel,
      paid: false,
      free: true,
      billing: "byok",
      hint: "Adicione sua chave gratuita do Google AI Studio em Ajustes",
    },
    {
      // encerrado pelo GitHub em 30/07/2026: um token salvo nunca manda traduções para lá
      id: "github",
      label: "GitHub Models",
      available: false,
      retired: true,
      model: process.env.GITHUB_MODELS_MODEL || s?.githubModel || GITHUB_MODELS[0].id,
      analysisModel: process.env.GITHUB_MODELS_MODEL || s?.githubModel || GITHUB_MODELS[0].id,
      paid: false,
      free: false,
      billing: "byok",
      hint: GITHUB_RETIRED_MESSAGE,
    },
    {
      id: "groq",
      label: "Groq",
      available: Boolean(groqApiKey(s)),
      model: groqModel,
      analysisModel: groqModel,
      paid: false,
      free: true,
      billing: "byok",
      hint: "Adicione sua chave gratuita do Groq em Ajustes",
    },
    {
      id: "cloudflare",
      label: "Cloudflare Workers AI",
      available: Boolean(cloudflareAccountId(s) && cloudflareApiToken(s)),
      model: cloudflareModel,
      analysisModel: cloudflareModel,
      paid: false,
      free: true,
      billing: "byok",
      serverOnly: true,
      hint: "Adicione o ID da conta e o token gratuitos da Cloudflare em Ajustes",
    },
    {
      id: "mistral",
      label: "Mistral (modo Free)",
      available: Boolean(mistralApiKey(s)),
      model: mistralModel,
      analysisModel: mistralModel,
      paid: false,
      free: true,
      billing: "byok",
      serverOnly: true,
      hint: "Adicione sua chave do modo Free da Mistral em Ajustes",
    },
    {
      id: "anthropic",
      label: "Anthropic (Claude)",
      available: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
      model: anthropicModel,
      analysisModel: process.env.ANTHROPIC_ANALYSIS_MODEL || anthropicModel,
      paid: true,
      free: false,
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
      free: false,
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
      free: false,
      billing: "none",
      hint: "Copia o texto original — útil para testar o fluxo sem chave de API",
    },
  ];
  // Cloudflare e Mistral só existem no servidor próprio: na versão pública nem aparecem
  return all.filter((p) => !(PUBLIC_MODE && p.serverOnly)).map((p) => ({ ...p, dataPolicy: DATA_POLICIES[p.id], limitsNote: LIMITS_NOTES[p.id] }));
}

/** Serviços que traduzem a tradução Grátis: nível gratuito de verdade, nunca pagos. */
export function freeProviderIds(s?: ProviderSettings): ProviderId[] {
  return providerConfigs(s)
    .filter((p) => p.free && !p.paid)
    .map((p) => p.id);
}

/**
 * Provedor sugerido para novas traduções: sempre um GRATUITO.
 * Provedores pagos só são usados quando escolhidos e confirmados pelo usuário.
 */
export function defaultProviderId(s?: ProviderSettings & { providerId?: string }): ProviderId {
  const all = providerConfigs(s);
  const preferred = all.find((p) => p.id === s?.providerId && p.available && !p.paid);
  if (preferred) return preferred.id;
  return all.find((p) => p.free && !p.paid && p.available)?.id ?? "demo";
}

/** Quem paga o processamento de um serviço ("byok" quando desconhecido: nunca cobra por engano). */
export function billingOf(id: string, s?: ProviderSettings): ProviderConfig["billing"] {
  return providerConfigs(s).find((p) => p.id === id)?.billing ?? "byok";
}

/**
 * Serviço que pode gerar cobrança. Um id desconhecido (que não é gratuito nem a
 * demonstração) conta como pago: na dúvida, nunca chama sem pedido pago.
 */
export function isPaidProviderId(id: string, s?: ProviderSettings): boolean {
  const cfg = providerConfigs(s).find((p) => p.id === id);
  if (cfg) return cfg.paid;
  return !(FREE_PROVIDERS as readonly string[]).includes(id) && id !== "demo";
}
