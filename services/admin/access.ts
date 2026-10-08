/**
 * Acesso ao painel administrativo (/admin): custos, margens, serviços de IA e
 * chaves. A senha pode vir de ADMIN_PASSWORD (.env) ou ser criada no próprio
 * painel, no primeiro acesso — guardada só como hash (PBKDF2) em
 * DATA_DIR/admin.json. Sem nenhuma das duas, o painel fica aberto e pede para
 * criar a senha.
 */
import path from "node:path";
import { config } from "@/lib/config";
import { readJson, writeAtomic } from "@/lib/storage";
import { hmac, SESSION_MAX_AGE } from "@/lib/auth";
import { serverSecret } from "@/services/secret";

interface StoredPassword {
  salt: string;
  hash: string;
  iterations: number;
  updatedAt: string;
}

const ITERATIONS = 210_000;
export const MIN_ADMIN_PASSWORD = 8;

const file = () => path.join(config.dataDir, "admin.json");

function toHex(bytes: ArrayBuffer | Uint8Array) {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string) {
  return Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
}

async function pbkdf2(password: string, salt: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromHex(salt), iterations }, key, 256);
  return toHex(bits);
}

function sameText(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const stored = () => readJson<StoredPassword>(file());

/** De onde vem a senha do painel: .env, criada no painel, ou nenhuma (painel aberto). */
export async function adminPasswordSource(): Promise<"env" | "panel" | null> {
  if (process.env.ADMIN_PASSWORD) return "env";
  return (await stored())?.hash ? "panel" : null;
}

export async function adminProtected(): Promise<boolean> {
  return (await adminPasswordSource()) !== null;
}

export async function verifyAdminPassword(candidate: string): Promise<boolean> {
  const env = process.env.ADMIN_PASSWORD;
  if (env) return sameText(await hmac("compare", candidate), await hmac("compare", env));
  const s = await stored();
  if (!s) return true;
  return sameText(await pbkdf2(candidate, s.salt, s.iterations), s.hash);
}

/** Valor do cookie do painel. Muda quando a senha muda (as sessões antigas caem). */
export async function adminSessionToken(): Promise<string> {
  const basis = process.env.ADMIN_PASSWORD ?? (await stored())?.hash ?? "";
  return hmac(await serverSecret(), `verso-admin:${basis}`);
}

export async function isAdminToken(token: string | undefined): Promise<boolean> {
  if (!(await adminProtected())) return true;
  return Boolean(token) && sameText(token!, await adminSessionToken());
}

/** Cria ou troca a senha do painel (só quando ela não vem do .env). */
export async function setAdminPassword(password: string): Promise<void> {
  if (process.env.ADMIN_PASSWORD) throw new Error("A senha do painel está definida no arquivo .env.local.");
  if (password.length < MIN_ADMIN_PASSWORD) throw new Error(`Use pelo menos ${MIN_ADMIN_PASSWORD} caracteres.`);
  const salt = toHex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const record: StoredPassword = {
    salt,
    hash: await pbkdf2(password, salt, ITERATIONS),
    iterations: ITERATIONS,
    updatedAt: new Date().toISOString(),
  };
  await writeAtomic(file(), JSON.stringify(record));
}

/** Cookie do painel numa requisição comum (rotas que não passam pelo cookies() do Next). */
export function adminCookieOf(request: Request, name: string): string | undefined {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(request.headers.get("cookie") ?? "");
  return m ? decodeURIComponent(m[1]) : undefined;
}

/** Opções do cookie do painel (seguro quando o site está em https). */
export function adminCookieOptions(request: Request) {
  const secure = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  return { httpOnly: true, sameSite: "lax" as const, secure, path: "/", maxAge: SESSION_MAX_AGE };
}
