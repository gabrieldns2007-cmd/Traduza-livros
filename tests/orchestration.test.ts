/**
 * Tradução grátis com vários serviços gratuitos em rodízio automático:
 *  - cota, servidor fora do ar ou chave recusada: passa para o próximo gratuito,
 *    do mesmo ponto, sem perder nada — e nunca para um serviço pago;
 *  - disjuntor (saúde de cada serviço) guardado em disco; ritmo comum a todos os livros;
 *  - todos fora: espera e continua sozinha (com hora marcada, ou cada vez mais tarde);
 *  - a Literária só usa serviços pagos, e só com pedido pago;
 *  - Cloudflare e Mistral: os códigos de erro de cada um; Groq sem o Llama encerrado;
 *  - cada trecho guarda quem o traduziu.
 * Nada aqui chama um serviço de verdade: provedores falsos e fetch simulado.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

// as esperas do processador e dos clientes (15 s, 30 s…) viram milissegundos neste arquivo
vi.mock("@/utils/async", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/utils/async")>();
  return { ...mod, sleep: (ms: number, signal?: AbortSignal) => mod.sleep(Math.min(ms, 5), signal) };
});

// guarda o `engine` que o motor passa ao processador em cada grupo de capítulos
const seen = vi.hoisted(() => ({ engines: [] as (string | undefined)[] }));
vi.mock("@/services/processing/chapter-processor", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/services/processing/chapter-processor")>();
  return {
    ...mod,
    processChapters: (...args: Parameters<typeof mod.processChapters>) => {
      seen.engines.push(args[3].engine);
      return mod.processChapters(...args);
    },
  };
});

// segura a anotação de uma falha no disjuntor (para pausar bem no meio do rodízio); sem `gate`, passa direto
const hold = vi.hoisted(() => ({ entered: null as null | (() => void), gate: null as null | Promise<void> }));
vi.mock("@/services/providers/health", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/services/providers/health")>();
  return {
    ...mod,
    recordFailure: async (...args: Parameters<typeof mod.recordFailure>) => {
      hold.entered?.();
      if (hold.gate) await hold.gate;
      return mod.recordFailure(...args);
    },
  };
});

import { writeEpub } from "@/services/export/epub-writer";
import { importBook } from "@/services/parsing/import-book";
import { config, GROQ_MODELS, providerConfigs, type ProviderSettings } from "@/lib/config";
import { DEFAULT_SETTINGS, readSettings, store, writeSettings, type Settings } from "@/lib/storage";
import { jobRunner, markForReview, WAIT_FIRST_MS } from "@/services/processing/job-runner";
import { DEFAULT_ROUTING, levelOffered, routeProvider } from "@/services/commerce/routing";
import { nextMonthUtc, nextUtcMidnight, quotaFor, recordExhausted } from "@/services/quota/usage";
import {
  blockedUntil,
  clearProvider,
  FATAL_OPEN_MS,
  MAX_BLOCK_MS,
  MIN_COOLDOWN_MS,
  recordFailure,
  recordSuccess,
  snapshot,
} from "@/services/providers/health";
import { acquire, resetLimiter } from "@/services/providers/limiter";
import { createProvider } from "@/services/translation";
import { ProviderError, type ProviderErrorCode } from "@/services/translation/llm/types";
import type { BatchInput, BatchOutput, TranslationProvider } from "@/services/translation/translation-provider";
import { GET as customerGet } from "@/app/api/settings/route";
import { GET as adminGet, POST as adminPost, PUT as adminPut } from "@/app/api/admin/settings/route";
import { PATCH as chapterPatch, POST as chapterPost } from "@/app/api/books/[id]/chapters/[chapterId]/route";
import { POST as translatePost } from "@/app/api/books/[id]/translate/route";

/* ---------------------------------------------------------------- apoio */

const KEYS: ProviderSettings = {
  geminiApiKey: "chave-gemini",
  groqApiKey: "chave-groq",
  cloudflareAccountId: "conta123",
  cloudflareApiToken: "token-cf",
  mistralApiKey: "chave-mistral",
};
const WITH_KEYS: Settings = { ...DEFAULT_SETTINGS, ...KEYS };
const model = (id: string, s: ProviderSettings = WITH_KEYS) => providerConfigs(s).find((p) => p.id === id)!.model;

type Failure = { code: ProviderErrorCode; fatal: boolean; after?: number; retryAt?: number };

/** Uma “tradução” de verdade dos trechos do livro de teste (passa na conferência de qualidade). */
function pt(src: string): string {
  const p = /Paragraph (\d+) of chapter (\d+)/.exec(src);
  if (p) return `Parágrafo ${p[1]} do capítulo ${p[2]}: o faroleiro acendeu a lâmpada outra vez esta noite.`;
  const c = /Chapter (\d+)/.exec(src);
  return c ? `Capítulo ${c[1]}` : "O faroleiro";
}

class Fake implements TranslationProvider {
  paid = false;
  limits = { batchChars: 800, concurrency: 1 };
  calls = 0;
  failures = 0;
  constructor(
    public id: string,
    public model: string,
    private failure?: Failure,
  ) {}
  async analyzeBook() {
    return { profile: { genre: "", tone: "", narrativeVoice: "", styleNotes: "" }, glossary: [], tocTranslations: [] };
  }
  async analyzeChapter() {
    return { summary: "", newTerms: [] };
  }
  async translateBatch(input: BatchInput): Promise<BatchOutput> {
    if (this.failure && this.calls >= (this.failure.after ?? 0)) {
      this.failures++;
      throw new ProviderError(`falha de teste (${this.failure.code})`, {
        fatal: this.failure.fatal,
        code: this.failure.code,
        retryAt: this.failure.retryAt,
      });
    }
    this.calls++;
    return {
      translations: new Map(input.segments.map((s) => [s.id, pt(s.text)])),
      truncated: false,
      refused: false,
      usage: { inputTokens: 10, outputTokens: 10 },
    };
  }
}

/** Fábrica que nunca cria um serviço que o teste não previu. */
function factory(fakes: Record<string, TranslationProvider>) {
  return (id: string) => {
    const f = fakes[id];
    if (!f) throw new Error(`o teste não previa o serviço ${id}`);
    return f;
  };
}

async function book(chapters = 4) {
  const epub = await writeEpub({
    title: "The Keeper",
    language: "en",
    chapters: Array.from({ length: chapters }, (_, i) => ({
      title: `Chapter ${i + 1}`,
      body: Array.from({ length: 8 }, (_, j) => `<p>Paragraph ${j + 1} of chapter ${i + 1}: the keeper lit the lamp again tonight.</p>`).join(""),
    })),
  });
  return (await importBook(epub, { fileName: "keeper.epub", targetLanguage: "pt-BR" })).id;
}

/** Livro com pedido da tradução grátis (o tipo é o que importa para o motor). */
async function freeBook(chapters = 4) {
  const id = await book(chapters);
  await store.update(id, (m) => {
    m.level = "padrao";
  });
  return id;
}

