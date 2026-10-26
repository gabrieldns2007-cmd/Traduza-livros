/**
 * Serviços gratuitos (GitHub Models, Groq): limite por minuto espera e tenta de
 * novo; limite diário pausa (nunca troca de serviço); pedido grande demais
 * vira “dividir o lote”; a contagem de créditos grátis acompanha os pedidos.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { config } from "@/lib/config";
import { FreeOpenAIClient, parseLimit } from "@/services/translation/llm/free-openai";
import { ProviderError } from "@/services/translation/llm/types";
import { createProvider } from "@/services/translation";
import { quotaFor } from "@/services/quota/usage";
import { resetLimiter } from "@/services/providers/limiter";
import { nextPacificMidnight } from "@/services/translation/llm/gemini";

function sse(text: string) {
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}`,
    "data: [DONE]",
    "",
  ].join("\n");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const req = { system: "s", user: "u", maxTokens: 16000, purpose: "translation" as const };
const client = () =>
  new FreeOpenAIClient("groq", "llama-3.3-70b-versatile", "k", { label: "Groq", baseUrl: "https://x.test/v1", maxOutputTokens: 4000 });

// sem a espera de 2 s entre pedidos do Groq (30 por minuto): o ritmo tem teste próprio
beforeAll(() => {
  process.env.GROQ_RPM = "60000";
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetLimiter();
});

describe("parseLimit", () => {
  it("separa limite por minuto de limite diário e lê a espera", () => {
    expect(parseLimit("Rate limit reached ... on tokens per minute (TPM): Limit 6000. Please try again in 7.66s.")).toEqual({
      daily: false,
      retryMs: 7660,
    });
    const day = parseLimit("Rate limit reached ... on tokens per day (TPD): Limit 100000. Please try again in 14m24s.");
    expect(day.daily).toBe(true);
    expect(day.retryMs).toBe(864_000);
    expect(parseLimit("Rate limit of 50 per 86400s exceeded for UserByModelByDay. Please wait 3600 seconds before retrying.")).toEqual({
      daily: true,
      retryMs: 3_600_000,
    });
    expect(parseLimit("Rate limit of 10 per 60s exceeded for UserByModelByMinute. Please wait 39 seconds before retrying.").daily).toBe(false);
  });

  it("a cota do Gemini volta à meia-noite do Pacífico (4h em Brasília)", () => {
    expect(new Date(nextPacificMidnight(Date.parse("2026-10-08T20:44:00Z"))).toISOString()).toBe("2026-10-09T07:00:00.000Z");
  });
});

describe("FreeOpenAIClient", () => {
  it("limite por minuto: espera e tenta de novo, limitando os tokens de saída", async () => {
    const bodies: Record<string, unknown>[] = [];
    let calls = 0;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      calls++;
      if (calls === 1)
        return new Response(JSON.stringify({ error: { message: "Rate limit reached on requests per minute (RPM). Please try again in 0.05s." } }), {
          status: 429,
        });
      return sse("olá");
    });
    const waits: number[] = [];
    const res = await client().complete({ ...req, onWait: (ms) => waits.push(ms) });
    expect(res.text).toBe("olá");
    expect(calls).toBe(2);
    expect(waits).toHaveLength(1);
    expect(bodies[0].max_tokens).toBe(4000);
  });

  it("limite diário: pausa com código quota e não tenta de novo", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return new Response(
        JSON.stringify({ error: { message: "Rate limit reached on tokens per day (TPD): Limit 100000. Please try again in 1h2m3s." } }),
        { status: 429 },
      );
    });
    const err = await client()
      .complete(req)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe("quota");
    expect(err.fatal).toBe(true);
    expect(err.message).toMatch(/Limite gratuito do Groq/);
    expect(err.retryAt).toBeGreaterThan(Date.now() + 3_700_000);
    expect(calls).toBe(1);
  });

  it("pedido grande demais para o nível gratuito: pede para dividir o lote", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ error: { message: "Request too large for model. Max size: 8000 tokens." } }), { status: 413 }),
    );
    const res = await client().complete(req);
    expect(res.stopReason).toBe("max_tokens");
  });

  it("poucas tentativas no cliente: limite por minuto 2 vezes, servidor fora do ar 1 vez (depois o rodízio passa a vez)", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "Rate limit reached on requests per minute (RPM). Please try again in 0.01s." } }), {
        status: 429,
      });
    });
    const limited = await client()
      .complete(req)
      .catch((e) => e);
    expect(limited).toMatchObject({ code: "quota" });
    expect(calls).toBe(3);

    calls = 0;
    vi.useFakeTimers();
    vi.stubGlobal("fetch", async () => {
      calls++;
      return new Response("{}", { status: 503 });
    });
    const pending = client()
      .complete(req)
      .catch((e) => e);
    await vi.advanceTimersByTimeAsync(16_000);
    vi.useRealTimers();
    expect(await pending).toMatchObject({ code: "server", fatal: false });
    expect(calls).toBe(2);
  });

  it("Retry-After longo (acima de 2 min): não tenta de novo agora e diz até quando esperar", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return new Response(JSON.stringify({ message: "Rate limit exceeded" }), { status: 429, headers: { "retry-after": "3600" } });
    });
    const err = await new FreeOpenAIClient("mistral", "m", "k", {
      label: "Mistral",
      baseUrl: "https://x.test/v1",
      maxOutputTokens: 8192,
      rateFallback: "rate_limit",
    })
      .complete(req)
      .catch((e) => e);
    expect(err).toMatchObject({ code: "rate_limit", fatal: true });
    expect(err.retryAt).toBeGreaterThan(Date.now() + 3_500_000);
    expect(calls).toBe(1);
  });

  it("402 (pede um plano pago) é falha da conta, não do pedido", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 402 }));
    const err = await client()
      .complete(req)
      .catch((e) => e);
    expect(err).toMatchObject({ code: "model", fatal: true });
    expect(err.message).toMatch(/plano pago/);
  });

  it("a espera entre tentativas não segura a fila do serviço: outro livro faz o pedido dele enquanto isso", async () => {
    const order: string[] = [];
    let n = 0;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const who = JSON.parse(String(init.body)).messages[1].content as string;
      order.push(`${who}${++n}`);
      // o primeiro pedido do livro A bate no limite por minuto (espera de 0,3 s)
      if (n === 1)
        return new Response(JSON.stringify({ error: { message: "Rate limit reached on requests per minute (RPM). Please try again in 0.3s." } }), {
          status: 429,
        });
      return sse(`ok ${who}`);
    });
    const provider = createProvider("groq", { groqApiKey: "k" });
    const llm = (provider as unknown as { llm: { complete: (r: typeof req) => Promise<{ text: string }> } }).llm;
    const done: string[] = [];
    const a = llm.complete({ ...req, user: "A" }).then(() => done.push("A"));
    await new Promise((r) => setTimeout(r, 50));
    const b = llm.complete({ ...req, user: "B" }).then(() => done.push("B"));
    await Promise.all([a, b]);
    // B entrou na fila durante a espera de A (antes, a vaga de A ficava presa até A terminar)
    expect(order).toEqual(["A1", "B2", "A3"]);
    expect(done).toEqual(["B", "A"]);
    // os pedidos deste teste não contam nos “créditos grátis de hoje” dos próximos
    await fsp.rm(path.join(config.dataDir, "usage.json"), { force: true });
  });

  it("chave recusada é fatal e diz onde corrigir", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 401 }));
    const err = await client()
      .complete(req)
      .catch((e) => e);
    expect(err.code).toBe("auth");
    expect(err.message).toMatch(/Ajustes/);
  });
});

describe("créditos grátis de hoje", () => {
  it("conta os pedidos e marca a cota esgotada (sem trocar de serviço)", async () => {
    // ajuste antigo com o Llama (encerrado no plano grátis): passa a usar o GPT-OSS 120B
    const settings = { groqApiKey: "k", groqModel: "llama-3.3-70b-versatile" };
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      if (calls <= 2) return sse('<seg id="1">Olá</seg>');
      return new Response(JSON.stringify({ error: { message: "Rate limit reached on requests per day (RPD). Please try again in 2h." } }), {
        status: 429,
      });
    });
    const provider = createProvider("groq", settings);
    expect(provider.paid).toBe(false);
    expect(provider.id).toBe("groq");
    const input = {
      book: {
        title: "t",
        author: "a",
        sourceLanguage: "English",
        targetLanguage: "Portuguese",
        targetCode: "pt-BR",
        options: { dialogueStyle: "target" as const, deepContext: false },
      },
      glossary: [],
      storySoFar: [],
      chapterTitle: "c",
      preceding: [],
      segments: [{ id: 1, text: "Hello" }],
    };
    await provider.translateBatch(input);
    await provider.translateBatch(input);
    expect(provider.model).toBe("openai/gpt-oss-120b");
    let q = await quotaFor("groq", "openai/gpt-oss-120b");
    expect(q.used).toBe(2);
    expect(q.exhaustedUntil).toBeNull();
    await expect(provider.translateBatch(input)).rejects.toMatchObject({ code: "quota" });
    q = await quotaFor("groq", "openai/gpt-oss-120b");
    expect(q.exhaustedUntil).not.toBeNull();
    expect(q.remaining).toBe(0);
  });
});
