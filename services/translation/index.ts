import { config, geminiApiKey, githubToken, groqApiKey, providerConfigs, type ProviderId, type ProviderSettings } from "@/lib/config";
import type { TranslationProvider } from "./translation-provider";
import { LLMTranslationProvider } from "./llm-provider";
import { DemoTranslationProvider } from "./demo-provider";
import { AnthropicClient } from "./llm/anthropic";
import { GeminiClient } from "./llm/gemini";
import { FreeOpenAIClient } from "./llm/free-openai";
import { freeServiceBase } from "@/lib/mode";
import { OpenAICompatibleClient } from "./llm/openai-compatible";
import { ProviderError, type Effort, type LLMClient, type LLMRequest } from "./llm/types";
import { isFreeProvider, recordExhausted, recordRequest } from "@/services/quota/usage";

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
      return new LLMTranslationProvider(counted(new GeminiClient(cfg.model, geminiApiKey(settings))), {
        paid: false,
        limits: { batchChars: Number(process.env.GEMINI_BATCH_CHARS) || 24000, concurrency: 1 },
      });
    case "github":
      // nível gratuito: até ~8 mil tokens de entrada e 4 mil de saída por pedido
      return new LLMTranslationProvider(
        counted(
          new FreeOpenAIClient("github", cfg.model, githubToken(settings), {
            label: "GitHub Models",
            baseUrl: freeServiceBase("github"),
            maxOutputTokens: 4000,
            headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
          }),
        ),
        { paid: false, limits: { batchChars: Number(process.env.GITHUB_BATCH_CHARS) || 8000, concurrency: 1 } },
      );
    case "groq":
      // o limite gratuito por minuto conta entrada + saída: pedidos menores
      return new LLMTranslationProvider(
        counted(
          new FreeOpenAIClient("groq", cfg.model, groqApiKey(settings), {
            label: "Groq",
            baseUrl: freeServiceBase("groq"),
            maxOutputTokens: 4000,
            dailyRequestHeaders: true,
          }),
        ),
        { paid: false, limits: { batchChars: Number(process.env.GROQ_BATCH_CHARS) || 5000, concurrency: 1 } },
      );
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

/** Conta os pedidos de um serviço gratuito (“créditos grátis de hoje”) e anota quando a cota acaba. */
function counted(client: LLMClient): LLMClient {
  const id = client.providerId;
  if (!isFreeProvider(id)) return client;
  return {
    providerId: id,
    model: client.model,
    async complete(req: LLMRequest) {
      try {
        const res = await client.complete(req);
        await recordRequest(id, client.model, res.usage, res.rateLimit).catch(() => {});
        return res;
      } catch (err) {
        if (err instanceof ProviderError && err.code === "quota") await recordExhausted(id, client.model, err.retryAt).catch(() => {});
        throw err;
      }
    },
  };
}
