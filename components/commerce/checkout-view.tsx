"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { ButtonLink } from "@/components/ui/button";
import { Check } from "@/components/ui/icons";
import type { Offer } from "./order-panel";

/**
 * Volta do pagamento. O pedido só vira “pago” quando o meio de pagamento
 * avisa o servidor (webhook) — o retorno do navegador não vale como prova.
 * Por isso esta página espera a confirmação e então leva ao acompanhamento.
 */
export function CheckoutView({ bookId }: { bookId: string }) {
  const router = useRouter();
  const [offer, setOffer] = useState<Offer | null>(null);
  const [waited, setWaited] = useState(0);
  const [error, setError] = useState("");
  const paid = offer?.order?.status === "paid";

  useEffect(() => {
    let alive = true;
    let tries = 0;
    const check = async () => {
      try {
        const { offer: o } = await api<{ offer: Offer }>(`/api/books/${bookId}/offer`);
        if (!alive) return;
        // sem pedido: a confirmação fica na página do livro
        if (!o.order) return router.replace(`/livros/${bookId}`);
        setOffer(o);
        if (o.order.status === "paid") return;
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
      tries++;
      setWaited(tries);
      if (alive && tries < 45) timer = setTimeout(check, 2000);
    };
    let timer = setTimeout(check, 0);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [bookId, router]);

  // confirmado: segue sozinho para o acompanhamento
  useEffect(() => {
    if (!paid) return;
    const t = setTimeout(() => router.replace(`/livros/${bookId}`), 3500);
    return () => clearTimeout(t);
  }, [paid, bookId, router]);

  return (
    <main className="mx-auto flex min-h-[70dvh] w-full max-w-[30rem] flex-col justify-center px-5 pb-24 text-center">
      {paid ? (
        <div className="rise">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-ink text-paper">
            <Check className="h-6 w-6" />
          </span>
          <h1 className="serif mt-6 text-[2rem] leading-tight tracking-[-0.02em] text-ink">
            {offer?.order?.payment === "beta" ? "Pedido confirmado." : "Pagamento confirmado."}
          </h1>
          <p className="mt-2 text-[1.0625rem] text-ink-2">Estamos preparando sua tradução.</p>
          {offer && <p className="serif mt-6 text-[1.125rem] text-ink italic">{offer.title}</p>}
          <ButtonLink href={`/livros/${bookId}`} className="mt-8 w-full">
            Acompanhar a tradução
          </ButtonLink>
          <p className="mt-3 text-[0.8125rem] text-muted">Você pode fechar esta página e voltar quando quiser.</p>
        </div>
      ) : waited >= 45 ? (
        <div className="rise">
          <h1 className="serif text-[1.75rem] leading-tight text-ink">Ainda não recebemos a confirmação.</h1>
          <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink-2">
            Se você concluiu o pagamento, a confirmação pode levar alguns minutos — a tradução começa sozinha assim que ela chegar. Nada é cobrado
            duas vezes.
          </p>
          <ButtonLink href={`/livros/${bookId}`} variant="secondary" className="mt-8 w-full">
            Voltar ao livro
          </ButtonLink>
        </div>
      ) : (
        <div aria-live="polite">
          <span className="mx-auto block h-10 w-10 animate-spin rounded-full border-2 border-rule border-t-ink" aria-hidden />
          <h1 className="serif mt-6 text-[1.75rem] leading-tight text-ink">Confirmando seu pagamento…</h1>
          <p className="mt-2 text-[0.9375rem] text-ink-2">Leva só alguns segundos.</p>
          {error && <p className="mt-4 text-[0.875rem] text-accent">{error}</p>}
        </div>
      )}
    </main>
  );
}
