"use client";

/** Chamada à API do próprio app, com mensagens de erro legíveis. */
export async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(url, {
    ...rest,
    headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (res.status === 401 && typeof window !== "undefined" && !url.startsWith("/api/auth")) {
    window.location.href = `/entrar?de=${encodeURIComponent(window.location.pathname)}`;
  }
  if (!res.ok) throw new Error(data.error ?? "Algo deu errado. Tente novamente.");
  return data;
}
