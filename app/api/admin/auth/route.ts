import { NextResponse } from "next/server";
import { ADMIN_COOKIE } from "@/lib/auth";
import { adminCookieOptions, adminSessionToken, verifyAdminPassword } from "@/services/admin/access";

const attempts = new Map<string, { n: number; until: number }>();

/** Entrada no painel administrativo. */
export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const a = attempts.get(ip);
  if (a && a.until > Date.now()) return NextResponse.json({ error: "Muitas tentativas. Aguarde um minuto." }, { status: 429 });
  const body = (await request.json().catch(() => ({}))) as { password?: string };
  if (!(await verifyAdminPassword(String(body.password ?? "")))) {
    const n = (a?.n ?? 0) + 1;
    attempts.set(ip, { n, until: n >= 5 ? Date.now() + 60_000 : 0 });
    return NextResponse.json({ error: "Senha incorreta." }, { status: 401 });
  }
  attempts.delete(ip);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, await adminSessionToken(), adminCookieOptions(request));
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(ADMIN_COOKIE);
  return res;
}
