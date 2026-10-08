import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { PUBLIC_MODE } from "@/lib/mode";
import { CheckoutView } from "@/components/commerce/checkout-view";

export const metadata: Metadata = { title: "Pagamento" };

export default async function CheckoutPage({ params }: { params: Promise<{ id: string }> }) {
  if (PUBLIC_MODE) notFound();
  const { id } = await params;
  return <CheckoutView bookId={id} />;
}
