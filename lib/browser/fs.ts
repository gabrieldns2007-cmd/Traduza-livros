/**
 * Substituto de `node:fs` no navegador (versão pública do Verso).
 *
 * Um “sistema de arquivos” mínimo guardado no IndexedDB do próprio aparelho,
 * com as poucas funções que o armazenamento do Verso usa (lib/storage.ts e a
 * geração do PDF). Assim o mesmo código do servidor roda no navegador.
 *
 * Caminhos que começam com /__public/ são lidos da pasta public/ do site
 * (fontes do PDF), só para leitura.
 */

type Data = string | Uint8Array;

const DB_NAME = "verso-fs";
const STORE = "files";
let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => Promise<T>): Promise<T> {
  const t = (await db()).transaction(STORE, mode);
  const finished = new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error("transação cancelada"));
  });
  const result = await fn(t.objectStore(STORE));
  await finished;
  return result;
}

function norm(p: string): string {
  const parts: string[] = [];
  for (const seg of String(p).split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}

function enoent(p: string): Error {
  return Object.assign(new Error(`ENOENT: arquivo não encontrado, ${p}`), { code: "ENOENT", path: p });
}

function childRange(dir: string): IDBKeyRange {
  const prefix = dir === "/" ? "/" : `${dir}/`;
  return IDBKeyRange.bound(prefix, `${prefix}￿`);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function readPublic(p: string): Promise<Uint8Array> {
  const res = await fetch(p.replace(/^\/__public/, ""));
  if (!res.ok) throw enoent(p);
  return new Uint8Array(await res.arrayBuffer());
}

export const promises = {
  async mkdir(_p: string, _opts?: unknown): Promise<void> {
    /* pastas são implícitas */
  },

  async writeFile(p: string, data: Data): Promise<void> {
    const key = norm(p);
    // guarda uma cópia: quem chamou pode reaproveitar o buffer depois
    const value = typeof data === "string" ? data : new Uint8Array(data);
    await tx("readwrite", (s) => done(s.put(value, key)));
  },

  async readFile(p: string, enc?: BufferEncoding | { encoding?: string } | null): Promise<never> {
    const key = norm(p);
    const encoding = typeof enc === "string" ? enc : enc?.encoding;
    let value: Data | undefined = key.startsWith("/__public/")
      ? await readPublic(key)
      : await tx("readonly", (s) => done(s.get(key) as IDBRequest<Data | undefined>));
    if (value === undefined) throw enoent(key);
    if (encoding) value = typeof value === "string" ? value : decoder.decode(value);
    else if (typeof value === "string") value = encoder.encode(value);
    return value as never;
  },

  async rename(from: string, to: string): Promise<void> {
    const a = norm(from);
    const b = norm(to);
    await tx("readwrite", async (s) => {
      const value = await done(s.get(a));
      if (value === undefined) throw enoent(a);
      await done(s.put(value, b));
      await done(s.delete(a));
    });
  },

  async readdir(p: string): Promise<string[]> {
    const dir = norm(p);
    const keys = (await tx("readonly", (s) => done(s.getAllKeys(childRange(dir))))) as string[];
    const prefix = dir === "/" ? "/" : `${dir}/`;
    const names = new Set(keys.map((k) => k.slice(prefix.length).split("/")[0]).filter(Boolean));
    if (!names.size) throw enoent(dir);
    return [...names].sort();
  },

  async rm(p: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const key = norm(p);
    await tx("readwrite", async (s) => {
      await done(s.delete(key));
      if (opts?.recursive) await done(s.delete(childRange(key)));
    });
  },

  async access(p: string): Promise<void> {
    const key = norm(p);
    if (key.startsWith("/__public/")) return;
    const count = await tx("readonly", async (s) => (await done(s.count(key))) + (await done(s.count(childRange(key)))));
    if (!count) throw enoent(key);
  },

  /** Apaga tudo sob um caminho (usado em “apagar meus dados deste aparelho”). */
  async wipe(p: string): Promise<void> {
    await promises.rm(p, { recursive: true, force: true });
  },
};

export default { promises };
