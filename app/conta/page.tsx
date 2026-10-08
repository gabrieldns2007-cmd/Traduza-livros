import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { PUBLIC_MODE } from "@/lib/mode";
import { AccountView } from "@/components/public/account-view";

export const metadata: Metadata = { title: "Minha conta" };

export default function AccountPage() {
  if (!PUBLIC_MODE) notFound();
  return <AccountView />;
}