async function until(bookId: string, statuses: string[], ms = 15_000) {
  for (let t = 0; t < ms; t += 20) {
    const m = (await store.get(bookId))!;
    if (statuses.includes(m.status) && !jobRunner.isRunning(bookId) && jobRunner.queuePosition(bookId) < 0) return m;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout esperando ${statuses.join("/")}: ${(await store.get(bookId))?.status}`);
}

/**
 * Diretório de dados só deste teste: salvar uma chave nova no painel acorda os livros
 * da Grátis à espera — os de outros testes ficam de fora.
 */
async function isolatedData() {
  const before = process.env.DATA_DIR;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "verso-isolado-"));
  onTestFinished(() => {
    process.env.DATA_DIR = before;
  });
  await writeSettings(WITH_KEYS);
}

type Internals = { timers: Map<string, ReturnType<typeof setTimeout>>; scheduleResume(id: string, at: number): void };
const internals = (runner = jobRunner) => runner as unknown as Internals;
function dropTimer(id: string, runner = jobRunner) {
  clearTimeout(internals(runner).timers.get(id));
  internals(runner).timers.delete(id);
}

const put = (body: unknown) =>
  new Request("http://x/api/admin/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function sse(text: string) {
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}`,
    "data: [DONE]",
    "",
  ].join("\n");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const batchInput = {
  book: {
    title: "t",
    author: "a",
    sourceLanguage: "English",
    targetLanguage: "Brazilian Portuguese",
    targetCode: "pt-BR",
    options: { dialogueStyle: "target" as const, deepContext: false },
  },
  glossary: [],
  storySoFar: [],
  chapterTitle: "c",
  preceding: [],
  segments: [{ id: 1, text: "Hello there, my friend." }],
};

beforeAll(() => {
  // sem a espera entre pedidos nos testes com fetch simulado (o ritmo tem teste próprio)
  for (const k of ["GEMINI_RPM", "GROQ_RPM", "CLOUDFLARE_RPM", "MISTRAL_RPM"]) process.env[k] = "600000";
});

beforeEach(async () => {
  await fsp.rm(path.join(config.dataDir, "usage.json"), { force: true });
  await fsp.rm(path.join(config.dataDir, "health.json"), { force: true });
  await writeSettings(WITH_KEYS);
  seen.engines.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetLimiter();
  hold.entered = null;
  hold.gate = null;
});

/* ---------------------------------------------------------------- rodízio */

describe("rodízio entre os serviços gratuitos", () => {
  it("cota, servidor fora do ar e chave recusada: Gemini → Groq → Cloudflare → Mistral, sem perder nada", async () => {
    const fakes = {
      gemini: new Fake("gemini", model("gemini"), { code: "quota", fatal: true, after: 1 }),
      groq: new Fake("groq", model("groq"), { code: "server", fatal: false }),
      cloudflare: new Fake("cloudflare", model("cloudflare"), { code: "auth", fatal: true }),
      mistral: new Fake("mistral", model("mistral")),
    };
    jobRunner.providerFactory = factory(fakes);
    const id = await freeBook(4);
    await jobRunner.start(id);
    const m = await until(id, ["done", "paused", "error"]);

    expect(m.status).toBe("done");
    expect(m.runs!.filter((r) => r.kind === "translation").map((r) => r.provider)).toEqual(["gemini", "groq", "cloudflare", "mistral"]);
    expect(fakes.gemini.calls).toBe(1);
    // servidor fora do ar: o processador tentou de novo (6 vezes) antes de passar a vez
    expect(fakes.groq.failures).toBe(7);
    expect(fakes.cloudflare.failures).toBe(1);
    expect(m.progress.translatedSegments).toBe(m.totals.segments);

    // cada falha ficou anotada para todos os livros
    expect((await quotaFor("gemini", model("gemini"))).exhaustedUntil).not.toBeNull();
    const health = await snapshot();
    const groq = health.find((h) => h.provider === "groq")!;
    expect(groq.state).toBe("cooldown");
    // quem acabou de falhar descansa pelo menos 1 minuto: o rodízio não volta nele na hora
    expect(Date.parse(groq.blockedUntil!)).toBeGreaterThan(Date.now() + MIN_COOLDOWN_MS - 10_000);
    const cf = health.find((h) => h.provider === "cloudflare")!;
    expect(cf.kind).toBe("fatal");
    expect(Date.parse(cf.blockedUntil!)).toBeGreaterThan(Date.now() + FATAL_OPEN_MS - 60_000);

    // quem traduziu: o motor passa o “engine” e cada trecho guarda o seu
    expect(seen.engines).toContain(`gemini/${model("gemini")}`);
    expect(seen.engines).toContain(`mistral/${model("mistral")}`);
    const by = new Map<string, number>();
    for (const d of m.docs) {
      const doc = await store.readDoc(id, d.id);
      for (const s of doc.segments) {
        if (s.out === undefined || !/\p{L}/u.test(s.src)) continue;
        expect(s.out).toBe(pt(s.src));
        by.set(s.by ?? "(sem)", (by.get(s.by ?? "(sem)") ?? 0) + 1);
      }
    }
    expect([...by.keys()].sort()).toEqual([`gemini/${model("gemini")}`, `mistral/${model("mistral")}`].sort());
    // o capítulo é de quem gravou o primeiro trecho dele
    expect(m.chapters[0].provider).toBe("gemini");
    expect(m.chapters.at(-1)!.provider).toBe("mistral");
  });

  it("retomada prefere quem começou o capítulo pela metade", async () => {
    const fakes = { gemini: new Fake("gemini", model("gemini")), groq: new Fake("groq", model("groq")) };
    jobRunner.providerFactory = factory(fakes);
    const id = await freeBook(2);
    // o Groq traduziu o começo do primeiro capítulo
    await store.update(id, (m) => {
      m.chapters[0].provider = "groq";
      m.chapters[0].model = model("groq");
    });
    const meta = (await store.get(id))!;
    await store.updateDoc(id, meta.chapters[0].docId, (doc) => {
      const s = doc.segments[meta.chapters[0].start];
      s.out = "já traduzido";
      s.by = `groq/${model("groq")}`;
    });
    await jobRunner.start(id);
    const m = await until(id, ["done", "paused", "error"]);
    expect(m.status).toBe("done");
    expect(m.runs!.find((r) => r.kind === "translation")!.provider).toBe("groq");
  });

  it("só um gratuito configurado e ele falha: espera e continua sozinha (nunca fica em erro)", async () => {
    await writeSettings({ ...DEFAULT_SETTINGS, groqApiKey: "chave-groq" });
    const groq = new Fake("groq", model("groq"), { code: "network", fatal: false });
    jobRunner.providerFactory = factory({ groq });
    const id = await freeBook(1);
    await jobRunner.start(id);
    const m = await until(id, ["paused", "error", "done"]);
    dropTimer(id);
    expect(m.status).toBe("paused");
    expect(m.stopCode).toBe("waiting");
    // volta quando o disjuntor do Groq deixa (1 minuto)
    const at = Date.parse(m.resumeAt!);
    expect(at).toBeGreaterThan(Date.now() + 30_000);
    expect(at).toBeLessThan(Date.now() + MIN_COOLDOWN_MS + 5_000);
  });

  it("trava contra trocas sem fim: no máximo 2 trocas por serviço gratuito, depois espera", async () => {
    // o serviço falha mas a falha fica anotada com outro modelo (o rodízio não “vê”): sem a trava, giraria para sempre
    const gemini = new Fake("gemini", "outro-modelo", { code: "server", fatal: false });
    jobRunner.providerFactory = factory({ gemini });
    const id = await freeBook(1);
    await jobRunner.start(id);
    const m = await until(id, ["paused", "error", "done"], 30_000);
    dropTimer(id);
    const limit = DEFAULT_ROUTING.padrao.length * 2;
    expect(m.status).toBe("paused");
    expect(m.stopCode).toBe("waiting");
    expect(m.runs!.filter((r) => r.kind === "translation")).toHaveLength(limit + 1);
    expect(gemini.failures).toBe((limit + 1) * 7);
    const at = Date.parse(m.resumeAt!);
    expect(Math.abs(at - (Date.now() + WAIT_FIRST_MS))).toBeLessThan(60_000);
  });
});

/* ---------------------------------------------------------------- esperas */

describe("todos fora: espera e continua sozinha", () => {
  it("cotas esgotadas: pausa com a hora da primeira que volta e continua no horário", async () => {
    const fakes = Object.fromEntries(["gemini", "groq", "cloudflare", "mistral"].map((p) => [p, new Fake(p, model(p))]));
    jobRunner.providerFactory = factory(fakes);
    for (const p of ["gemini", "groq", "cloudflare", "mistral"])
      await recordExhausted(p as "gemini", model(p), Date.now() + (p === "groq" ? 1200 : 3_600_000));
    const id = await freeBook(1);
    await jobRunner.start(id);
    const waiting = await until(id, ["paused", "done", "error"]);
    expect(waiting.status).toBe("paused");
    expect(waiting.stopCode).toBe("waiting");
    expect(Math.abs(Date.parse(waiting.resumeAt!) - (Date.now() + 1200))).toBeLessThan(1500);
    const done = await until(id, ["done"], 15_000);
    expect(done.runs!.find((r) => r.kind === "translation")!.provider).toBe("groq");
  }, 25_000);

  it("disjuntores abertos: a hora de volta é a do primeiro serviço que pode ser testado de novo", async () => {
    jobRunner.providerFactory = factory({});
    for (const p of ["gemini", "groq", "cloudflare", "mistral"]) await recordFailure(p, model(p), { code: "server", fatal: false });
    const id = await freeBook(1);
    await jobRunner.start(id);
    const m = await until(id, ["paused", "done", "error"]);
    expect(internals().timers.has(id)).toBe(true);
    dropTimer(id);
    expect(m.stopCode).toBe("waiting");
    expect(Math.abs(Date.parse(m.resumeAt!) - (Date.now() + MIN_COOLDOWN_MS))).toBeLessThan(5_000);
  });

  it("sem hora conhecida (nenhum serviço pronto): tenta de novo em 15 min, depois 30… e continua quando dá", async () => {
    await writeSettings({ ...DEFAULT_SETTINGS });
    const gemini = new Fake("gemini", model("gemini"));
    jobRunner.providerFactory = factory({ gemini });
    const id = await freeBook(1);

    await jobRunner.start(id);
    let m = await until(id, ["paused", "done", "error"]);
    expect(m.stopCode).toBe("waiting"); // nunca “unavailable” na grátis: sempre volta sozinha
    expect(Math.abs(Date.parse(m.resumeAt!) - (Date.now() + WAIT_FIRST_MS))).toBeLessThan(5_000);
    expect(internals().timers.has(id)).toBe(true);

    await jobRunner.start(id);
    m = await until(id, ["paused", "done", "error"]);
    expect(Math.abs(Date.parse(m.resumeAt!) - (Date.now() + 2 * WAIT_FIRST_MS))).toBeLessThan(5_000);

    // o dono salvou uma chave; quando a hora chega, o temporizador retoma sozinho
    await writeSettings(WITH_KEYS);
    internals().scheduleResume(id, Date.now() - 10_000);
    m = await until(id, ["done"], 10_000);
    expect(gemini.calls).toBeGreaterThan(0);
  });

  it("depois de reiniciar o servidor: as esperas voltam a ser agendadas (e a versão antiga ganha hora)", async () => {
    const before = process.env.DATA_DIR;
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "verso-reinicio-"));
    onTestFinished(() => {
      process.env.DATA_DIR = before;
    });
    await writeSettings(WITH_KEYS);
    const waiting = await freeBook(1);
    const legacy = await freeBook(1);
    const resumeAt = new Date(Date.now() + 2 * 3600_000).toISOString();
    await store.update(waiting, (m) => void Object.assign(m, { status: "paused", stopCode: "waiting", resumeAt }));
    await store.update(legacy, (m) => void Object.assign(m, { status: "paused", stopCode: "unavailable", resumeAt: undefined }));

    // um processo novo (como depois de um reinício) lê tudo do disco
    const Runner = jobRunner.constructor as new () => typeof jobRunner;
    const fresh = new Runner();
    await fresh.init();
    expect(internals(fresh).timers.has(waiting)).toBe(true);
    expect(internals(fresh).timers.has(legacy)).toBe(true);
    dropTimer(waiting, fresh);
    dropTimer(legacy, fresh);
    const m = (await store.get(legacy))!;
    expect(m.stopCode).toBe("waiting");
    expect(Math.abs(Date.parse(m.resumeAt!) - (Date.now() + WAIT_FIRST_MS))).toBeLessThan(5_000);
    expect((await store.get(waiting))!.resumeAt).toBe(resumeAt);
  });

  it("pausar de propósito cancela a volta automática", async () => {
    await writeSettings({ ...DEFAULT_SETTINGS });
    jobRunner.providerFactory = factory({});
    const id = await freeBook(1);
    await jobRunner.start(id);
    await until(id, ["paused"]);
    expect(internals().timers.has(id)).toBe(true);
    await jobRunner.pause(id);
    expect(internals().timers.has(id)).toBe(false);
    const m = (await store.get(id))!;
    expect(m.stopCode).toBeUndefined();
    expect(m.resumeAt).toBeUndefined();
  });

  it("“continuar” num livro que já está traduzindo não volta para a fila nem reinicia nada", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    class Slow extends Fake {
      async translateBatch(input: BatchInput) {
        await gate;
        return super.translateBatch(input);
      }
    }
    const gemini = new Slow("gemini", model("gemini"));
    jobRunner.providerFactory = factory({ gemini });
    const id = await freeBook(1);
    await jobRunner.start(id);
    for (let i = 0; i < 200 && (await store.get(id))!.status !== "translating"; i++) await new Promise((r) => setTimeout(r, 10));
    expect((await store.get(id))!.status).toBe("translating");
    await jobRunner.start(id);
    expect((await store.get(id))!.status).toBe("translating");
    expect(jobRunner.queuePosition(id)).toBe(-1);
    release();
    const m = await until(id, ["done", "paused", "error"]);
    expect(m.status).toBe("done");
    expect(m.runs!.filter((r) => r.kind === "translation")).toHaveLength(1);
  });
});

