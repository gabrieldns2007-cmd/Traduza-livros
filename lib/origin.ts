/**
 * Endereço público do site, para links de volta do pagamento. Atrás de um
 * proxy (Codespaces, Railway…) o endereço da requisição é interno, então
 * usa SITE_URL ou os cabeçalhos x-forwarded-*.
 */
export function publicOrigin(request: Request): string {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/+$/, "");
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (host) {
    const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
    return `${proto}://${host}`;
  }
  return new URL(request.url).origin;
}
