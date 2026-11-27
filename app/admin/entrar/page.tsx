import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "@/app/entrar/login-form";
import { adminProtected } from "@/services/admin/access";
import { CreatePassword } from "./create-password";

export const metadata: Metadata = { title: "Painel" };
export const dynamic = "force-dynamic";

export default async function AdminLoginPage() {
  const hasPassword = await adminProtected();
  return (
    <main className="mx-auto flex min-h-[70dvh] w-full max-w-[24rem] flex-col justify-center px-6 pb-20">
      <p className="label">Painel administrativo</p>
      {hasPassword ? (
        <>
          <p className="serif mt-4 text-[1.5rem] leading-snug text-ink">Só para quem administra o Verso.</p>
          <Suspense>
            <LoginForm endpoint="/api/admin/auth" fallback="/admin" />
          </Suspense>
        </>
      ) : (
        <>
          <p className="serif mt-4 text-[1.5rem] leading-snug text-ink">Crie a senha do painel.</p>
          <p className="mt-2 mb-6 text-[0.9375rem] leading-relaxed text-ink-2">
            O painel fica fechado até existir uma senha. Você só faz isso uma vez; depois ela é pedida em cada aparelho novo.
          </p>
          <CreatePassword />
        </>
      )}
    </main>
  );
}
