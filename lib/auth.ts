/**
 * Proteção opcional por senha (APP_PASSWORD).
 *
 * Como o Verso fala com uma API paga, se ele estiver acessível pela internet
 * alguém poderia gastar seus créditos. Com APP_PASSWORD definida, todas as
 * páginas e rotas pedem a senha uma vez; o navegador guarda um cookie
 * assinado (HMAC) por 180 dias. Sem APP_PASSWORD, o app fica aberto
 * (adequado para uso local).
 */
export const SESSION_COOKIE = "verso_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 180;

async function hmac(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function authEnabled(): boolean {
  return Boolean(process.env.APP_PASSWORD);
}

export async function sessionToken(): Promise<string> {
  const password = process.env.APP_PASSWORD ?? "";
  const secret = process.env.SESSION_SECRET || password;
  return hmac(secret, `verso:${password}`);
}

export async function isValidSession(token: string | undefined): Promise<boolean> {
  if (!authEnabled()) return true;
  if (!token) return false;
  const expected = await sessionToken();
  if (token.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export async function checkPassword(candidate: string): Promise<boolean> {
  const password = process.env.APP_PASSWORD ?? "";
  if (!password) return true;
  const a = await hmac("compare", candidate);
  const b = await hmac("compare", password);
  return a === b;
}
