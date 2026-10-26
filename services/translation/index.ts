import {
  cloudflareAccountId,
  cloudflareApiToken,
  cloudflareBaseUrl,
  config,
  geminiApiKey,
  groqApiKey,
  MISTRAL_BASE_URL,
  mistralApiKey,
  providerConfigs,
  type ProviderId,
  type ProviderSettings,
} from "@/lib/config";
import type { TranslationProvider } from "./translation-provider";
import { LLMTranslationProvider } from "./llm-provider";
import { DemoTranslationProvider } from "./demo-provider";
import { AnthropicClient } from "./llm/anthropic";
import { GeminiClient } from "./llm/gemini";
import { cloudflareError, FreeOpenAIClient, mistralError, type Gate } from "./llm/free-openai";
import { freeServiceBase } from "@/lib/mode";
import { OpenAICompatibleClient } from "./llm/openai-compatible";
import { ProviderError, type Effort, type LLMClient, type LLMRequest } from "./llm/types";
import { isFreeProvider, recordExhausted, recordRequest } from "@/services/quota/usage";
import { recordSuccess } from "@/services/providers/health";
import { acquire } from "@/services/providers/limiter";

export type { TranslationProvider } from "./translation-provider";

function effort(): Effort {
  const e = process.env.LLM_EFFORT;
  return e === "low" || e === "high" ? e : "medium";
}

/**
 * Vaga na fila de um serviço gratuito (um pedido por vez, no ritmo do limite por
 * minuto, para todos os livros): o cliente pega a cada tentativa e devolve antes de
 * esperar por uma nova tentativa — a espera não segura a fila dos outros livros.
 */
function gateOf(id: string, model: string): Gate {
  return (signal, tokens) => acquire(id, model, { signal, tokens });
}

/** Modelos que “pensam” antes de responder (GPT-OSS, Gemma 4): sem temperatura fixa. */
function reasons(model: string) {
  return /gpt-oss|gemma-4/i.test(model);
}

/**
 * Cria EXATAMENTE o provedor pedido. Nunca troca por outro (nem de grátis para
 * pago, nem o contrário): se ele não estiver configurado, lança um erro claro.
 */
export function createProvider(id: string, settings?: ProviderSettings): TranslationProvider {
  const cfg = providerConfigs(settings).find((p) => p.id === id);
  if (!cfg) throw new ProviderError(`Provedor desconhecido: ${id}.`, { fatal: true, code: "other" });
  // serviço encerrado pelo fornecedor: nunca é chamado, mesmo com chave salva
  if (cfg.retired) throw new ProviderError(cfg.hint ?? `${cfg.label} foi encerrado.`, { fatal: true, code: "model" });
  if (!cfg.available) throw new ProviderError(`${cfg.label} não está configurado. ${cfg.hint ?? ""}`.trim(), { fatal: true, code: "auth" });
  switch (cfg.id as ProviderId) {
    case "gemini":
      // pedidos grandes e um de cada vez: poucos pedidos por dia no nível gratuito.
      // Até 400 trechos por pedido: poesia (um verso por parágrafo) cabe em poucos pedidos
      return new LLMTranslationProvider(counted(new GeminiClient(cfg.model, geminiApiKey(settings), undefined, gateOf("gemini", cfg.model))), {
        paid: false,
        limits: {
          batchChars: Number(process.env.GEMINI_BATCH_CHARS) || 24000,
          maxSegments: Number(process.env.GEMINI_MAX_SEGMENTS) || 400,
          concurrency: 1,
        },
      });
    case "groq":
      // o limite gratuito por minuto conta entrada + saída (8 mil tokens): pedidos menores.
      // GPT-OSS raciocina antes de responder: raciocínio curto gasta menos da cota
      return new LLMTranslationProvider(
        counted(
          new FreeOpenAIClient("groq", cfg.model, groqApiKey(settings), {
            label: "Groq",
            baseUrl: freeServiceBase("groq"),
            maxOutputTokens: 4000,
            dailyRequestHeaders: true,
            extraBody: /gpt-oss/i.test(cfg.model) ? { reasoning_effort: "low" } : undefined,
            temperature: reasons(cfg.model) ? undefined : 0.3,
            gate: gateOf("groq", cfg.model),
          }),
        ),
        // teto de saída de 4.000 tokens: a análise do livro já pede a versão curta (sem um pedido cortado antes)
        { paid: false, limits: { batchChars: Number(process.env.GROQ_BATCH_CHARS) || 5000, concurrency: 1, maxOutputTokens: 4000 } },
      );
    case "cloudflare":
      // 10.000 Neurons por dia na conta; max_tokens sempre enviado (sem ele a Cloudflare corta em 256)
      return new LLMTranslationProvider(
        counted(
          new FreeOpenAIClient("cloudflare", cfg.model, cloudflareApiToken(settings), {
            label: "Cloudflare Workers AI",
            baseUrl: cloudflareBaseUrl(cloudflareAccountId(settings)),
            maxOutputTokens: 8192,
            // o modo JSON da Cloudflare não funciona com streaming: a análise pede JSON só no texto
            jsonMode: false,
            temperature: reasons(cfg.model) ? undefined : 0.3,
            classifyError: cloudflareError,
            rateFallback: "rate_limit",
            gate: gateOf("cloudflare", cfg.model),
          }),
        ),
        {
          paid: false,
          limits: { batchChars: Number(process.env.CLOUDFLARE_BATCH_CHARS) || 6000, maxSegments: 80, concurrency: 1, maxOutputTokens: 8192 },
        },
      );
    case "mistral":
      // modo Free: cota do mês e limites não publicados; um pedido por vez, em ritmo calmo
      return new LLMTranslationProvider(
        counted(
          new FreeOpenAIClient("mistral", cfg.model, mistralApiKey(settings), {
            label: "Mistral",
            baseUrl: MISTRAL_BASE_URL,
            maxOutputTokens: 8192,
            jsonMode: false,
            streamUsage: true,
            temperature: 0.3,
            classifyError: mistralError,
            rateFallback: "rate_limit",
            gate: gateOf("mistral", cfg.model),
          }),
        ),
        {
          paid: false,
          limits: { batchChars: Number(process.env.MISTRAL_BATCH_CHARS) || 6000, maxSegments: 80, concurrency: 1, maxOutputTokens: 8192 },
        },
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

/**
 * Serviço gratuito: cada pedido (tradução, análise, prévia, de qualquer livro)
 * conta nos “créditos grátis de hoje”, anota quando a cota acaba e, quando a
 * resposta volta, marca o serviço como saudável. A vez na fila do serviço é
 * pedida pelo próprio cliente, a cada tentativa (gateOf).
 */
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
        await recordSuccess(id, client.model).catch(() => {});
        return res;
      } catch (err) {
        if (err instanceof ProviderError && err.code === "quota") await recordExhausted(id, client.model, err.retryAt).catch(() => {});
        throw err;
      }
    },
  };
}
