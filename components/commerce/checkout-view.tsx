"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { languageLabel } from "@/lib/languages";
import { formatNumber } from "@/lib/format";
import { brl } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Steps, COMMERCE_STEPS } from "@/components/ui/steps";
import { ArrowLeft } from "@/components/ui/icons";
import type { Offer } from "./order-panel";

/**
 * Passo “Pagar”: resumo do pedido e pagamento. Enquanto não há meio de
 * pagamento (beta), a confirmação não cobra nada e a tradução começa na hora.
 */
export function CheckoutView({ bookId }: { bookId: string }) {
  const router = useRouter();
  const [offer, setOffer] = useState<Offer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ offer: Offer }>(`/api/books/${bookId}/offer`)
      .then(({ offer: o }) => {
        // sem pedido (ou já pago): volta para o livro
        if (!o.order || o.order.status !== "awaiting_payment") router.replace(`/livros/${bookId}`);
        else setOffer(o);
      })
      .catch((e) => setError((e as Error).message));
  }, [bookId, router]);

  const pay = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ started: boolean; checkoutUrl?: string }>(`/api/books/${bookId}/order/confirm`, { method: "POST" });
      if (r.checkoutUrl) window.location.href = r.checkoutUrl;
      else router.push(`/livros/${bookId}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (error && !offer)
    return (
      <main className="mx-auto max-w-md px-5 pt-20 text-center">
        <p className="text-[0.9375rem] text-accent">{error}</p>
      </main>
    );
  if (!offer?.order) return <main className="mx-auto w-full max-w-[36rem] px-5 pt-10" aria-busy="true" />;

  const level = offer.levels.find((l) => l.id === offer.order!.level);
  const beta = offer.checkout.mode === "beta";
  const canPay = beta || offer.checkout.payments;

  return (
    <main className="mx-auto w-full max-w-[36rem] px-5 pt-6 pb-28 sm:px-8 sm:pt-12">
      <Link href={`/livros/${bookId}`} className="link inline-flex items-center gap-1.5 text-[0.875rem] text-muted hover:text-ink">
        <ArrowLeft className="h-3.5 w-3.5" /> Voltar
      </Link>
      <Steps steps={COMMERCE_STEPS} current={2} className="mt-6" />

      <h1 className="rise serif mt-8 text-[2.1rem] leading-[1.05] tracking-[-0.02em] text-ink sm:text-[2.6rem]">Confirme sua tradução</h1>

      <section className="rise mt-7 rounded-[1.25rem] border border-rule px-5 py-6 sm:px-7" aria-label="Resumo do pedido">
        <p className="serif text-[1.25rem] leading-snug text-ink">{offer.title}</p>
        {offer.author && <p className="serif text-[1rem] text-ink-2 italic">{offer.author}</p>}
        <dl className="mt-5 space-y-2.5 border-t border-rule pt-4 text-[0.9375rem]">
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Idiomas</dt>
            <dd className="text-right text-ink">
              {languageLabel(offer.sourceLanguage ?? offer.detectedLanguage, "Original")} → {languageLabel(offer.targetLanguage)}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Tamanho</dt>
            <dd className="num text-ink">{formatNumber(offer.totalWords)} palavras</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Tradução</dt>
            <dd className="text-ink">{level?.label ?? "Padrão"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Você recebe</dt>
            <dd className="text-right text-ink">EPUB e PDF · revisão online</dd>
          </div>
        </dl>
        <div className="mt-5 flex items-baseline justify-between gap-4 border-t border-rule pt-4">
          <span className="text-[1rem] text-ink">Total</span>
          <span className="serif num text-[2rem] leading-none text-ink">{brl(offer.order.priceBrl)}</span>
        </div>
      </section>

      <section className="rise mt-6">
        {beta ? (
          <p className="rounded-2xl bg-paper-2 px-5 py-4 text-[0.9375rem] leading-relaxed text-ink-2">
            <strong className="font-medium text-ink">Grátis durante o beta.</strong> Enquanto o Verso está em fase de testes, as traduções são por
            nossa conta — nada será cobrado.
          </p>
        ) : !offer.checkout.payments ? (
          <p className="rounded-2xl bg-paper-2 px-5 py-4 text-[0.9375rem] text-ink-2">Os pagamentos abrem em breve.</p>
        ) : null}
        <Button onClick={pay} disabled={busy || !canPay} className="mt-5 w-full">
          {busy ? "Um instante…" : beta ? "Confirmar e começar a tradução" : `Pagar ${brl(offer.order.priceBrl)}`}
        </Button>
        <p className="mt-3 text-center text-[0.8125rem] leading-relaxed text-muted">
          A tradução começa assim que você confirmar. Você acompanha o progresso aqui e recebe o livro em EPUB e PDF.
        </p>
        {error && (
          <p className="mt-4 text-center text-[0.9375rem] text-accent" role="alert">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}
