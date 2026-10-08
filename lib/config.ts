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
    return path.resolve(/*turbopackIgnore: true*/ process.env.DATA_DIR || path.join(process.cwd(), "data"));
  },
  maxUploadBytes: int("MAX_UPLOAD_MB", 100) * 1024 * 1024,
  /** capítulos traduzidos em paralelo */
  concurrency: Math.min(int("TRANSLATION_CONCURRENCY", 2), 8),
  /** tamanho aproximado (em caracteres) de cada lote enviado ao modelo */
  batchChars: int("TRANSLATION_BATCH_CHARS", 5000),
  appPassword: process.env.APP_PASSWORD || "",
};

export type ProviderId = "anthropic" | "openai" | "demo";

export interface ProviderConfig {
  id: ProviderId;
  label: string;
  available: boolean;
  model: string;
  analysisModel: string;
  /** motivo de indisponibilidade (para a tela de configurações) */
  hint?: string;
}

export function providerConfigs(): ProviderConfig[] {
  const anthropicModel = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
  const openaiModel = process.env.OPENAI_MODEL || "";
  return [
    {
      id: "anthropic",
      label: "Anthropic (Claude)",
      available: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
      model: anthropicModel,
      analysisModel: process.env.ANTHROPIC_ANALYSIS_MODEL || anthropicModel,
      hint: "Defina ANTHROPIC_API_KEY no arquivo .env.local",
    },
    {
      id: "openai",
      label: process.env.OPENAI_PROVIDER_LABEL || "OpenAI ou compatível",
      available: Boolean(process.env.OPENAI_API_KEY && openaiModel) || Boolean(process.env.OPENAI_BASE_URL && openaiModel),
      model: openaiModel,
      analysisModel: process.env.OPENAI_ANALYSIS_MODEL || openaiModel,
      hint: "Defina OPENAI_API_KEY e OPENAI_MODEL (e OPENAI_BASE_URL para provedores compatíveis)",
    },
    {
      id: "demo",
      label: "Demonstração (sem IA)",
      available: true,
      model: "demo",
      analysisModel: "demo",
      hint: "Copia o texto original — útil para testar o fluxo sem chave de API",
    },
  ];
}

/** Provedor padrão: o definido em LLM_PROVIDER, senão o primeiro disponível. */
export function defaultProviderId(): ProviderId {
  const configured = process.env.LLM_PROVIDER as ProviderId | undefined;
  const all = providerConfigs();
  if (configured && all.find((p) => p.id === configured)?.available) return configured;
  return all.find((p) => p.available && p.id !== "demo")?.id ?? "demo";
}