/* ---------------------------------------------------------------- disjuntor e ritmo */

describe("disjuntor (saúde de cada serviço)", () => {
  it("abre depois de 3 falhas seguidas, testa de novo, reabre por mais tempo e fecha com uma resposta", async () => {
    const t0 = Date.now();
    expect(await recordFailure("groq", "m", { code: "server", fatal: false }, t0)).toBe(t0 + MIN_COOLDOWN_MS);
    expect(await blockedUntil("groq", "m", t0 + 1000)).toBe(t0 + MIN_COOLDOWN_MS);
    expect((await snapshot(t0 + 1000))[0].state).toBe("cooldown");
    expect(await blockedUntil("groq", "m", t0 + MIN_COOLDOWN_MS + 1)).toBeNull();

    await recordFailure("groq", "m", { code: "network", fatal: false }, t0 + 61_000);
    const third = await recordFailure("groq", "m", { code: "rate_limit", fatal: false }, t0 + 122_000);
    expect(third).toBe(t0 + 122_000 + 2 * 60_000); // aberto: 2 min
    expect((await snapshot(t0 + 130_000))[0].state).toBe("open");
    expect((await snapshot(third + 1))[0].state).toBe("half_open");
    // o teste (meio aberto) falhou: reabre pelo dobro
    expect(await recordFailure("groq", "m", { code: "server", fatal: false }, third + 1)).toBe(third + 1 + 4 * 60_000);
    // nunca mais que 60 min
    let t = third + 1;
    for (let i = 0; i < 10; i++) t = await recordFailure("groq", "m", { code: "server", fatal: false }, t + 1);
    expect(await blockedUntil("groq", "m", t - 60 * 60_000 + 1)).toBe(t);

    await recordSuccess("groq", "m");
    expect(await blockedUntil("groq", "m")).toBeNull();
    expect(await snapshot()).toEqual([]);
  });

  it("chave ou modelo recusados: 6 h, até o dono salvar chave ou modelo novos", async () => {
    await isolatedData();
    const t0 = Date.now();
    expect(await recordFailure("cloudflare", "x", { code: "model", fatal: true, message: "exige plano pago" }, t0)).toBe(t0 + FATAL_OPEN_MS);
    expect((await snapshot())[0]).toMatchObject({ provider: "cloudflare", model: "x", state: "open", kind: "fatal", lastError: "exige plano pago" });
    await clearProvider("cloudflare");
    expect(await blockedUntil("cloudflare", "x")).toBeNull();

    // salvar uma chave nova no painel esquece as falhas daquele serviço
    await recordFailure("mistral", model("mistral"), { code: "auth", fatal: true });
    expect(await blockedUntil("mistral", model("mistral"))).not.toBeNull();
    expect((await adminPut(put({ mistralApiKey: "chave-nova" }))).status).toBe(200);
    expect(await blockedUntil("mistral", model("mistral"))).toBeNull();
  });

  it("fica guardado em disco (sobrevive a um reinício)", async () => {
    await recordFailure("gemini", "g", { code: "server", fatal: false });
    const raw = JSON.parse(await fsp.readFile(path.join(config.dataDir, "health.json"), "utf8"));
    expect(raw["gemini|g"].consecutive).toBe(1);
    vi.resetModules();
    const again = await import("@/services/providers/health");
    expect(await again.blockedUntil("gemini", "g")).not.toBeNull();
  });

  it("o rodízio pula quem está com o disjuntor aberto e devolve a hora mais cedo", async () => {
    const until = await recordFailure("gemini", model("gemini"), { code: "server", fatal: false });
    const route = await routeProvider("padrao", WITH_KEYS);
    expect(route.ok && route.provider.id).toBe("groq");
    for (const p of ["groq", "cloudflare", "mistral"]) await recordFailure(p, model(p), { code: "auth", fatal: true });
    const none = await routeProvider("padrao", WITH_KEYS);
    expect(none).toMatchObject({ ok: false, reason: "quota", retryAt: until });
  });
});

