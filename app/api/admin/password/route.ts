import { NextResponse } from "next/server";
import { ADMIN_COOKIE } from "@/lib/auth";
import { adminCookieOptions, adminSessionToken, setAdminPassword } from "@/services/admin/access";

/**
 * Cria (primeiro acesso) ou troca a senha do painel. A rota fica atrás do
 * proxy: depois que existe senha, só quem já entrou no painel chega aqui.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { password?: string };
  try {
    await setAdminPassword(String(body.password ?? ""));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
  // quem criou a senha já fica dentro do painel neste aparelho
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, await adminSessionToken(), adminCookieOptions(request));
  return res;
}
