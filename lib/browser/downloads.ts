/**
 * Versão pública: links de download (/api/…/export/…) são gerados no próprio
 * navegador. Em vez de deixar o navegador “baixar” pelo service worker (que
 * alguns celulares cancelam), o arquivo é montado aqui e salvo como blob.
 */
function filenameFrom(disposition: string | null, fallback: string): string {
  if (!disposition) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* usa o simples */
    }
  }
  return /filename="([^"]+)"/i.exec(disposition)?.[1] ?? fallback;
}

export async function downloadFromApi(href: string): Promise<void> {
  const res = await fetch(href, { cache: "no-store" });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? "Não foi possível gerar o arquivo.");
  }
  const blob = await res.blob();
  const name = filenameFrom(res.headers.get("content-disposition"), href.split("/").pop() || "livro");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Intercepta cliques em <a download href="/api/…"> no site todo. */
export function interceptDownloadLinks(): () => void {
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey) return;
    const a = (e.target as Element | null)?.closest?.("a[download]") as HTMLAnchorElement | null;
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    if (!href.startsWith("/api/")) return;
    e.preventDefault();
    a.setAttribute("aria-busy", "true");
    downloadFromApi(href)
      .catch((err: Error) => alert(err.message))
      .finally(() => a.removeAttribute("aria-busy"));
  };
  document.addEventListener("click", onClick);
  return () => document.removeEventListener("click", onClick);
}
