"use client";

import { useState } from "react";
import { api } from "@/lib/client";
import { Button } from "@/components/ui/button";

const input =
  "mt-2 w-full rounded-xl border border-rule bg-transparent px-4 py-3 text-[1rem] text-ink placeholder:text-muted/80 focus:border-ink-2 focus:outline-none";

/** Cria a senha do painel (primeiro acesso) ou troca a atual. */
export function PasswordForm({ mode, onDone }: { mode: "create" | "change"; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [state, setState] = useState<"" | "saving" | "saved" | string>("");
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setState("saving");
    try {
      await api("/api/admin/password", { method: "POST", json: { password } });
      setPassword("");
      setState("saved");
      onDone();
    } catch (err) {
      setState((err as Error).message);
    }
  };
  return (
    <form onSubmit={save}>
      <label className="block">
        <span className="label">{mode === "create" ? "Nova senha do painel" : "Nova senha"}</span>
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Pelo menos 8 caracteres"
          className={input}
        />
      </label>
      <div className="mt-4 flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={state === "saving" || password.length < 8} className="w-full sm:w-auto">
          {state === "saving" ? "Salvando…" : mode === "create" ? "Criar senha" : "Trocar senha"}
        </Button>
        {state === "saved" && <span className="text-[0.875rem] text-ok">Senha salva. Guarde-a bem.</span>}
        {state && state !== "saving" && state !== "saved" && <span className="text-[0.875rem] text-accent">{state}</span>}
      </div>
    </form>
  );
}

type PaymentChoice = "beta" | "simulado";

/**
 * Como o cliente paga e quem vende. Tudo pelo painel — sem editar arquivos.
 * Pagamentos reais ficam desligados até haver um meio de pagamento (e sua autorização).
 */
export function StoreSettings({
  checkout,
  provider,
  fromEnv,
  business,
  onSaved,
}: {
  checkout: "beta" | "live";
  provider: string | null;
  fromEnv: boolean;
  business: { name?: string; email?: string };
  onSaved: () => void;
}) {
  const [choice, setChoice] = useState<PaymentChoice>(checkout === "live" && provider === "simulado" ? "simulado" : "beta");
  const [name, setName] = useState(business.name ?? "");
  const [email, setEmail] = useState(business.email ?? "");
  const [state, setState] = useState<"" | "saving" | "saved" | string>("");

  const save = async () => {
    setState("saving");
    try {
      await api("/api/admin/settings", {
        method: "PUT",
        json: {
          ...(fromEnv ? {} : { checkout: choice === "simulado" ? { mode: "live", provider: "simulado" } : { mode: "beta", provider: "" } }),
          business: { name, email },
        },
      });
      setState("saved");
      onSaved();
    } catch (err) {
      setState((err as Error).message);
    }
  };

  const options: { id: PaymentChoice | "real"; title: string; text: string; disabled?: boolean }[] = [
    { id: "beta", title: "Beta — grátis para o cliente", text: "O cliente vê o preço e confirma sem pagar. Nada é cobrado." },
    {
      id: "simulado",
      title: "Teste de pagamento",
      text: "Mostra a página de pagamento, mas é simulada: sem dinheiro e sem cartão. Só você (logado no painel) consegue aprovar.",
    },
    {
      id: "real",
      title: "Pagamentos reais (Mercado Pago ou Stripe)",
      text: "Ainda não disponível: precisa de uma conta no meio de pagamento e da sua autorização.",
      disabled: true,
    },
  ];

  return (
    <section className="mt-16">
      <h2 className="label">Vendas</h2>
      <p className="mt-4 text-[1rem] font-medium text-ink">Como o cliente paga</p>
      {fromEnv && (
        <p className="mt-2 text-[0.8125rem] text-muted">
          Definido no arquivo .env.local (CHECKOUT_MODE / PAYMENT_PROVIDER), que tem prioridade sobre esta escolha.
        </p>
      )}
      <div className="mt-3 space-y-2.5" role="radiogroup" aria-label="Como o cliente paga">
        {options.map((o) => {
          const sel = o.id === choice;
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={sel}
              disabled={o.disabled || fromEnv}
              onClick={() => o.id !== "real" && setChoice(o.id)}
              className={`flex w-full items-start gap-3 rounded-2xl border px-4 py-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${sel ? "border-ink" : "border-rule hover:border-rule-strong"}`}
            >
              <span
                className={`mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${sel ? "border-ink bg-ink" : "border-rule-strong"}`}
              >
                {sel && <span className="h-1.5 w-1.5 rounded-full bg-paper" />}
              </span>
              <span>
                <span className="block text-[0.9375rem] font-medium text-ink">{o.title}</span>
                <span className="mt-0.5 block text-[0.8125rem] leading-relaxed text-muted">{o.text}</span>
              </span>
            </button>
          );
        })}
      </div>

      <p className="mt-8 text-[1rem] font-medium text-ink">Quem vende</p>
      <p className="mt-1 text-[0.8125rem] leading-relaxed text-muted">
        Aparece nos{" "}
        <a href="/termos" target="_blank" className="link text-ink-2">
          Termos de uso
        </a>{" "}
        e na{" "}
        <a href="/privacidade" target="_blank" className="link text-ink-2">
          Política de privacidade
        </a>
        . Leia os dois (e, se puder, peça para um advogado revisar) antes de cobrar.
      </p>
      <label className="mt-4 block">
        <span className="label">Seu nome ou da sua empresa</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Ex.: Verso Traduções" className={input} />
      </label>
      <label className="mt-4 block">
        <span className="label">E-mail de contato</span>
        <input
          type="email"
          inputMode="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          maxLength={120}
          placeholder="contato@exemplo.com"
          className={input}
        />
      </label>

      <div className="mt-6 flex flex-wrap items-center gap-4">
        <Button variant="secondary" onClick={save} disabled={state === "saving"} className="w-full sm:w-auto">
          {state === "saving" ? "Salvando…" : "Salvar vendas"}
        </Button>
        {state === "saved" && <span className="text-[0.875rem] text-ok">Salvo.</span>}
        {state && state !== "saving" && state !== "saved" && <span className="text-[0.875rem] text-accent">{state}</span>}
      </div>
    </section>
  );
}
