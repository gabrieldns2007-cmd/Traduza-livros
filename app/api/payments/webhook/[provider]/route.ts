import { fail, json } from "@/lib/api";
import { applyPaymentEvent, paymentProvider, PaymentError } from "@/services/billing/payments";

/**
 * Aviso do meio de pagamento (webhook). É a ÚNICA forma de um pedido virar
 * “pago”: o meio de pagamento valida a assinatura em `parseWebhook`, e cada
 * aviso é aplicado uma única vez (reenvios são ignorados).
 */
export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const provider = paymentProvider();
  if (!provider || provider.id !== (await params).provider) return fail("Não encontrado.", 404);
  try {
    const event = await provider.parseWebhook(request);
    const applied = event ? await applyPaymentEvent(event) : false;
    return json({ ok: true, applied });
  } catch (err) {
    if (err instanceof PaymentError) return fail(err.message, err.status);
    throw err;
  }
}
