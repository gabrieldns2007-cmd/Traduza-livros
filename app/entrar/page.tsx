import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Entrar" };

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[24rem] flex-col justify-center px-6 pb-20">
      <p className="serif text-[2rem] leading-none tracking-[-0.02em] text-ink">
        Verso<span className="text-accent">.</span>
      </p>
      <p className="serif mt-6 text-[1.25rem] leading-snug text-ink-2">Esta estante é particular.</p>
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
