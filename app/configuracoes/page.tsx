import type { Metadata } from "next";
import { SettingsForm } from "@/components/settings/settings-form";

export const metadata: Metadata = { title: "Configurações" };

export default function SettingsPage() {
  return (
    <main className="mx-auto w-full max-w-[42rem] px-5 pt-8 pb-24 sm:px-8 sm:pt-14">
      <h1 className="rise serif text-[2.6rem] leading-none font-[380] tracking-[-0.035em] text-ink sm:text-[3.4rem]">Configurações</h1>
      <SettingsForm />
    </main>
  );
}
