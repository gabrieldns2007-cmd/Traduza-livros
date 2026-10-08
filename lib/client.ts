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
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  // só a senha do próprio app (resposta em JSON) leva à tela de entrar
  if (res.status === 401 && data && typeof window !== "undefined" && !url.startsWith("/api/auth")) {
    window.location.href = `/entrar?de=${encodeURIComponent(window.location.pathname)}`;
  }
  if (!res.ok) throw new Error(data?.error ?? "Algo deu errado. Tente novamente.");
  // resposta sem JSON (ex.: página de login do Codespaces no lugar da API): conexão perdida
  if (!data) throw new Error("Sem conexão com o servidor. Recarregue a página.");
  return data;
}