describe("ritmo comum a todos os livros (limitador)", () => {
  it("um pedido por vez em cada serviço|modelo e o intervalo do limite por minuto", async () => {
    vi.useFakeTimers();
    process.env.GROQ_RPM = "30"; // um início a cada 2 s
    onTestFinished(() => {
      process.env.GROQ_RPM = "600000";
    });
    const first = await acquire("groq", "m");
    let second = false;
    const p2 = acquire("groq", "m").then((r) => {
      second = true;
      return r;
    });
    // outro modelo tem a própria fila
    const other = await acquire("groq", "outro");
    other();
    await vi.advanceTimersByTimeAsync(1000);
    expect(second).toBe(false); // o primeiro ainda não terminou
    first();
    await vi.advanceTimersByTimeAsync(500);
    expect(second).toBe(false); // terminou, mas só se passaram 1,5 s desde que começou
    await vi.advanceTimersByTimeAsync(600);
    expect(second).toBe(true);
    (await p2)();
  });

  it("limite de tokens por minuto (Groq) e espera cancelável", async () => {
    vi.useFakeTimers();
    process.env.GROQ_TPM = "1000";
    onTestFinished(() => {
      delete process.env.GROQ_TPM;
    });
    const a = await acquire("groq", "t", { tokens: 600 });
    a(600);
    let b = false;
    const pb = acquire("groq", "t", { tokens: 600 }).then((r) => {
      b = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(b).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(b).toBe(true);
    const held = await pb;
    const controller = new AbortController();
    const pc = acquire("groq", "t", { signal: controller.signal });
    controller.abort(new Error("pausado"));
    await expect(pc).rejects.toThrow("pausado");
    held(0);
  });

  it("dois livros no mesmo serviço gratuito: os pedidos de verdade nunca se sobrepõem", async () => {
    let inFlight = 0;
    let max = 0;
    vi.stubGlobal("fetch", async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return sse('<seg id="1">Olá, meu amigo.</seg>');
    });
    const a = createProvider("groq", WITH_KEYS);
    const b = createProvider("groq", WITH_KEYS);
    await Promise.all([a.translateBatch(batchInput), b.translateBatch(batchInput), a.translateBatch(batchInput)]);
    expect(max).toBe(1);
  });
});

/* ---------------------------------------------------------------- modalidades */

describe("grátis e Literária nunca se misturam", () => {
  it("a grátis nunca usa um serviço pago, mesmo se ele estiver na lista do painel", async () => {
    const before = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-teste";
    onTestFinished(() => {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = before;
    });
    expect((await routeProvider("padrao", { ...WITH_KEYS, routing: { padrao: ["anthropic", "openai"] } })).ok).toBe(false);
    expect(levelOffered("padrao", { ...WITH_KEYS, routing: { padrao: ["anthropic"] } })).toBe(false);
    const r = await routeProvider("padrao", { ...WITH_KEYS, routing: { padrao: ["anthropic", "mistral"] } });
    expect(r.ok && r.provider.id).toBe("mistral");
    // todos os gratuitos sem cota: espera, não cai no pago
    for (const p of ["gemini", "groq", "cloudflare", "mistral"]) await recordExhausted(p as "gemini", model(p), Date.now() + 60_000);
    const later = await routeProvider("padrao", { ...WITH_KEYS, routing: { padrao: ["gemini", "anthropic", "groq", "cloudflare", "mistral"] } });
    expect(later.ok).toBe(false);

    // o painel não consegue salvar uma lista misturada
    const res = await adminPut(put({ routing: { padrao: ["gemini", "anthropic"] } }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/Grátis só pode usar serviços gratuitos/);
    expect((await readSettings()).routing?.padrao).toBeUndefined();
  });

  it("se a fábrica entregasse um serviço pago para a grátis, nada é enviado (erro interno claro)", async () => {
    const paid = new Fake("gemini", model("gemini"));
    paid.paid = true;
    jobRunner.providerFactory = factory({ gemini: paid });
    const id = await freeBook(1);
    await jobRunner.start(id);
    const m = await until(id, ["paused", "error", "done"]);
    expect(m.status).toBe("paused");
    expect(m.stopCode).toBe("modality");
    expect(m.error).toMatch(/Erro interno/);
    expect(paid.calls + paid.failures).toBe(0);
  });

  it("a Literária só usa pagos: nunca um gratuito, e só com pedido pago", async () => {
    const before = process.env.ANTHROPIC_API_KEY;
    onTestFinished(() => {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = before;
    });
    delete process.env.ANTHROPIC_API_KEY;
    const s: Settings = { ...WITH_KEYS, offerLiteraria: true, routing: { literaria: ["gemini", "anthropic"] } };
    expect((await routeProvider("literaria", s)).ok).toBe(false);
    expect(levelOffered("literaria", s)).toBe(false);
    process.env.ANTHROPIC_API_KEY = "sk-teste";
    const r = await routeProvider("literaria", s);
    expect(r.ok && r.provider.id).toBe("anthropic");
    const res = await adminPut(put({ routing: { literaria: ["anthropic", "groq"] } }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/Literária só pode usar serviços pagos/);

    await writeSettings({ ...WITH_KEYS, offerLiteraria: true });
    const anthropic = new Fake("anthropic", "claude-opus-5-5");
    anthropic.paid = true;
    const gemini = new Fake("gemini", model("gemini"));
    jobRunner.providerFactory = factory({ anthropic, gemini });
    const id = await book(1);
    // pedido ainda não pago: o serviço pago não é chamado
    await store.update(id, (m) => {
      m.level = "literaria";
      m.order = {
        id: "ord_1",
        level: "literaria",
        words: m.totals.words,
        priceBrl: 9.9,
        status: "awaiting_payment",
        payment: null,
        createdAt: m.createdAt,
      };
    });
    await jobRunner.start(id);
    let m = await until(id, ["paused", "error", "done"]);
    expect(m.stopCode).toBe("unpaid");
    expect(anthropic.calls).toBe(0);
    // pago: traduz com o pago (e nunca com o gratuito, mesmo se o pago falhar)
    await store.update(id, (x) => {
      x.order!.status = "paid";
    });
    await jobRunner.start(id);
    m = await until(id, ["paused", "error", "done"]);
    expect(m.status).toBe("done");
    expect(anthropic.calls).toBeGreaterThan(0);
    expect(gemini.calls).toBe(0);

    // a fábrica entregando um gratuito para a Literária: nada é enviado
    const id2 = await book(1);
    await store.update(id2, (x) => {
      x.level = "literaria";
      x.order = {
        id: "ord_2",
        level: "literaria",
        words: x.totals.words,
        priceBrl: 9.9,
        status: "paid",
        payment: "provider",
        createdAt: x.createdAt,
      };
    });
    jobRunner.providerFactory = factory({ anthropic: gemini });
    await jobRunner.start(id2);
    m = await until(id2, ["paused", "error", "done"]);
    expect(m.stopCode).toBe("modality");
    expect(gemini.calls).toBe(0);
  });

  it("retraduzir um capítulo de um livro antigo com serviço pago: segue na grátis, sem chamar o pago", async () => {
    const before = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-teste";
    onTestFinished(() => {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = before;
    });
    const anthropic = new Fake("anthropic", "claude-opus-5-5");
    anthropic.paid = true;
    const gemini = new Fake("gemini", model("gemini"));
    jobRunner.providerFactory = factory({ anthropic, gemini });
    const id = await book(1);
    await store.update(id, (m) => {
      m.status = "done";
      m.provider = { id: "anthropic", model: "claude-opus-5-5" };
    });
    const chapterId = (await store.get(id))!.chapters[0].id;
    const res = await chapterPost(
      new Request(`http://x/api/books/${id}/chapters/${chapterId}`, { method: "POST", body: JSON.stringify({ action: "retranslate" }) }),
      { params: Promise.resolve({ id, chapterId }) },
    );
    expect(res.status).toBe(200);
    const m = await until(id, ["done", "paused", "error"]);
    expect(m.status).toBe("done");
    expect(m.level).toBe("padrao");
    expect(anthropic.calls).toBe(0);
    expect(gemini.calls).toBeGreaterThan(0);

    // e um livro sem tipo com serviço pago, sem pedido pago: o motor recusa antes de chamar
    const old = await book(1);
    await store.update(old, (x) => {
      x.provider = { id: "anthropic", model: "claude-opus-5-5" };
    });
    await jobRunner.start(old);
    const stopped = await until(old, ["paused", "error", "done"]);
    expect(stopped.stopCode).toBe("unpaid");
    expect(anthropic.calls).toBe(0);
  });

  it("a amostra grátis nunca usa um serviço pago", async () => {
    const before = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-teste";
    onTestFinished(() => {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = before;
    });
    const anthropic = new Fake("anthropic", "claude-opus-5-5");
    anthropic.paid = true;
    jobRunner.providerFactory = factory({ anthropic });
    const id = await book(1);
    await expect(jobRunner.preview(id, "anthropic")).rejects.toThrow(/não usa serviços pagos/);
    expect(anthropic.calls).toBe(0);
  });
});

/* ---------------------------------------------------------------- serviços novos */

describe("Cloudflare Workers AI", () => {
  const settings = { ...DEFAULT_SETTINGS, cloudflareAccountId: "conta123", cloudflareApiToken: "token-cf" };
  const cfError = (status: number, code: number, message: string) =>
    new Response(JSON.stringify({ success: false, errors: [{ code, message }], result: null }), { status });

  it("sempre manda max_tokens, no endereço da conta, com o token", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return sse('<seg id="1">Olá, meu amigo.</seg>');
    });
    const provider = createProvider("cloudflare", settings);
    expect(provider.paid).toBe(false);
    const out = await provider.translateBatch(batchInput);
    expect(out.translations.get(1)).toBe("Olá, meu amigo.");
    expect(calls[0].url).toBe("https://api.cloudflare.com/client/v4/accounts/conta123/ai/v1/chat/completions");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer token-cf");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe("@cf/google/gemma-4-26b-a4b-it");
    expect(body.max_tokens).toBeGreaterThan(256);
    expect(body.max_tokens).toBeLessThanOrEqual(8192);
    expect((await quotaFor("cloudflare", body.model)).used).toBe(1);
  });

  it("429 + 3036: cota do dia acabou — para até a meia-noite UTC", async () => {
    vi.stubGlobal("fetch", async () => cfError(429, 3036, "You have used up your daily free allocation of 10,000 neurons."));
    const err = await createProvider("cloudflare", settings)
      .translateBatch(batchInput)
      .catch((e) => e);
    expect(err).toMatchObject({ code: "quota", fatal: true, retryAt: nextUtcMidnight() });
    expect((await quotaFor("cloudflare", model("cloudflare", settings))).exhaustedUntil).toBe(new Date(nextUtcMidnight()).toISOString());
  });

  it("429 + 3040: sem capacidade agora — espera, tenta de novo e, se não passar, é passageiro", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return cfError(429, 3040, "Capacity temporarily exceeded, please try again.");
    });
    const waits: number[] = [];
    const err = await createProvider("cloudflare", settings)
      .translateBatch({ ...batchInput, onWait: (ms) => waits.push(ms) })
      .catch((e) => e);
    expect(err).toMatchObject({ code: "rate_limit", fatal: false });
    // poucas tentativas no próprio cliente (2): depois, o rodízio passa a outro serviço gratuito
    expect(calls).toBe(3);
    expect(waits).toHaveLength(2);
    // passageiro não marca a cota como esgotada
    expect((await quotaFor("cloudflare", model("cloudflare", settings))).exhaustedUntil).toBeNull();

    let n = 0;
    vi.stubGlobal("fetch", async () => (++n === 1 ? cfError(429, 3040, "Capacity temporarily exceeded") : sse('<seg id="1">Oi.</seg>')));
    expect((await createProvider("cloudflare", settings).translateBatch(batchInput)).translations.get(1)).toBe("Oi.");
  });

  it("403 + 5035: o modelo exige o plano pago — erro de modelo (nunca paga)", async () => {
    vi.stubGlobal("fetch", async () => cfError(403, 5035, "This model requires a Workers Paid plan."));
    const err = await createProvider("cloudflare", { ...settings, cloudflareModel: "@cf/openai/gpt-oss-120b" })
      .translateBatch(batchInput)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ code: "model", fatal: true });
    expect(err.message).toMatch(/plano pago/);
  });

  it("raciocínio no texto (<think>) não entra na tradução", async () => {
    vi.stubGlobal("fetch", async () => sse('<think>vou traduzir <seg id="1">rascunho</seg></think><seg id="1">Olá, meu amigo.</seg>'));
    expect((await createProvider("cloudflare", settings).translateBatch(batchInput)).translations.get(1)).toBe("Olá, meu amigo.");
    vi.stubGlobal("fetch", async () => sse('<seg id="1">Olá.</seg><think>e se eu'));
    expect((await createProvider("cloudflare", settings).translateBatch(batchInput)).translations.get(1)).toBe("Olá.");
  });
});

