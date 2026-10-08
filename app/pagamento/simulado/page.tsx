import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { PUBLIC_MODE } from "@/lib/mode";
import { brl } from "@/lib/money";
import { openSession } from "@/services/billing/providers/simulated";
import { SimulatedActions } from "./simulated-actions";

export const metadata: Metadata = { title: "Pagamento simulado", robots: { index: false } };

/**
 * Página de pagamento SIMULADA: faz o papel da página do meio de pagamento
 * (Mercado Pago, Stripe…) para testar a compra sem dinheiro.
 */
export default async function SimulatedCheckoutPage({ searchParams }: { searchParams: Promise<{ s?: string }> }) {
  if (PUBLIC_MODE || process.env.PAYMENT_PROVIDER !== "simulado") notFound();
  const token = (await searchParams).s ?? "";
  const session = await openSession(token);
  return (
    <main className="mx-auto w-full max-w-[30rem] px-5 pt-10 pb-24 sm:pt-16">
      <p className="rounded-2xl border border-accent/40 px-4 py-3 text-[0.875rem] leading-relaxed text-ink-2">
        <strong className="font-medium text-accent">Pagamento simulado.</strong> Ambiente de teste: nenhum dinheiro é cobrado e nenhum cartão é
        pedido. Aqui entraria a página do meio de pagamento (Pix ou cartão).
      </p>
      {!session ? (
        <p className="mt-8 text-[0.9375rem] text-ink-2">Esta sessão de pagamento expirou. Volte ao livro e tente de novo.</p>
      ) : (
        <>
          <section className="mt-8 rounded-[1.25rem] border border-rule px-5 py-6">
            <p className="label">Você está pagando</p>
            <p className="serif mt-2 text-[1.25rem] leading-snug text-ink">{session.description}</p>
            <div className="mt-5 flex items-baseline justify-between gap-4 border-t border-rule pt-4">
              <span className="text-[1rem] text-ink">Total</span>
              <span className="serif num text-[2rem] leading-none text-ink">{brl(session.amountBrl)}</span>
            </div>
            <p className="mt-2 text-[0.8125rem] text-muted">Pagamento único. Sem assinatura.</p>
          </section>
          <SimulatedActions token={token} successUrl={session.successUrl} cancelUrl={session.cancelUrl} />
        </>
      )}
    </main>
  );
}
