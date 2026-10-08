import { providerConfigs, defaultProviderId, type ProviderId } from "@/lib/config";
import type { TranslationProvider } from "./translation-provider";
import { LLMTranslationProvider } from "./llm-provider";
import { DemoTranslationProvider } from "./demo-provider";
import { AnthropicClient } from "./llm/anthropic";
import { OpenAICompatibleClient } from "./llm/openai-compatible";
import type { Effort } from "./llm/types";

export type { TranslationProvider } from "./translation-provider";

function effort(): Effort {
  const e = process.env.LLM_EFFORT;
  return e === "low" || e === "high" ? e : "medium";
}

/** Cria o provedor de tradução. Trocar de modelo/provedor é só mudar o .env. */
export function getTranslationProvider(id?: string): TranslationProvider {
  const all = providerConfigs();
  const wanted = (id && all.find((p) => p.id === id && p.available)?.id) || defaultProviderId();
  const cfg = all.find((p) => p.id === wanted)!;
  switch (cfg.id as ProviderId) {
    case "anthropic":
      return new LLMTranslationProvider(new AnthropicClient(cfg.model, cfg.analysisModel, effort()));
    case "openai":
      return new LLMTranslationProvider(
        new OpenAICompatibleClient(
          cfg.model,
          cfg.analysisModel,
          process.env.OPENAI_API_KEY ?? "",
          process.env.OPENAI_BASE_URL,
          (process.env.OPENAI_JSON_MODE as "none" | "json_object" | "json_schema") || "none",
        ),
      );
    default:
      return new DemoTranslationProvider();
  }
}
