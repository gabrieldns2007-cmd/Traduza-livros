/**
 * Ritmo dos serviços gratuitos, para o processo inteiro: todos os livros, as
 * análises e as prévias passam pela mesma fila de cada “serviço|modelo”.
 *
 *  - um pedido por vez em cada serviço gratuito (a cota é da conta, não do livro);
 *  - um intervalo mínimo entre o início de dois pedidos, tirado do limite por
 *    minuto publicado (ou de um valor conservador quando o serviço não publica);
 *  - no Groq, também o limite de tokens por minuto (entrada + saída).
 *
 * Os valores podem ser trocados por variáveis de ambiente (ex.: GEMINI_RPM=5).
 * As esperas podem ser canceladas (pausa ou exclusão do livro). As contas de tempo
 * usam o relógio monotônico (performance.now()): acertar o relógio do servidor
 * nunca prende nem libera a fila antes da hora.
 */

export interface Pace {
  /** pedidos ao mesmo tempo */
  concurrency: number;
  /** pedidos por minuto (intervalo mínimo entre inícios = 60 s / rpm) */
  rpm: number;
  /** tokens por minuto (entrada + saída), quando o serviço publica */
  tpm?: number;
}

/**
 * Padrões: Groq publica 30 pedidos e 8 mil tokens por minuto no plano grátis; a
 * Cloudflare publica 300 por minuto para texto (usamos no máximo 60); o Google e a
 * Mistral não publicam os números do nível gratuito — valores conservadores.
 */
const DEFAULTS: Record<string, Pace> = {
  gemini: { concurrency: 1, rpm: 10 },
  groq: { concurrency: 1, rpm: 30, tpm: 8000 },
  cloudflare: { concurrency: 1, rpm: 60 },
  mistral: { concurrency: 1, rpm: 20 },
};
const FALLBACK: Pace = { concurrency: 1, rpm: 20 };

function envNumber(name: string): number | undefined {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

export function paceFor(provider: string): Pace {
  const base = DEFAULTS[provider] ?? FALLBACK;
  const prefix = provider.toUpperCase();
  const tpm = envNumber(`${prefix}_TPM`) ?? base.tpm;
  return {
    concurrency: base.concurrency,
    rpm: envNumber(`${prefix}_RPM`) ?? base.rpm,
    ...(tpm ? { tpm } : {}),
  };
}

interface Waiter {
  tokens: number;
  resolve: () => void;
  reject: (err: unknown) => void;
  cleanup: () => void;
}

interface Gate {
  provider: string;
  active: number;
  /** início do último pedido (relógio monotônico, ms) */
  lastStart: number;
  waiters: Waiter[];
  timer: ReturnType<typeof setTimeout> | null;
  /** tokens usados no último minuto (relógio monotônico, ms) */
  window: { at: number; tokens: number }[];
}

/** Relógio monotônico (ms): só anda para a frente, mesmo se o relógio do sistema for acertado. */
const clock = () => performance.now();

const g = globalThis as unknown as { __versoGates?: Map<string, Gate> };
const gates: Map<string, Gate> = g.__versoGates ?? (g.__versoGates = new Map());

function gateOf(provider: string, model: string): Gate {
  const key = `${provider}|${model}`;
  let gate = gates.get(key);
  if (!gate) {
    // nenhum pedido ainda: o primeiro não espera (o relógio monotônico começa perto de zero)
    gate = { provider, active: 0, lastStart: -Infinity, waiters: [], timer: null, window: [] };
    gates.set(key, gate);
  }
  return gate;
}

/** Quanto falta (ms) para o próximo pedido poder começar, pelo ritmo e pelos tokens do último minuto. */
function waitMs(gate: Gate, pace: Pace, tokens: number, now: number): number {
  let wait = Math.max(0, gate.lastStart + Math.ceil(60_000 / pace.rpm) - now);
  if (pace.tpm) {
    gate.window = gate.window.filter((w) => w.at > now - 60_000);
    let used = gate.window.reduce((n, w) => n + w.tokens, 0);
    // um pedido maior que o limite inteiro passa sozinho (senão nunca passaria)
    for (const w of gate.window) {
      if (used === 0 || used + tokens <= pace.tpm) break;
      wait = Math.max(wait, w.at + 60_000 - now);
      used -= w.tokens;
    }
  }
  return wait;
}

function pump(gate: Gate) {
  if (gate.timer) return;
  while (gate.waiters.length) {
    const pace = paceFor(gate.provider);
    if (gate.active >= pace.concurrency) return; // quem terminar chama de novo
    const now = clock();
    const next = gate.waiters[0];
    const wait = waitMs(gate, pace, next.tokens, now);
    if (wait > 0) {
      gate.timer = setTimeout(() => {
        gate.timer = null;
        pump(gate);
      }, wait);
      (gate.timer as { unref?: () => void }).unref?.();
      return;
    }
    gate.waiters.shift();
    next.cleanup();
    gate.active++;
    gate.lastStart = now;
    next.resolve();
  }
}

/**
 * Espera a vez de fazer um pedido a um serviço gratuito. Devolve a função que
 * libera a vaga ao terminar, com os tokens que o pedido de fato usou.
 * `tokens`: estimativa de entrada + saída (só conta onde há limite de tokens).
 */
export function acquire(
  provider: string,
  model: string,
  opts: { signal?: AbortSignal; tokens?: number } = {},
): Promise<(usedTokens?: number) => void> {
  const gate = gateOf(provider, model);
  const { signal } = opts;
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise((resolve, reject) => {
    let released = false;
    const release = (usedTokens = 0) => {
      if (released) return;
      released = true;
      gate.active = Math.max(0, gate.active - 1);
      if (usedTokens > 0) gate.window.push({ at: clock(), tokens: usedTokens });
      pump(gate);
    };
    const onAbort = () => {
      const i = gate.waiters.indexOf(waiter);
      if (i >= 0) gate.waiters.splice(i, 1);
      reject(signal?.reason ?? new Error("aborted"));
      // quem estava atrás pode andar
      if (gate.timer && !gate.waiters.length) {
        clearTimeout(gate.timer);
        gate.timer = null;
      }
      pump(gate);
    };
    const waiter: Waiter = {
      tokens: Math.max(0, opts.tokens ?? 0),
      resolve: () => resolve(release),
      reject,
      cleanup: () => signal?.removeEventListener("abort", onAbort),
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    gate.waiters.push(waiter);
    pump(gate);
  });
}

/** Faz um pedido respeitando o ritmo do serviço. `usedTokens` lê os tokens da resposta. */
export async function withLimit<T>(
  provider: string,
  model: string,
  fn: () => Promise<T>,
  opts: { signal?: AbortSignal; tokens?: number; usedTokens?: (result: T) => number } = {},
): Promise<T> {
  const release = await acquire(provider, model, opts);
  let used = 0;
  try {
    const result = await fn();
    used = opts.usedTokens?.(result) ?? 0;
    return result;
  } finally {
    release(used);
  }
}

/** Só para testes: esquece filas e ritmos. */
export function resetLimiter() {
  for (const gate of gates.values()) if (gate.timer) clearTimeout(gate.timer);
  gates.clear();
}
