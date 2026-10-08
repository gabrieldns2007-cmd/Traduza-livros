/**
 * De quem é cada livro. O serviço não tem contas: cada navegador recebe um
 * identificador aleatório (cookie httpOnly) e os livros enviados por ele ficam
 * ligados a esse identificador. Um cliente nunca vê os livros de outro; o
 * administrador (painel) vê todos. Livros antigos, sem dono, só o painel vê.
 */
import path from "node:path";
import { config } from "@/lib/config";
import { readJson } from "@/lib/storage";
import { isValidBookId } from "@/lib/storage";
import { isAdminToken } from "@/services/admin/access";

export const OWNER_COOKIE = "verso_owner";
export const OWNER_MAX_AGE = 60 * 60 * 24 * 730;

export function newOwnerId(): string {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function isOwnerId(v: string | undefined): v is string {
  return Boolean(v && /^[a-f0-9]{24}$/.test(v));
}

/** Dono gravado no livro: string, null (livro sem dono) ou undefined (livro não existe). */
async function ownerOf(bookId: string): Promise<string | null | undefined> {
  if (!isValidBookId(bookId)) return undefined;
  const meta = await readJson<{ ownerId?: string }>(path.join(config.dataDir, "books", bookId, "book.json"));
  return meta ? (meta.ownerId ?? null) : undefined;
}

/** Pode abrir este livro? (o painel pode tudo; livro inexistente segue para o 404 da rota) */
export async function canSeeBook(bookId: string, owner: string | undefined, adminCookie: string | undefined): Promise<boolean> {
  if (await isAdminToken(adminCookie)) return true;
  const o = await ownerOf(bookId);
  if (o === undefined) return true;
  return Boolean(o) && o === owner;
}

/** Só os livros deste navegador (ou todos, para o administrador). */
export async function visibleTo<T extends { ownerId?: string }>(
  books: T[],
  owner: string | undefined,
  adminCookie: string | undefined,
): Promise<T[]> {
  if (await isAdminToken(adminCookie)) return books;
  return owner ? books.filter((b) => b.ownerId === owner) : [];
}

/** Lê um cookie do cabeçalho de uma requisição comum. */
export function cookieOf(request: Request, name: string): string | undefined {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(request.headers.get("cookie") ?? "");
  return m ? decodeURIComponent(m[1]) : undefined;
}
