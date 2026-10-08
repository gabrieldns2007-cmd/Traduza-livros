/**
 * Sessão da versão pública: quem entrou com o Google neste aparelho.
 * O Google confirma a identidade; o Verso guarda só nome, e-mail e foto,
 * para separar os livros de cada conta no mesmo aparelho.
 */
export interface VersoUser {
  /** identificador estável da conta Google */
  sub: string;
  name: string;
  email: string;
  picture?: string;
}

const KEY = "verso-session";

export function readSession(): VersoUser | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const u = JSON.parse(raw) as VersoUser;
    return u && typeof u.sub === "string" && u.sub ? u : null;
  } catch {
    return null;
  }
}

export function saveSession(u: VersoUser) {
  try {
    localStorage.setItem(KEY, JSON.stringify(u));
  } catch {
    /* modo privado: a sessão vale só nesta visita */
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignora */
  }
}

/** Lê o “cartão de identidade” (JWT) devolvido pelo botão do Google. */
export function userFromGoogleCredential(credential: string): VersoUser | null {
  try {
    const payload = credential.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      atob(payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "="))
        .split("")
        .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`)
        .join(""),
    );
    const p = JSON.parse(json) as { sub?: string; name?: string; email?: string; picture?: string; exp?: number };
    if (!p.sub) return null;
    return { sub: p.sub, name: p.name ?? p.email ?? "Leitor", email: p.email ?? "", picture: p.picture };
  } catch {
    return null;
  }
}