describe("Mistral (modo Free)", () => {
  const settings = { ...DEFAULT_SETTINGS, mistralApiKey: "chave-mistral" };

  it("402: a cota do mês acabou — para até o dia 1º", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ message: "Payment required" }), { status: 402 }));
    const err = await createProvider("mistral", settings)
      .translateBatch(batchInput)
      .catch((e) => e);
    expect(err).toMatchObject({ code: "quota", fatal: true, retryAt: nextMonthUtc() });
    expect(err.message).toMatch(/cota do mês/);
  });

  it("429 com Retry-After: espera o tempo pedido e tenta de novo; sem passar, é passageiro", async () => {
    const bodies: Record<string, unknown>[] = [];
    let n = 0;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.mistral.ai/v1/chat/completions");
      bodies.push(JSON.parse(String(init.body)));
      return ++n === 1
        ? new Response(JSON.stringify({ message: "Rate limit exceeded" }), { status: 429, headers: { "retry-after": "2" } })
        : sse('<seg id="1">Olá, meu amigo.</seg>');
    });
    const waits: number[] = [];
    const out = await createProvider("mistral", settings).translateBatch({ ...batchInput, onWait: (ms) => waits.push(ms) });
    expect(out.translations.get(1)).toBe("Olá, meu amigo.");
    expect(waits).toEqual([2500]);
    expect(bodies[0]).toMatchObject({ model: "mistral-small-latest", temperature: 0.3, stream_options: { include_usage: true } });

    vi.stubGlobal("fetch", async () => new Response("{}", { status: 429 }));
    const err = await createProvider("mistral", settings)
      .translateBatch(batchInput)
      .catch((e) => e);
    expect(err).toMatchObject({ code: "rate_limit", fatal: false });
  });

  it("análise sem response_format (o texto já pede JSON)", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return sse('{"genre":"ficção","glossary":[],"tocTranslations":[]}');
    });
    const a = await createProvider("mistral", settings).analyzeBook({ book: batchInput.book, sample: "text", tocLabels: [] });
    expect(a.profile.genre).toBe("ficção");
    expect(bodies[0].response_format).toBeUndefined();
  });
});

