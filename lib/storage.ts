/**
 * Armazenamento local em disco (DATA_DIR, padrão ./data).
 *
 *   data/settings.json
 *   data/books/<id>/book.json          metadados + progresso
 *   data/books/<id>/source.epub        EPUB de origem (original ou gerado do PDF)
 *   data/books/<id>/original.pdf       quando o envio foi um PDF
 *   data/books/<id>/docs/<d>.json      segmentos de cada arquivo (origem + tradução)
 *   data/books/<id>/skeletons/<d>.xhtml
 *   data/books/<id>/glossary.json
 *   data/books/<id>/exports/…          arquivos gerados (cache)
 *
 * Sem banco de dados: para uma ferramenta pessoal, arquivos JSON bastam e
 * tornam backup/limpeza triviais. Escritas são atômicas (tmp + rename) e
 * serializadas por arquivo.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config, type ProviderSettings } from "@/lib/config";
import type { BookMeta, DocContent, GlossaryEntry } from "@/types/book";
import { KeyedMutex } from "@/utils/async";

const ID_RE = /^[a-z0-9-]{6,64}$/;
const CHAPTER_RE = /^c\d{3,5}$/;
const DOC_RE = /^d\d{3,5}$/;

export function isValidBookId(id: string): boolean {
  return ID_RE.test(id);
}

export function isValidChapterId(id: string): boolean {
  return CHAPTER_RE.test(id);
}

export function isValidDocId(id: string): boolean {
  return DOC_RE.test(id);
}

export async function writeAtomic(file: string, data: string | Uint8Array) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

class BookStore {
  private metaCache = new Map<string, BookMeta>();
  private mutex = new KeyedMutex();

  get root() {
    return path.join(config.dataDir, "books");
  }

  dir(id: string) {
    if (!isValidBookId(id)) throw new Error("id de livro inválido");
    return path.join(this.root, id);
  }

  path(id: string, ...parts: string[]) {
    return path.join(this.dir(id), ...parts);
  }

  newId(): string {
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    return `${stamp}-${randomUUID().slice(0, 8)}`;
  }

  /* ---- metadados ---- */

  async list(): Promise<BookMeta[]> {
    let ids: string[] = [];
    try {
      ids = (await fs.readdir(this.root)).filter(isValidBookId);
    } catch {
      return [];
    }
    const books = await Promise.all(ids.map((id) => this.get(id).catch(() => null)));
    return books.filter((b): b is BookMeta => !!b).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id: string): Promise<BookMeta | null> {
    if (!isValidBookId(id)) return null;
    const cached = this.metaCache.get(id);
    if (cached) return structuredClone(cached);
    const meta = await readJson<BookMeta>(this.path(id, "book.json"));
    if (meta) this.metaCache.set(id, meta);
    return meta ? structuredClone(meta) : null;
  }

  async create(meta: BookMeta) {
    await fs.mkdir(this.dir(meta.id), { recursive: true });
    await this.mutex.run(`meta:${meta.id}`, async () => {
      this.metaCache.set(meta.id, structuredClone(meta));
      await writeAtomic(this.path(meta.id, "book.json"), JSON.stringify(meta, null, 1));
    });
  }

  /** Atualiza os metadados de forma serializada. `fn` recebe uma cópia mutável. */
  async update(id: string, fn: (meta: BookMeta) => void | Promise<void>, opts: { persist?: boolean } = {}): Promise<BookMeta> {
    return this.mutex.run(`meta:${id}`, async () => {
      const current = await this.get(id);
      if (!current) throw new Error(`livro ${id} não encontrado`);
      await fn(current);
      current.updatedAt = new Date().toISOString();
      this.metaCache.set(id, structuredClone(current));
      if (opts.persist !== false) await writeAtomic(this.path(id, "book.json"), JSON.stringify(current, null, 1));
      return structuredClone(current);
    });
  }

  async flush(id: string) {
    await this.mutex.run(`meta:${id}`, async () => {
      const meta = this.metaCache.get(id);
      if (meta) await writeAtomic(this.path(id, "book.json"), JSON.stringify(meta, null, 1));
    });
  }

  async remove(id: string) {
    this.metaCache.delete(id);
    await fs.rm(this.dir(id), { recursive: true, force: true });
  }

  /* ---- arquivos binários ---- */

  async writeFile(id: string, name: string, data: Uint8Array | string) {
    await writeAtomic(this.path(id, name), data);
  }

  async readFile(id: string, name: string): Promise<Buffer> {
    return fs.readFile(this.path(id, name));
  }

  async exists(id: string, name: string): Promise<boolean> {
    try {
      await fs.access(this.path(id, name));
      return true;
    } catch {
      return false;
    }
  }

  /* ---- documentos ---- */

  async readDoc(id: string, docId: string): Promise<DocContent> {
    if (!isValidDocId(docId)) throw new Error("documento inválido");
    const c = await readJson<DocContent>(this.path(id, "docs", `${docId}.json`));
    return c ?? { tags: {}, segments: [], blocks: [] };
  }

  async writeDoc(id: string, docId: string, content: DocContent) {
    if (!isValidDocId(docId)) throw new Error("documento inválido");
    await writeAtomic(this.path(id, "docs", `${docId}.json`), JSON.stringify(content));
  }

  /** Leitura-modificação-escrita serializada (tradutor e editor podem concorrer no mesmo arquivo). */
  async updateDoc<T>(id: string, docId: string, fn: (content: DocContent) => T | Promise<T>): Promise<T> {
    return this.mutex.run(`doc:${id}:${docId}`, async () => {
      const content = await this.readDoc(id, docId);
      const result = await fn(content);
      await this.writeDoc(id, docId, content);
      return result;
    });
  }

  async readSkeleton(id: string, docId: string): Promise<string | null> {
    if (!isValidDocId(docId)) return null;
    try {
      return await fs.readFile(this.path(id, "skeletons", `${docId}.xhtml`), "utf8");
    } catch {
      return null;
    }
  }

  async writeSkeleton(id: string, docId: string, xhtml: string) {
    if (!isValidDocId(docId)) throw new Error("documento inválido");
    await writeAtomic(this.path(id, "skeletons", `${docId}.xhtml`), xhtml);
  }

  /* ---- glossário ---- */

  async readGlossary(id: string): Promise<GlossaryEntry[]> {
    return (await readJson<GlossaryEntry[]>(this.path(id, "glossary.json"))) ?? [];
  }

  async updateGlossary<T>(id: string, fn: (entries: GlossaryEntry[]) => T | Promise<T>): Promise<T> {
    return this.mutex.run(`glossary:${id}`, async () => {
      const entries = await this.readGlossary(id);
      const result = await fn(entries);
      await writeAtomic(this.path(id, "glossary.json"), JSON.stringify(entries, null, 1));
      return result;
    });
  }

  /* ---- exportações ---- */

  async clearExports(id: string) {
    await fs.rm(this.path(id, "exports"), { recursive: true, force: true });
  }
}

/* ---- preferências ---- */

/** As chaves gratuitas (Gemini, GitHub, Groq) ficam só no servidor, em data/settings.json. */
export interface Settings extends ProviderSettings {
  providerId?: string;
  targetLanguage: string;
  dialogueStyle: "target" | "source";
  deepContext: boolean;
  instructions: string;
}

export const DEFAULT_SETTINGS: Settings = {
  targetLanguage: "pt-BR",
  dialogueStyle: "target",
  deepContext: false,
  instructions: "",
};

export async function readSettings(): Promise<Settings> {
  const s = await readJson<Partial<Settings>>(path.join(config.dataDir, "settings.json"));
  return { ...DEFAULT_SETTINGS, ...(s ?? {}) };
}

export async function writeSettings(settings: Settings) {
  await writeAtomic(path.join(config.dataDir, "settings.json"), JSON.stringify(settings, null, 1));
}

// Instância única por processo (sobrevive ao hot reload em desenvolvimento).
const g = globalThis as unknown as { __versoStore?: BookStore };
export const store: BookStore = g.__versoStore ?? (g.__versoStore = new BookStore());
