import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_COOKIE, SESSION_COOKIE, authEnabled, isValidSession } from "@/lib/auth";
import { PUBLIC_MODE } from "@/lib/mode";
import { adminProtected, isAdminToken } from "@/services/admin/access";
import { canSeeBook, isOwnerId, newOwnerId, OWNER_COOKIE, OWNER_MAX_AGE } from "@/services/commerce/ownership";

/**
 * Antes de cada página e rota da API:
 *  - painel administrativo: pede a senha do painel;
 *  - APP_PASSWORD (opcional): pede a senha do site;
 *  - livros: cada navegador só abre os próprios (o painel abre todos).
 */
export async function proxy(request: NextRequest) {
  // versão pública: o login é com Google e os livros ficam no navegador; o servidor
  // só entrega as páginas e o repasse sem estado — nunca guarda livros
  if (PUBLIC_MODE) {
    const { pathname } = request.nextUrl;
    if (pathname.startsWith("/api/") && !pathname.startsWith("/api/relay/")) {
      return NextResponse.json({ error: "Carregando o Verso… recarregue a página." }, { status: 503 });
    }
    return NextResponse.next();
  }
  const { pathname } = request.nextUrl;
  const adminCookie = request.cookies.get(ADMIN_COOKIE)?.value;

  // avisos do meio de pagamento: ele não tem senha nem cookie; a autenticidade é
  // conferida pela assinatura do aviso (parseWebhook)
  if (pathname.startsWith("/api/payments/webhook/")) return NextResponse.next();

  // painel administrativo: senha própria (criada no painel ou ADMIN_PASSWORD), além da do site
  const adminArea =
    (pathname === "/admin" || pathname.startsWith("/admin/") || pathname.startsWith("/api/admin/")) &&
    pathname !== "/admin/entrar" &&
    pathname !== "/api/admin/auth";
  if (adminArea && (await adminProtected()) && !(await isAdminToken(adminCookie))) {
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Acesso restrito ao administrador." }, { status: 401 });
    const url = request.nextUrl.clone();
    url.pathname = "/admin/entrar";
    url.search = "";
    return NextResponse.redirect(url);
  }

  // senha do site (opcional)
  if (authEnabled() && pathname !== "/entrar" && pathname !== "/api/auth" && !(await isValidSession(request.cookies.get(SESSION_COOKIE)?.value))) {
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Acesso protegido por senha." }, { status: 401 });
    const url = request.nextUrl.clone();
    url.pathname = "/entrar";
    url.search = pathname !== "/" ? `?de=${encodeURIComponent(pathname)}` : "";
    return NextResponse.redirect(url);
  }

  // identificador deste navegador (sem contas): os livros enviados ficam ligados a ele
  const current = request.cookies.get(OWNER_COOKIE)?.value;
  const owner = isOwnerId(current) ? current : newOwnerId();

  const book = /^\/(?:api\/books|livros)\/([^/?#]+)/.exec(pathname)?.[1];
  if (book && !(await canSeeBook(book, owner, adminCookie))) {
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Livro não encontrado." }, { status: 404 });
    const url = request.nextUrl.clone();
    url.pathname = "/livros";
    url.search = "";
    return NextResponse.redirect(url);
  }

  if (owner === current) return NextResponse.next();
  // primeira visita: cria o cookie e já o repassa para esta mesma requisição (ex.: o envio do livro)
  const headers = new Headers(request.headers);
  headers.set("cookie", [request.headers.get("cookie"), `${OWNER_COOKIE}=${owner}`].filter(Boolean).join("; "));
  const res = NextResponse.next({ request: { headers } });
  const secure = request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  res.cookies.set(OWNER_COOKIE, owner, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: OWNER_MAX_AGE });
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|manifest.webmanifest|fonts/).*)"],
};
