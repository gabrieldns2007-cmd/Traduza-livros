import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { PUBLIC_MODE } from "@/lib/mode";
import { AdminDashboard } from "@/components/admin/admin-dashboard";

export const metadata: Metadata = { title: "Painel", robots: { index: false } };

export default function AdminPage() {
  if (PUBLIC_MODE) notFound();
  return <AdminDashboard />;
}
