import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, authEnabled, isValidSession } from "@/lib/auth";
import { PUBLIC_MODE } from "@/lib/mode";

/** Exige a senha (se APP_PASSWORD estiver definida) em todas as páginas e rotas da API. */
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
  if (!authEnabled()) return NextResponse.next();
  const { pathname } = request.nextUrl;
  if (pathname === "/entrar" || pathname === "/api/auth") return NextResponse.next();
  if (await isValidSession(request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Acesso protegido por senha." }, { status: 401 });
  }
  const url = request.nextUrl.clone();
  url.pathname = "/entrar";
  url.search = pathname !== "/" ? `?de=${encodeURIComponent(pathname)}` : "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|manifest.webmanifest|fonts/).*)"],
};
