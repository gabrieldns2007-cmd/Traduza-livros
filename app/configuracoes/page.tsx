import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SettingsForm } from "@/components/settings/settings-form";
import { PUBLIC_MODE } from "@/lib/mode";

export const metadata: Metadata = { title: "Configurações" };

export default function SettingsPage() {
  // no servidor próprio os ajustes da loja ficam no painel; o pedido tem as preferências de cada livro
  if (!PUBLIC_MODE) redirect("/");
  return (
    <main className="mx-auto w-full max-w-[42rem] px-5 pt-8 pb-24 sm:px-8 sm:pt-14">
      <h1 className="rise serif text-[2.6rem] leading-none font-[380] tracking-[-0.035em] text-ink sm:text-[3.4rem]">Configurações</h1>
      <SettingsForm />
    </main>
  );
}