describe("Groq sem o Llama (encerrado no plano grátis em 16/08/2026)", () => {
  it("um ajuste antigo com o Llama usa o GPT-OSS 120B, com raciocínio curto", async () => {
    expect(GROQ_MODELS.map((m) => m.id)).toEqual(["openai/gpt-oss-120b"]);
    expect(model("groq", { groqApiKey: "k", groqModel: "llama-3.3-70b-versatile" })).toBe("openai/gpt-oss-120b");
    const env = process.env.GROQ_MODEL;
    process.env.GROQ_MODEL = "llama-3.3-70b-versatile";
    onTestFinished(() => {
      if (env === undefined) delete process.env.GROQ_MODEL;
      else process.env.GROQ_MODEL = env;
    });
    expect(model("groq", { groqApiKey: "k" })).toBe("openai/gpt-oss-120b");
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return sse('<seg id="1">Olá.</seg>');
    });
    await createProvider("groq", { groqApiKey: "k", groqModel: "llama-3.3-70b-versatile" }).translateBatch(batchInput);
    expect(bodies[0]).toMatchObject({ model: "openai/gpt-oss-120b", reasoning_effort: "low", max_tokens: 4000 });
    expect(bodies[0].temperature).toBeUndefined();
  });
});

/* ---------------------------------------------------------------- ajustes */

describe("ajustes dos serviços novos", () => {
  it("o cliente nunca recebe chaves, conta ou modelos; o painel só vê o fim da chave", async () => {
    await writeSettings({ ...WITH_KEYS, cloudflareModel: "@cf/openai/gpt-oss-120b" });
    const customer = JSON.stringify(await (await customerGet()).json());
    for (const secret of ["token-cf", "conta123", "chave-mistral", "chave-groq", "gpt-oss", "cloudflare", "mistral"])
      expect(customer).not.toContain(secret);
    const admin = (await (await adminGet()).json()) as {
      settings: Record<string, unknown>;
      free: { id: string; keyHint: string; account?: { hint: string }; ready: boolean; dataPolicy: { trains: unknown } | null }[];
    };
    expect(JSON.stringify(admin.settings)).not.toMatch(/token-cf|conta123|chave-mistral/);
    const cf = admin.free.find((f) => f.id === "cloudflare")!;
    expect(cf).toMatchObject({ keyHint: "••••n-cf", ready: true, account: { hint: "••••a123" }, dataPolicy: { trains: false } });
    expect(admin.free.find((f) => f.id === "mistral")!.dataPolicy!.trains).toBe("default");
    expect(admin.free.find((f) => f.id === "gemini")!.dataPolicy!.trains).toBe(true);
  });

  it("chave nova de um serviço gratuito entra no fim da ordem salva da grátis", async () => {
    await isolatedData();
    await writeSettings({ ...DEFAULT_SETTINGS, geminiApiKey: "g", routing: { padrao: ["gemini", "groq"] } });
    await adminPut(put({ cloudflareAccountId: "conta123" }));
    expect((await readSettings()).routing?.padrao).toEqual(["gemini", "groq"]); // só a conta: ainda não está pronto
    await adminPut(put({ cloudflareApiToken: "token-cf" }));
    expect((await readSettings()).routing?.padrao).toEqual(["gemini", "groq", "cloudflare"]);
    // o GitHub encerrado sai da lista sem erro
    expect((await adminPut(put({ routing: { padrao: ["github", "mistral", "mistral"] } }))).status).toBe(200);
    expect((await readSettings()).routing?.padrao).toEqual(["mistral"]);
    // ID da conta com caracteres estranhos: recusado
    expect((await adminPut(put({ cloudflareAccountId: "../../x" }))).status).toBe(400);
  });

  it("testar a chave: Cloudflare (pedido mínimo), Mistral (lista de modelos), GitHub (nada é chamado)", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      if (url.includes("cloudflare"))
        return new Response(JSON.stringify({ errors: [{ code: 5035, message: "This model requires a Workers Paid plan." }] }), { status: 403 });
      return Response.json({ data: [{ id: "mistral-small-2603", aliases: ["mistral-small-latest"] }] });
    });
    const test = async (service: string) =>
      (await (await adminPost(new Request("http://x", { method: "POST", body: JSON.stringify({ service }) }))).json()) as {
        ok: boolean;
        message?: string;
      };
    expect(await test("cloudflare")).toMatchObject({ ok: false, message: expect.stringMatching(/plano pago/) });
    expect(await test("mistral")).toEqual({ ok: true });
    await writeSettings({ ...WITH_KEYS, githubToken: "antigo" });
    expect(await test("github")).toMatchObject({ ok: false, message: expect.stringMatching(/encerrou/) });
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe("https://api.cloudflare.com/client/v4/accounts/conta123/ai/v1/chat/completions");
    expect(urls[1]).toBe("https://api.mistral.ai/v1/models");
  });
});

/* ---------------------------------------------------------------- correções do motor */

const translateReq = (body: unknown) =>
  new Request("http://x/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Erro do Groq quando o modelo não consegue escrever JSON válido no modo JSON. */
const jsonFailed = () =>
  new Response(
    JSON.stringify({
      error: {
        message: "Failed to generate JSON. Please adjust your prompt. See 'failed_generation' for more details.",
        type: "invalid_request_error",
        code: "json_validate_failed",
      },
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );

describe("pedido recusado (400) não é falha da conta", () => {
  it("o disjuntor só fecha por 6 h com falha da conta (chave, modelo, plano, região); um 400 é passageiro", async () => {
    const t0 = Date.now();
    expect(await recordFailure("groq", "a", { code: "bad_request", fatal: true }, t0)).toBe(t0 + MIN_COOLDOWN_MS);
    expect((await snapshot(t0)).find((h) => h.model === "a")).toMatchObject({ kind: "transient", state: "cooldown" });
    expect(await recordFailure("groq", "b", { code: "auth", fatal: true }, t0)).toBe(t0 + FATAL_OPEN_MS);
    expect(await recordFailure("groq", "c", { code: "model", fatal: true }, t0)).toBe(t0 + FATAL_OPEN_MS);
    expect(await recordFailure("groq", "d", { code: "other", fatal: true }, t0)).toBe(t0 + MIN_COOLDOWN_MS);
  });

  it("Groq: JSON inválido no modo JSON — repete uma vez sem o modo JSON", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      return body.response_format ? jsonFailed() : sse('{"genre":"ficção","tone":"sóbrio","glossary":[],"tocTranslations":[]}');
    });
    const a = await createProvider("groq", WITH_KEYS).analyzeBook({ book: batchInput.book, sample: "text", tocLabels: [] });
    expect(a.profile.genre).toBe("ficção");
    expect(bodies).toHaveLength(2);
    expect(bodies[0].response_format).toEqual({ type: "json_object" });
    expect(bodies[1].response_format).toBeUndefined();
  });

  it("Groq recusando todo pedido com 400: a análise segue sem perfil e o Groq descansa 1 minuto — não 6 h para todos", async () => {
    await writeSettings({ ...DEFAULT_SETTINGS, groqApiKey: "chave-groq" });
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return jsonFailed();
    });
    jobRunner.providerFactory = (id, s) => createProvider(id, s);
    const id = await freeBook(1);
    await jobRunner.start(id);
    const m = await until(id, ["paused", "error", "done"]);
    dropTimer(id);
    // análise com e sem o modo JSON, e depois o primeiro lote
    expect(calls).toBe(3);
    expect(m.analysisFailed).toBe(true);
    expect(m.stopCode).toBe("waiting");
    const h = (await snapshot()).find((x) => x.provider === "groq")!;
    expect(h.kind).toBe("transient");
    expect(Date.parse(h.blockedUntil!)).toBeLessThan(Date.now() + 2 * 60_000);
    expect(Date.parse(m.resumeAt!)).toBeLessThan(Date.now() + 2 * 60_000);
  });

  it("um 400 num lote passa a vez para o próximo gratuito, e o serviço continua valendo para os outros livros", async () => {
    const fakes = {
      gemini: new Fake("gemini", model("gemini"), { code: "bad_request", fatal: true }),
      groq: new Fake("groq", model("groq")),
    };
    jobRunner.providerFactory = factory(fakes);
    const id = await freeBook(2);
    await jobRunner.start(id);
    const m = await until(id, ["done", "paused", "error"]);
    expect(m.status).toBe("done");
    expect(fakes.gemini.failures).toBe(1); // fatal para o pedido: o processador não insiste
    const back = await blockedUntil("gemini", model("gemini"));
    expect(back).not.toBeNull();
    expect(back!).toBeLessThan(Date.now() + 2 * 60_000);
  });

  it("análise do livro recusada (400): o livro é traduzido sem perfil, com o mesmo serviço", async () => {
    class NoAnalysis extends Fake {
      async analyzeBook(): Promise<never> {
        throw new ProviderError("O Groq respondeu com erro 400: Failed to generate JSON", { fatal: true, code: "bad_request" });
      }
    }
    const groq = new NoAnalysis("groq", model("groq"));
    jobRunner.providerFactory = factory({ gemini: groq, groq });
    const id = await freeBook(1);
    await jobRunner.start(id);
    const m = await until(id, ["done", "paused", "error"]);
    expect(m.status).toBe("done");
    expect(m.analysisFailed).toBe(true);
    expect(m.runs!.filter((r) => r.kind === "translation")).toHaveLength(1);
  });

  it("análise que gastou tokens e não serviu: o gasto entra no livro e no registro da execução", async () => {
    class Costly extends Fake {
      async analyzeBook(): Promise<never> {
        throw Object.assign(new ProviderError("A análise do livro veio cortada.", { fatal: false, code: "other" }), {
          usage: { inputTokens: 500, outputTokens: 700 },
        });
      }
    }
    jobRunner.providerFactory = factory({ gemini: new Costly("gemini", model("gemini")) });
    const id = await freeBook(1);
    await jobRunner.start(id);
    const m = await until(id, ["done", "paused", "error"]);
    expect(m.status).toBe("done");
    expect(m.usage.inputTokens).toBeGreaterThanOrEqual(500);
    expect(m.usage.outputTokens).toBeGreaterThanOrEqual(700);
    const run = m.runs!.find((r) => r.kind === "translation")!;
    expect(run.inputTokens).toBeGreaterThanOrEqual(500);
    expect(run.outputTokens).toBeGreaterThanOrEqual(700);
  });
});

