"use client";

/** Chamada à API do próprio app, com mensagens de erro legíveis. */
export async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...(rest.headers ?? {}) },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
      cache: "no-store",
    });
  } catch (err) {
    // pedido cancelado de propósito: segue como está
    if ((err as Error)?.name === "AbortError") throw err;
    // sem internet ou servidor fora do ar: o navegador só diz "Failed to fetch"
    throw new Error("Sem conexão com o servidor. Confira a internet e tente de novo.");
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  // só a senha do próprio app (resposta em JSON) leva à tela de entrar; o painel tem a própria tela
  if (res.status === 401 && data && typeof window !== "undefined" && !url.startsWith("/api/auth") && !url.startsWith("/api/admin/auth")) {
    const login = url.startsWith("/api/admin/") ? "/admin/entrar" : "/entrar";
    window.location.href = `${login}?de=${encodeURIComponent(window.location.pathname)}`;
  }
  if (!res.ok) throw new Error(data?.error ?? "Algo deu errado. Tente novamente.");
  // resposta sem JSON (ex.: página de login do Codespaces no lugar da API): conexão perdida
  if (!data) throw new Error("Sem conexão com o servidor. Recarregue a página.");
  return data;
}
