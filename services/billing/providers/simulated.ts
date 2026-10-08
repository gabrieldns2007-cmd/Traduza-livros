/**
 * Pagamento SIMULADO — para testar a experiência de compra sem dinheiro.
 *
 * Funciona como um meio de pagamento de verdade (página de pagamento → aviso
 * de pagamento → tradução começa), mas a “página de pagamento” é do próprio
 * Verso (/pagamento/simulado) e só o administrador pode aprovar. Nenhum
 * dinheiro é cobrado, nenhum cartão é pedido.
 *
 * Ligado no painel (Pagamentos → Teste de pagamento) ou com CHECKOUT_MODE=live
 * e PAYMENT_PROVIDER=simulado.
 */
import { ADMIN_COOKIE, hmac } from "@/lib/auth";
import { adminCookieOf, isAdminToken } from "@/services/admin/access";
import { serverSecret } from "@/services/secret";
import { PaymentError, type CheckoutRequest, type PaymentEvent, type PaymentProvider } from "../payment-types";

export interface SimulatedSession {
  id: string;
  productId: string;
  amountBrl: number;
  description: string;
  successUrl: string;
  cancelUrl: string;
  /** validade (ms desde 1970) */
  exp: number;
}

function b64url(s: string) {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export async function sealSession(session: SimulatedSession): Promise<string> {
  const payload = b64url(JSON.stringify(session));
  return `${payload}.${await hmac(await serverSecret(), `sim:${payload}`)}`;
}

/** Abre uma sessão assinada; null se foi alterada ou expirou. */
export async function openSession(token: string | null | undefined): Promise<SimulatedSession | null> {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  if ((await hmac(await serverSecret(), `sim:${payload}`)) !== sig) return null;
  try {
    const session = JSON.parse(fromB64url(payload)) as SimulatedSession;
    return session.exp > Date.now() ? session : null;
  } catch {
    return null;
  }
}

/** Só o caminho (o pagamento simulado acontece no próprio site). */
function pathOf(url: string) {
  const u = new URL(url, "http://local");
  return `${u.pathname}${u.search}`;
}

export const simulatedProvider: PaymentProvider = {
  id: "simulado",
  label: "Pagamento simulado (teste, sem dinheiro)",
  async createCheckout(req: CheckoutRequest) {
    const session: SimulatedSession = {
      id: `sim_${globalThis.crypto.randomUUID().slice(0, 12)}`,
      productId: req.productId,
      amountBrl: req.amountBrl,
      description: req.description,
      successUrl: pathOf(req.successUrl),
      cancelUrl: pathOf(req.cancelUrl),
      exp: Date.now() + 60 * 60_000,
    };
    return { url: `/pagamento/simulado?s=${encodeURIComponent(await sealSession(session))}` };
  },
  async parseWebhook(request: Request): Promise<PaymentEvent | null> {
    const body = (await request.json().catch(() => ({}))) as { s?: string; result?: string };
    const session = await openSession(body.s);
    if (!session) throw new PaymentError("Sessão de pagamento inválida ou expirada.", 400);
    if (body.result !== "approved") return null;
    // ninguém além do administrador aprova um pagamento simulado
    if (!(await isAdminToken(adminCookieOf(request, ADMIN_COOKIE)))) {
      throw new PaymentError("Só o administrador pode aprovar um pagamento simulado.", 403);
    }
    return {
      kind: "purchase.completed",
      accountId: "local",
      productId: session.productId,
      externalId: session.id,
      amountBrl: session.amountBrl,
      provider: "simulado",
    };
  },
};
