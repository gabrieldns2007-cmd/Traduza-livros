"use client";

import { PasswordForm } from "@/components/admin/store-settings";

/** Primeiro acesso: cria a senha e já entra no painel. */
export function CreatePassword() {
  return <PasswordForm mode="create" onDone={() => (window.location.href = "/admin")} />;
}