describe("esperas e retomadas", () => {
  it("serviço com a conta recusada (6 h) e outro sem cota até o mês que vem: volta na hora do primeiro; chave nova acorda o livro", async () => {
    await isolatedData();
    await writeSettings({ ...DEFAULT_SETTINGS, geminiApiKey: "g", mistralApiKey: "m" });
    const mistral = new Fake("mistral", model("mistral"), { code: "quota", fatal: true, retryAt: nextMonthUtc() });
    jobRunner.providerFactory = factory({ gemini: new Fake("gemini", model("gemini"), { code: "auth", fatal: true }), mistral });
    const id = await freeBook(1);
    await jobRunner.start(id);
    const m = await until(id, ["paused", "error", "done"]);
    expect(m.stopCode).toBe("waiting");
    const geminiBack = (await blockedUntil("gemini", model("gemini")))!;
    expect(geminiBack).toBeGreaterThan(Date.now() + FATAL_OPEN_MS - 60_000);
    // o Gemini volta a ser testado em 6 h: o livro não dorme até o mês que vem
    expect(Math.abs(Date.parse(m.resumeAt!) - Math.min(geminiBack, nextMonthUtc()))).toBeLessThan(5_000);

    // o dono salva uma chave nova do Gemini: o livro tenta de novo agora, sem esperar a hora marcada
    const good = new Fake("gemini", model("gemini"));
    jobRunner.providerFactory = factory({ gemini: good, mistral });
    expect((await adminPut(put({ geminiApiKey: "chave-nova" }))).status).toBe(200);
    const done = await until(id, ["done"], 10_000);
    expect(done.status).toBe("done");
    expect(good.calls).toBeGreaterThan(0);
  });

  it("Retry-After longo (Mistral, 1 h): nenhuma nova tentativa agora, e o serviço descansa até a hora pedida", async () => {
    await writeSettings({ ...DEFAULT_SETTINGS, mistralApiKey: "m" });
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return new Response(JSON.stringify({ message: "Rate limit exceeded", type: "rate_limit_error" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "3600" },
      });
    });
    jobRunner.providerFactory = (id, s) => createProvider(id, s);
    const id = await freeBook(1);
    const t0 = Date.now();
    await jobRunner.start(id);
    const m = await until(id, ["paused", "error", "done"]);
    dropTimer(id);
    expect(calls).toBe(1);
    const back = (await blockedUntil("mistral", model("mistral", { mistralApiKey: "m" })))!;
    expect(back - t0).toBeGreaterThan(59 * 60_000);
    expect(back - t0).toBeLessThan(61 * 60_000);
    expect(Math.abs(Date.parse(m.resumeAt!) - back)).toBeLessThan(5_000);
    // e o disjuntor guarda o Retry-After mesmo fora do rodízio
    const t1 = Date.now();
    expect(await recordFailure("groq", "r", { code: "rate_limit", fatal: false, retryAt: t1 + 30 * 60_000 }, t1)).toBe(t1 + 30 * 60_000);
  });

  it("quem começou o capítulo pela metade só termina aquele capítulo; o resto do livro volta ao rodízio", async () => {
    const fakes = { gemini: new Fake("gemini", model("gemini")), mistral: new Fake("mistral", model("mistral")) };
    jobRunner.providerFactory = factory(fakes);
    const id = await freeBook(4);
    // a Mistral (última da lista) começou o capítulo 1 quando o Gemini estava sem cota
    await store.update(id, (m) => {
      m.chapters[0].provider = "mistral";
      m.chapters[0].model = model("mistral");
      m.profile = { genre: "x", tone: "", narrativeVoice: "", styleNotes: "" };
    });
    const meta = (await store.get(id))!;
    const ch = meta.chapters[0];
    await store.updateDoc(id, ch.docId, (c) => {
      for (const sg of c.segments.slice(ch.start, ch.start + 3)) {
        sg.out = pt(sg.src);
        sg.by = `mistral/${model("mistral")}`;
      }
    });
    await jobRunner.start(id);
    const done = await until(id, ["done", "paused", "error"]);
    expect(done.status).toBe("done");
    expect(done.chapters[0].provider).toBe("mistral");
    expect(done.chapters.slice(1).every((c) => c.provider === "gemini")).toBe(true);
    expect(done.runs!.filter((r) => r.kind === "translation").map((r) => r.provider)).toEqual(["mistral", "gemini"]);
  });

  it("“refazer os trechos que falharam” com a tradução em andamento: recusado, e o livro segue traduzindo", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    class Slow extends Fake {
      async translateBatch(input: BatchInput) {
        await gate;
        return super.translateBatch(input);
      }
    }
    jobRunner.providerFactory = factory({ gemini: new Slow("gemini", model("gemini")) });
    const id = await freeBook(1);
    await jobRunner.start(id);
    for (let i = 0; i < 200 && (await store.get(id))!.status !== "translating"; i++) await new Promise((r) => setTimeout(r, 10));
    const res = await translatePost(translateReq({ action: "retry-failed" }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(409);
    expect((await store.get(id))!.status).toBe("translating");
    release();
    expect((await until(id, ["done", "paused", "error"])).status).toBe("done");
  });
});

