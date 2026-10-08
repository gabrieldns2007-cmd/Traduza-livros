/**
 * Como os créditos funcionam neste servidor:
 *  - "off":     nada de créditos (nem estimativa);
 *  - "preview": mostra estimativas, planos e o valor de cada tradução em créditos,
 *               mas NÃO desconta nem bloqueia nada (padrão enquanto não há pagamentos);
 *  - "enforce": serviços “hosted” (chave do dono do Verso) só traduzem com créditos
 *               reservados antes; o consumo é descontado por palavra traduzida.
 * Traduções com a chave da própria pessoa (“byok”) nunca consomem créditos.
 */
export type BillingMode = "off" | "preview" | "enforce";

export function billingMode(): BillingMode {
  const v = process.env.BILLING_MODE ?? process.env.NEXT_PUBLIC_BILLING_MODE;
  return v === "off" || v === "enforce" ? v : "preview";
}
