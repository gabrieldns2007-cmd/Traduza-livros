import { config, geminiApiKey, providerConfigs, type ProviderId, type ProviderSettings } from "@/lib/config";
import type { TranslationProvider } from "./translation-provider";
import { LLMTranslationProvider } from "./llm-provider";
import { DemoTranslationProvider } from "./demo-provider";
import { AnthropicClient } from "./llm/anthropic";
import { GeminiClient } from "./llm/gemini";
import { OpenAICompatibleClient } from "./llm/openai-compatible";
import { ProviderError, type Effort } from "./llm/types";

export type { TranslationProvider } from "./translation-provider";

function effort(): Effort {
  const e = process.env.LLM_EFFORT;
  return e === "low" || e === "high" ? e : "medium";
}

/**
 * Cria EXATAMENTE o provedor pedido. Nunca troca por outro (nem de grátis para
 * pago, nem o contrário): se ele não estiver configurado, lança um erro claro.
 */
export function createProvider(id: string, settings?: ProviderSettings): TranslationProvider {
  const cfg = providerConfigs(settings).find((p) => p.id === id);
  if (!cfg) throw new ProviderError(`Provedor desconhecido: ${id}.`, { fatal: true, code: "other" });
  if (!cfg.available) throw new ProviderError(`${cfg.label} não está configurado. ${cfg.hint ?? ""}`.trim(), { fatal: true, code: "auth" });
  switch (cfg.id as ProviderId) {
    case "gemini":
      // pedidos grandes e um de cada vez: poucos pedidos por dia no nível gratuito
      return new LLMTranslationProvider(new GeminiClient(cfg.model, geminiApiKey(settings)), {
        paid: false,
        limits: { batchChars: Number(process.env.GEMINI_BATCH_CHARS) || 24000, concurrency: 1 },
      });
    case "anthropic":
      return new LLMTranslationProvider(new AnthropicClient(cfg.model, cfg.analysisModel, effort()), {
        paid: true,
        limits: { batchChars: config.batchChars, concurrency: config.concurrency },
      });
    case "openai":
      return new LLMTranslationProvider(
        new OpenAICompatibleClient(
          cfg.model,
          cfg.analysisModel,
          process.env.OPENAI_API_KEY ?? "",
          process.env.OPENAI_BASE_URL,
          (process.env.OPENAI_JSON_MODE as "none" | "json_object" | "json_schema") || "none",
        ),
        { paid: true, limits: { batchChars: config.batchChars, concurrency: config.concurrency } },
      );
    default:
      return new DemoTranslationProvider();
  }
}