describe("pausar no meio do rodízio", () => {
  it("pausa enquanto a falha é anotada: fica pausado, o próximo serviço não é chamado", async () => {
    await writeSettings({ ...DEFAULT_SETTINGS, geminiApiKey: "g", groqApiKey: "q" });
    const fakes = { gemini: new Fake("gemini", model("gemini"), { code: "auth", fatal: true }), groq: new Fake("groq", model("groq")) };
    jobRunner.providerFactory = factory(fakes);
    const id = await freeBook(2);
    const entered = new Promise<void>((r) => (hold.entered = r));
    let open!: () => void;
    hold.gate = new Promise<void>((r) => (open = r));
    await jobRunner.start(id);
    await entered;
    await jobRunner.pause(id); // o cliente toca em “Pausar” exatamente agora
    hold.gate = null;
    open();
    const m = await until(id, ["done", "paused", "error"]);
    expect(m.status).toBe("paused");
    expect(m.stopCode).toBeUndefined();
    expect(fakes.groq.calls).toBe(0);
    expect(internals().timers.has(id)).toBe(false);
    expect(m.chapters.every((c) => c.status !== "translating")).toBe(true);
  });

  it("pausa enquanto a falha é anotada, sem outro serviço: nenhuma volta automática é agendada", async () => {
    await writeSettings({ ...DEFAULT_SETTINGS, geminiApiKey: "g" });
    jobRunner.providerFactory = factory({ gemini: new Fake("gemini", model("gemini"), { code: "server", fatal: false }) });
    const id = await freeBook(1);
    const entered = new Promise<void>((r) => (hold.entered = r));
    let open!: () => void;
    hold.gate = new Promise<void>((r) => (open = r));
    await jobRunner.start(id);
    await entered;
    await jobRunner.pause(id);
    hold.gate = null;
    open();
    const m = await until(id, ["paused", "done", "error"]);
    expect(m.status).toBe("paused");
    expect(m.stopCode).toBeUndefined();
    expect(m.resumeAt).toBeUndefined();
    expect(internals().timers.has(id)).toBe(false);
  });
});

describe("detalhes", () => {
  it("teto de saída dos serviços gratuitos nos limites (Groq 4.000; Cloudflare e Mistral 8.192)", () => {
    expect(createProvider("groq", WITH_KEYS).limits.maxOutputTokens).toBe(4000);
    expect(createProvider("cloudflare", WITH_KEYS).limits.maxOutputTokens).toBe(8192);
    expect(createProvider("mistral", WITH_KEYS).limits.maxOutputTokens).toBe(8192);
  });

  it("esperas gravadas absurdas (disjuntor e cota) valem no máximo 35 dias ao serem lidas", async () => {
    const far = Date.now() + 10 * 365 * 24 * 3600_000;
    await fsp.writeFile(
      path.join(config.dataDir, "health.json"),
      JSON.stringify({ "gemini|g": { consecutive: 0, opens: 0, blockedUntil: far, kind: "fatal", at: Date.now() } }),
    );
    const until = (await blockedUntil("gemini", "g"))!;
    expect(until).toBeLessThanOrEqual(Date.now() + MAX_BLOCK_MS);
    expect(until).toBeGreaterThan(Date.now() + MAX_BLOCK_MS - 60_000);
    expect(MAX_BLOCK_MS).toBe(35 * 24 * 3600_000);
    await recordExhausted("groq", "q", far);
    const q = await quotaFor("groq", "q");
    expect(Date.parse(q.exhaustedUntil!)).toBeLessThanOrEqual(Date.now() + MAX_BLOCK_MS);
  });

  it("cota da Cloudflare (do dia) e da Mistral (do mês) é da conta, não do modelo; no Gemini e no Groq, de cada modelo", async () => {
    await recordExhausted("cloudflare", "@cf/modelo-a", nextUtcMidnight());
    expect((await quotaFor("cloudflare", "@cf/modelo-b")).exhaustedUntil).not.toBeNull();
    await recordExhausted("mistral", "mistral-a", nextMonthUtc());
    expect((await quotaFor("mistral", "mistral-b")).exhaustedUntil).not.toBeNull();
    await recordExhausted("gemini", "gemini-a", Date.now() + 3_600_000);
    expect((await quotaFor("gemini", "gemini-b")).exhaustedUntil).toBeNull();
    // trocar o modelo da Cloudflare não traz a cota de volta: o rodízio continua pulando
    const r = await routeProvider("padrao", { ...DEFAULT_SETTINGS, cloudflareAccountId: "conta123", cloudflareApiToken: "token-cf" });
    expect(r.ok).toBe(false);
  });

  it("o ritmo usa o relógio monotônico: acertar o relógio do sistema não prende a fila", async () => {
    vi.useFakeTimers();
    process.env.GROQ_RPM = "30"; // um início a cada 2 s
    onTestFinished(() => {
      process.env.GROQ_RPM = "600000";
    });
    (await acquire("groq", "relogio"))();
    // o relógio do sistema volta 1 hora (acerto de horário): a próxima vaga ainda sai em 2 s, não em 1 h
    vi.setSystemTime(Date.now() - 3600_000);
    let second = false;
    const p = acquire("groq", "relogio").then((r) => {
      second = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(2_100);
    expect(second).toBe(true);
    (await p)();
  });

  it("revisão automática: refaz só o que ficou sem traduzir (igual, metade igual, no idioma de origem), e limpa os avisos", async () => {
    const id = await freeBook(1);
    await store.update(id, (m) => {
      m.sourceLanguage = "en";
    });
    const meta = (await store.get(id))!;
    const ch = meta.chapters[0];
    const paras = (await store.readDoc(id, ch.docId)).segments.slice(ch.start, ch.end).filter((sg) => /Paragraph/.test(sg.src));
    const [echo, partial, short, edited, good] = paras;
    await store.updateDoc(id, ch.docId, (c) => {
      const at = (i: number) => c.segments[i];
      Object.assign(at(echo.i), { out: echo.src, by: "gemini/x", warn: ["ratio"] });
      Object.assign(at(partial.i), { out: `Ontem à noite, ${partial.src}`, by: "gemini/x" });
      // curto demais (seria “length” na conferência), mas traduzido: a revisão não refaz por outros motivos
      Object.assign(at(short.i), { out: "O faroleiro.", by: "gemini/x" });
      Object.assign(at(edited.i), { out: edited.src, edited: true });
      Object.assign(at(good.i), { out: pt(good.src), by: "gemini/x" });
    });
    expect(await markForReview(id)).toBe(2);
    const doc = await store.readDoc(id, ch.docId);
    expect(doc.segments[echo.i]).not.toHaveProperty("out");
    expect(doc.segments[echo.i]).not.toHaveProperty("warn");
    expect(doc.segments[echo.i]).not.toHaveProperty("by");
    expect(doc.segments[partial.i]).not.toHaveProperty("out");
    expect(doc.segments[short.i].out).toBe("O faroleiro.");
    expect(doc.segments[edited.i].out).toBe(edited.src);
    expect(doc.segments[good.i].out).toBe(pt(good.src));
  });

  it("edição à mão: o trecho deixa de ser de um serviço de IA e perde os avisos da conferência", async () => {
    const id = await freeBook(1);
    const meta = (await store.get(id))!;
    const ch = meta.chapters[0];
    const seg = (await store.readDoc(id, ch.docId)).segments.slice(ch.start, ch.end).find((sg) => /Paragraph/.test(sg.src))!;
    await store.updateDoc(id, ch.docId, (c) => {
      Object.assign(c.segments[seg.i], { out: pt(seg.src), by: "gemini/x", warn: ["pt-PT"] });
    });
    const res = await chapterPatch(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ edits: [{ i: seg.i, nodes: [{ x: "Minha tradução." }] }] }) }),
      { params: Promise.resolve({ id, chapterId: ch.id }) },
    );
    expect(res.status).toBe(200);
    const after = (await store.readDoc(id, ch.docId)).segments[seg.i];
    expect(after).toMatchObject({ out: "Minha tradução.", edited: true });
    expect(after).not.toHaveProperty("by");
    expect(after).not.toHaveProperty("warn");
  });
});
