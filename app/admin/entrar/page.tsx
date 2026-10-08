import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "@/app/entrar/login-form";

export const metadata: Metadata = { title: "Painel" };

export default function AdminLoginPage() {
  return (
    <main className="mx-auto flex min-h-[70dvh] w-full max-w-[24rem] flex-col justify-center px-6 pb-20">
      <p className="label">Painel administrativo</p>
      <p className="serif mt-4 text-[1.5rem] leading-snug text-ink">Só para quem administra o Verso.</p>
      <Suspense>
        <LoginForm endpoint="/api/admin/auth" fallback="/admin" />
      </Suspense>
    </main>
  );
}
