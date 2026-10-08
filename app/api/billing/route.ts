import { json } from "@/lib/api";
import { walletSummary } from "@/services/billing/account";

/** Plano e créditos da conta (nada é cobrado enquanto BILLING_MODE não for "enforce"). */
export async function GET() {
  return json({ wallet: await walletSummary() });
}
