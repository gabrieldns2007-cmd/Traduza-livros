"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { TranslationRun } from "@/types/book";
import { api } from "@/lib/client";
import { brl } from "@/lib/money";
import { formatNumber } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Chevron } from "@/components/ui/icons";
import { RunCosts } from "@/components/book/run-costs";
import { SettingsForm } from "@/components/settings/settings-form";
import { PasswordForm, StoreSettings } from "./store-settings";
import { AdsPanel } from "./ads-settings";
import type { AdsSettings } from "@/lib/ads";

type LevelId = "padrao" | "literaria";

interface Row {
  id: string;
  title: string;
  status: string;
  percent: number;
  words: number;
  level: LevelId | null;
  order: {
    level?: LevelId;
    priceBrl: number;
    status: string;
    payment: string | null;
    paymentProvider: string | null;
    words: number;
    paidAt: string | null;
    /** troca da Grátis para a Literária: o pedido grátis que este substitui */
    replaces?: string | null;
    /** troca sem pagamento: a Grátis volta a seguir sozinha nesta hora */
    expiresAt?: string | null;
  } | null;
  provider: { id: string; model: string } | null;
  runs: TranslationRun[];
  costUsd: number;
  costBrl: number;
  realCostBrl: number;
  revenueBrl: number;
  tokens: number;
  estimatedCostBrl: number | null;
  netBrl: number;
  profitBrl: number;
  margin: number | null;
  /** pagamentos recebidos que não valem como venda (pedido grátis, trocado, cancelado…): devolver */
  toRefund?: { orderId: string; externalId?: string; amountBrl?: number; provider?: string; reason: string; at: string }[];
  stopCode: string | null;
  error: string | null;
  resumeAt: string | null;
  updatedAt: string;
}

interface Service {
  id: string;
  label: string;
  model: string;
  available: boolean;
  paid: boolean;
  /** nível gratuito de verdade: só estes traduzem a Grátis */
  free?: boolean;
  exhaustedUntil?: string | null;
  /** falhas recentes (disjuntor): descansa até `blockedUntil` */
  health?: { state: string; blockedUntil: string | null; kind: string | null; lastError: string | null } | null;
  /** o que o serviço faz com o texto no nível gratuito */
  dataPolicy?: { note: string; trains: boolean | "default"; url: string } | null;
}

interface Example {
  words: number;
  priceBrl: number;
  netBrl: number;
  processingExpectedBrl: number;
  processingWorstBrl: number;
  fixedCostBrl: number;
  marginExpected: number;
  marginWorst: number;
}

interface Overview {
  checkout: "beta" | "live";
  billing: string;
  totals: {
    books: number;
    orders: number;
    paidBeta: number;
    paidProvider: number;
    /** traduções grátis confirmadas (R$ 0) */
    paidFree?: number;
    revenueBrl: number;
    betaValueBrl: number;
    costBrl: number;
    realCostBrl: number;
    profitBrl: number;
    priceBrl: number;
    /** pagamentos recebidos para reembolsar */
    toRefund?: number;
    toRefundBrl?: number;
  };
  payments: { wanted: string | null; label: string | null; implemented: boolean };
  books: Row[];
  routing: Record<LevelId, Service[]>;
  allProviders: Service[];
  offerLiteraria: boolean;
  pricing: {
    minimumBrl: number;
    levels: { id: LevelId; label: string; free?: boolean; per1kBrl: number; feeBrl: number; minWorstMargin: number; examples: Example[] }[];
  };
  admin: { passwordSet: boolean; source: "env" | "panel" | null };
  checkoutFromEnv: boolean;
  business: { name?: string; email?: string };
  /** anúncios (painel → Anúncios) */
  ads: AdsSettings;
  /** senha do site ligada (APP_PASSWORD): o Google não vê as páginas */
  siteLocked: boolean;
  /** a Tradução Grátis tem um serviço gratuito que funciona (senão, os clientes veem “Em breve”) */
  padraoOffered: boolean;
}

const STATUS: Record<string, string> = {
  ready: "Aguardando pedido",
  queued: "Na fila",
  analyzing: "Preparando",
  translating: "Traduzindo",
  paused: "Pausado",
  done: "Concluído",
  error: "Erro",
};

const STOP: Record<string, string> = {
  waiting: "esperando um serviço gratuito",
  quota: "cota esgotada",
  unavailable: "serviço indisponível",
  modality: "erro interno: serviço da modalidade errada (nada foi enviado)",
  unpaid: "serviço pago sem pedido pago (nada foi enviado)",
  credits: "sem créditos",
  wallet: "carteira vazia",
  margin: "margem abaixo do mínimo",
};

// o id "padrao" é a tradução Grátis (mantido para os livros e pedidos já gravados)
const LEVEL: Record<LevelId, string> = { padrao: "Grátis", literaria: "Literária" };

function paymentLabel(order: Row["order"]): string {
  if (!order) return "sem pedido";
  switch (order.status) {
    case "awaiting_payment":
      // troca da Grátis para a Literária: a Grátis fica parada até o pagamento (ou até o cliente voltar para ela)
      return order.replaces
        ? `aguardando pagamento · troca da Grátis para a Literária (Grátis parada${order.expiresAt ? ` até ${when(order.expiresAt)}` : ""})`
        : "aguardando pagamento";
    case "paid":
      if (order.payment === "free") return "tradução grátis (sem pagamento)";
      return order.payment === "beta" ? "confirmado no beta (sem cobrança)" : `pago${order.paymentProvider ? ` · ${order.paymentProvider}` : ""}`;
    case "refunded":
      return "reembolsado";
    default:
      return "cancelado";
  }
}

function pct(v: number) {
  return `${Math.round(v * 100)}%`;
}

function when(iso: string) {
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/**
 * Painel do dono do Verso: tudo o que o cliente NÃO vê — qual serviço de IA
 * traduz cada pedido, quanto custou, a margem, erros técnicos e a configuração.
 */
export function AdminDashboard() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [created, setCreated] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<Overview>("/api/admin/overview"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const logout = async () => {
    await fetch("/api/admin/auth", { method: "DELETE" });
    window.location.href = "/";
  };

  return (
    <main className="mx-auto w-full max-w-[56rem] px-5 pt-8 pb-24 sm:px-8 sm:pt-14">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="label">Somente administrador</p>
          <h1 className="rise serif mt-2 text-[2.6rem] leading-none font-[380] tracking-[-0.035em] text-ink sm:text-[3.4rem]">Painel</h1>
        </div>
        {data?.admin.passwordSet && (
          <button onClick={logout} className="link mt-1 text-[0.875rem] text-muted hover:text-ink">
            Sair
          </button>
        )}
      </div>

      {error && <p className="mt-6 text-[0.9375rem] text-accent">{error}</p>}
      {!data && !error && <div className="mt-10 h-64 animate-pulse rounded-[1.25rem] bg-paper-2" aria-label="Carregando" />}

      {data && (
        <>
          {!data.admin.passwordSet && (
            <section className="mt-6 rounded-[1.25rem] border border-accent/50 px-5 py-6 sm:px-6">
              <p className="serif text-[1.35rem] leading-snug text-ink">Crie a senha do painel.</p>
              <p className="mt-1.5 mb-5 text-[0.875rem] leading-relaxed text-ink-2">
                Sem ela, qualquer pessoa com o endereço pode abrir esta página. Você só precisa fazer isso uma vez.
              </p>
              <PasswordForm
                mode="create"
                onDone={() => {
                  setCreated(true);
                  load();
                }}
              />
            </section>
          )}
          {created && (
            <p className="mt-6 rounded-2xl bg-paper-2 px-5 py-4 text-[0.9375rem] leading-relaxed text-ink-2" role="status">
              <strong className="font-medium text-ok">Senha criada.</strong> Guarde-a bem: ela será pedida para abrir o painel em outro aparelho.
            </p>
          )}
          <Summary data={data} />
          <Books rows={data.books} />
          <StoreSettings
            checkout={data.checkout}
            provider={data.payments.wanted}
            fromEnv={data.checkoutFromEnv}
            business={data.business}
            onSaved={load}
          />
          <AdsPanel ads={data.ads} siteLocked={data.siteLocked} passwordSet={data.admin.passwordSet} onSaved={load} />
          <Routing data={data} onSaved={load} />
          <Prices data={data} />
          <section className="mt-16">
            <h2 className="label">Chaves e serviços</h2>
            <p className="mt-2 text-[0.8125rem] leading-relaxed text-muted">As chaves ficam só no servidor. O cliente nunca vê esta parte.</p>
            <SettingsForm variant="admin" />
          </section>
          {data.admin.source === "panel" && (
            <section className="mt-16">
              <h2 className="label">Senha do painel</h2>
              <div className="mt-4">
                <PasswordForm mode="change" onDone={load} />
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}

/* ---------------------------------------------------------------- resumo */

function Summary({ data }: { data: Overview }) {
  const t = data.totals;
  const beta = data.checkout === "beta";
  const income = beta ? t.betaValueBrl : t.revenueBrl;
  const margin = t.priceBrl > 0 ? t.profitBrl / t.priceBrl : null;
  const p = data.payments;
  return (
    <section className="mt-10">
      <p className="text-[0.9375rem] leading-relaxed text-ink-2">
        {beta ? (
          <>
            <strong className="font-medium text-ink">Beta:</strong> os clientes confirmam o pedido sem pagar (mude em Vendas, abaixo). Os valores
            abaixo mostram quanto os pedidos teriam rendido.
          </>
        ) : p.implemented ? (
          <>
            <strong className="font-medium text-ink">Pagamentos ligados</strong> com {p.label}: a tradução só começa depois do pagamento confirmado.
          </>
        ) : (
          <>
            <strong className="font-medium text-accent">Pagamentos ligados sem meio de pagamento</strong>
            {p.wanted ? ` (${p.wanted} ainda não está disponível)` : ""}: os clientes veem “Pagamentos em breve”. Mude em Vendas, abaixo.
          </>
        )}
      </p>
      {Boolean(t.toRefund) && (
        <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink-2" role="alert">
          <strong className="font-medium text-accent">Pagamento recebido para reembolsar:</strong> {t.toRefund}{" "}
          {t.toRefund === 1 ? "pagamento" : "pagamentos"} ({brl(t.toRefundBrl ?? 0)}) chegaram para pedidos que não são uma venda (tradução grátis,
          pedido trocado ou cancelado, valor menor que o preço). Devolva pelo meio de pagamento; os livros estão marcados abaixo.
        </p>
      )}
      {!data.padraoOffered && (
        <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink-2" role="alert">
          <strong className="font-medium text-accent">A Tradução Grátis está parada:</strong> nenhum serviço gratuito está pronto, então os clientes
          veem “Em breve” e não conseguem pedir. Salve a chave de um serviço gratuito (Gemini, Groq…) em Chaves e serviços, abaixo.
        </p>
      )}
      <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-6 border-y border-rule py-6 sm:grid-cols-4">
        <Stat label="Livros" value={formatNumber(t.books)} sub={`${formatNumber(t.orders)} com pedido`} />
        <Stat
          label={beta ? "Valor dos pedidos" : "Receita"}
          value={brl(income)}
          sub={`${beta ? `${t.paidBeta} confirmados no beta` : `${t.paidProvider} pagos`}${t.paidFree ? ` · ${t.paidFree} grátis` : ""}`}
        />
        <Stat label="Custo real" value={brl(t.realCostBrl)} sub={`${brl(t.costBrl)} se tudo fosse pago`} />
        <Stat
          label="Lucro estimado"
          value={margin === null ? "—" : brl(t.profitBrl)}
          sub={margin === null ? "sem pedidos ainda" : `margem de ${pct(margin)}, após taxas e impostos`}
        />
      </dl>
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd className="serif num mt-1 text-[1.375rem] leading-tight text-ink">{value}</dd>
      {sub && <dd className="mt-0.5 text-[0.8125rem] text-muted">{sub}</dd>}
    </div>
  );
}

/* ---------------------------------------------------------------- traduções */

function Books({ rows }: { rows: Row[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="mt-14">
      <h2 className="label">Traduções</h2>
      {!rows.length && <p className="mt-3 text-[0.9375rem] text-muted">Nenhum livro ainda.</p>}
      <ul className="mt-3 divide-y divide-rule border-y border-rule">
        {rows.map((r) => {
          const expanded = open === r.id;
          return (
            <li key={r.id}>
              <button
                onClick={() => setOpen(expanded ? null : r.id)}
                className="flex w-full items-start gap-3 py-4 text-left"
                aria-expanded={expanded}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[1rem] text-ink">{r.title}</span>
                  <span className="mt-0.5 block text-[0.8125rem] text-muted">
                    {STATUS[r.status] ?? r.status}
                    {r.status !== "ready" && r.status !== "done" ? ` · ${r.percent}%` : ""}
                    {r.stopCode ? ` · ${STOP[r.stopCode] ?? r.stopCode}` : ""}
                    {r.resumeAt ? ` · volta ${when(r.resumeAt)}` : ""}
                    {r.toRefund?.length ? " · pagamento para reembolsar" : ""}
                    {r.provider && r.provider.id !== "demo" ? ` · ${r.provider.model}` : ""}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="serif num block text-[1rem] text-ink">{r.order ? brl(r.order.priceBrl) : "—"}</span>
                  <span className="num block text-[0.75rem] text-muted">{r.level ? LEVEL[r.level] : "sem pedido"}</span>
                </span>
                <Chevron className={`mt-1.5 h-4 w-4 shrink-0 text-muted transition-transform ${expanded ? "rotate-180" : ""}`} />
              </button>
              {expanded && (
                <div className="rise pb-6">
                  <p className="text-[0.875rem] text-ink-2">
                    Pagamento: <span className="text-ink">{paymentLabel(r.order)}</span>
                    {r.order?.paidAt ? ` em ${when(r.order.paidAt)}` : ""}
                  </p>
                  {r.toRefund?.map((p, i) => (
                    <p key={`${p.externalId ?? p.orderId}-${i}`} className="mt-2 text-[0.875rem] text-accent">
                      Pagamento recebido para reembolsar: {p.amountBrl !== undefined ? brl(p.amountBrl) : "valor não informado"}
                      {p.provider ? ` · ${p.provider}` : ""}
                      {p.externalId ? ` · ${p.externalId}` : ""} · {p.reason} · {when(p.at)}
                    </p>
                  ))}
                  <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
                    <Stat label="Preço cobrado" value={r.order ? brl(r.order.priceBrl) : "—"} sub={`${formatNumber(r.words)} palavras`} />
                    <Stat label="Custo estimado" value={r.estimatedCostBrl === null ? "—" : brl(r.estimatedCostBrl)} sub="IA, pela tabela" />
                    <Stat label="Custo real" value={brl(r.realCostBrl)} sub={`${brl(r.costBrl)} se fosse pago`} />
                    <Stat label="Tokens" value={formatNumber(r.tokens)} sub={r.provider && r.provider.id !== "demo" ? r.provider.model : undefined} />
                    <Stat label="Líquido" value={r.order?.status === "paid" ? brl(r.netBrl) : "—"} sub="após taxas e impostos" />
                    <Stat label="Lucro estimado" value={r.margin === null ? "—" : brl(r.profitBrl)} sub="líquido − custo real − custo fixo" />
                    <Stat label="Margem" value={r.margin === null ? "—" : pct(r.margin)} />
                  </dl>
                  {r.error && (
                    <p className="mt-4 rounded-xl bg-paper-2 px-4 py-3 font-mono text-[0.75rem] leading-relaxed break-words text-ink-2">{r.error}</p>
                  )}
                  <RunCosts runs={r.runs} words={r.words} />
                  <Link href={`/livros/${r.id}`} className="link mt-5 inline-block text-[0.875rem] text-ink-2 hover:text-ink">
                    Abrir como o cliente vê →
                  </Link>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ---------------------------------------------------------------- serviços por tipo */

/** “volta às 14:05” hoje; “volta em 21/10 às 14:05” em outro dia. */
function backAt(iso: string) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? `volta às ${time}`
    : `volta em ${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} às ${time}`;
}

/** Situação de um serviço na fila: chave, cota e saúde (falhas recentes). */
function serviceNote(p: Service | undefined, s: Service | undefined): { text: string; warn: boolean } {
  if (!p?.available) return { text: "sem chave configurada", warn: true };
  if (s?.exhaustedUntil) return { text: `cota esgotada · ${backAt(s.exhaustedUntil)}`, warn: true };
  const h = s?.health;
  if (h?.blockedUntil) {
    return { text: `${h.kind === "fatal" ? "recusou a chave ou o modelo" : "com falhas"} · ${backAt(h.blockedUntil)}`, warn: true };
  }
  if (h?.state === "half_open") return { text: "voltando depois de falhas: o próximo pedido é um teste", warn: false };
  return { text: "pronto", warn: false };
}

function Routing({ data, onSaved }: { data: Overview; onSaved: () => void }) {
  // a Grátis só com gratuitos e a Literária só com pagos: o que sobrou de outra modalidade sai da lista
  const [routing, setRouting] = useState<Record<LevelId, string[]>>({
    padrao: data.routing.padrao.filter((s) => s.free).map((s) => s.id),
    literaria: data.routing.literaria.filter((s) => s.paid).map((s) => s.id),
  });
  const [offer, setOffer] = useState(data.offerLiteraria);
  const [state, setState] = useState<"" | "saving" | "saved" | string>("");
  const byId = (id: string) =>
    data.allProviders.find((p) => p.id === id) ?? data.routing.padrao.concat(data.routing.literaria).find((p) => p.id === id);
  const status = (level: LevelId, id: string) => data.routing[level].find((s) => s.id === id);

  const move = (level: LevelId, i: number, d: -1 | 1) =>
    setRouting((r) => {
      const list = [...r[level]];
      const j = i + d;
      if (j < 0 || j >= list.length) return r;
      [list[i], list[j]] = [list[j], list[i]];
      return { ...r, [level]: list };
    });
  const remove = (level: LevelId, id: string) => setRouting((r) => ({ ...r, [level]: r[level].filter((x) => x !== id) }));
  const add = (level: LevelId, id: string) => setRouting((r) => ({ ...r, [level]: [...r[level], id] }));

  const save = async () => {
    setState("saving");
    try {
      await api("/api/admin/settings", { method: "PUT", json: { routing, offerLiteraria: offer } });
      setState("saved");
      onSaved();
    } catch (e) {
      setState((e as Error).message);
    }
  };

  const literariaPaid = routing.literaria.some((id) => byId(id)?.paid);

  return (
    <section className="mt-16">
      <h2 className="label">Quem traduz cada tipo</h2>
      <p className="mt-2 text-[0.8125rem] leading-relaxed text-muted">
        O cliente só escolhe o tipo de tradução. Aqui você decide qual serviço faz o trabalho, em ordem. Na tradução grátis, se um serviço ficar sem
        cota ou falhar, a tradução passa sozinha para o próximo — e, se todos estiverem fora, espera e continua sozinha, sem você fazer nada. A grátis
        nunca usa um serviço pago, e a Literária nunca usa um gratuito.
      </p>

      {(["padrao", "literaria"] as const).map((level) => {
        const list = routing[level];
        const candidates = data.allProviders.filter((p) => !list.includes(p.id) && (level === "padrao" ? p.free : p.paid));
        return (
          <div key={level} className="mt-7">
            <p className="text-[1rem] font-medium text-ink">Tradução {LEVEL[level]}</p>
            {level === "literaria" && (
              <div className="mt-3">
                <Switch
                  checked={offer}
                  onChange={setOffer}
                  label="Vender a tradução Literária"
                  description={
                    literariaPaid
                      ? "Usa um serviço PAGO com a sua chave: cada pedido gera custo na sua conta do serviço. O preço da Literária cobre esse custo, mas só ligue quando os pagamentos estiverem funcionando."
                      : "Aparece para o cliente como opção."
                  }
                />
              </div>
            )}
            <ol className="mt-3 divide-y divide-rule rounded-2xl border border-rule">
              {list.map((id, i) => {
                const p = byId(id);
                const s = status(level, id);
                const note = serviceNote(p, s);
                const policy = s?.dataPolicy ?? p?.dataPolicy;
                return (
                  <li key={id} className="flex items-center gap-3 px-4 py-3">
                    <span className="num w-5 text-[0.8125rem] text-muted">{i + 1}.</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[0.9375rem] text-ink">
                        {p?.label ?? id}{" "}
                        <span className={`ml-1 text-[0.6875rem] tracking-wide uppercase ${p?.paid ? "text-accent" : "text-ok"}`}>
                          {p?.paid ? "pago" : "grátis"}
                        </span>
                      </span>
                      <span className={`block truncate text-[0.75rem] ${note.warn ? "text-accent" : "text-muted"}`}>
                        {p?.model ? `${p.model} · ` : ""}
                        {note.text}
                      </span>
                      {policy && !p?.paid && (
                        <span className="mt-1 block text-[0.75rem] leading-relaxed text-muted">
                          {policy.note}{" "}
                          <a href={policy.url} target="_blank" rel="noreferrer" className="link">
                            Termos
                          </a>
                        </span>
                      )}
                    </span>
                    <button
                      onClick={() => move(level, i, -1)}
                      disabled={i === 0}
                      className="h-9 w-9 shrink-0 rounded-full text-ink-2 hover:bg-paper-2 disabled:opacity-30"
                      aria-label="Subir"
                    >
                      ↑
                    </button>
                    <button
                      onClick={() => move(level, i, 1)}
                      disabled={i === list.length - 1}
                      className="h-9 w-9 shrink-0 rounded-full text-ink-2 hover:bg-paper-2 disabled:opacity-30"
                      aria-label="Descer"
                    >
                      ↓
                    </button>
                    <button
                      onClick={() => remove(level, id)}
                      className="h-9 w-9 shrink-0 rounded-full text-muted hover:bg-paper-2 hover:text-accent"
                      aria-label="Remover"
                    >
                      ×
                    </button>
                  </li>
                );
              })}
              {!list.length && <li className="px-4 py-3 text-[0.875rem] text-muted">Nenhum serviço — será usada a ordem padrão.</li>}
            </ol>
            {candidates.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {candidates.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => add(level, p.id)}
                    className="rounded-full border border-rule px-3 py-1.5 text-[0.8125rem] text-ink-2 hover:border-ink hover:text-ink"
                  >
                    + {p.label}
                    {p.paid ? " (pago)" : ""}
                    {p.available ? "" : " · sem chave"}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <div className="mt-6 flex items-center gap-4">
        <Button variant="secondary" onClick={save} disabled={state === "saving"}>
          {state === "saving" ? "Salvando…" : "Salvar ordem dos serviços"}
        </Button>
        {state === "saved" && <span className="text-[0.875rem] text-ok">Salvo.</span>}
        {state && state !== "saving" && state !== "saved" && <span className="text-[0.875rem] text-accent">{state}</span>}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- preços */

function Prices({ data }: { data: Overview }) {
  return (
    <section className="mt-16">
      <h2 className="label">Como o preço é calculado</h2>
      <p className="mt-2 text-[0.8125rem] leading-relaxed text-muted">
        A <strong className="font-medium text-ink-2">Grátis</strong> não cobra nada, em qualquer tamanho, e só usa serviços gratuitos: o custo de IA
        dela é zero, e ela se paga com os anúncios (painel → Anúncios). Não ative faturamento nas chaves dos serviços gratuitos: a Grátis passaria a
        gerar custo sem nenhuma receita. Na Literária, preço = valor fixo + palavras × preço por mil, arredondado para ,90 e nunca abaixo de{" "}
        {brl(data.pricing.minimumBrl)}; os custos abaixo vêm da tabela de preços do modelo pago. Para mudar os valores, edite{" "}
        <code>lib/billing/pricing.ts</code> — um teste impede preços abaixo da margem mínima (e qualquer cobrança na Grátis).
      </p>
      {data.pricing.levels.map((l) =>
        l.free ? (
          <p key={l.id} className="mt-6 text-[1rem] font-medium text-ink">
            {l.label} <span className="num font-normal text-muted">· R$ 0 · custo de IA R$ 0 (serviços gratuitos)</span>
          </p>
        ) : (
          <div key={l.id} className="mt-6">
            <p className="text-[1rem] font-medium text-ink">
              {l.label}{" "}
              <span className="num font-normal text-muted">
                · {brl(l.feeBrl)} + {brl(l.per1kBrl)} por mil palavras · margem mínima {pct(l.minWorstMargin)}
              </span>
            </p>
            <div className="mt-2 overflow-x-auto">
              <table className="num w-full min-w-[32rem] text-[0.8125rem]">
                <thead>
                  <tr className="border-b border-rule text-left text-muted">
                    <th className="py-2 font-normal">Palavras</th>
                    <th className="py-2 text-right font-normal">Preço</th>
                    <th className="py-2 text-right font-normal">Líquido</th>
                    <th className="py-2 text-right font-normal">Custo esperado</th>
                    <th className="py-2 text-right font-normal">Pior caso</th>
                    <th className="py-2 text-right font-normal">Margem</th>
                  </tr>
                </thead>
                <tbody>
                  {l.examples.map((e) => (
                    <tr key={e.words} className="border-b border-rule text-ink-2">
                      <td className="py-2">{formatNumber(e.words)}</td>
                      <td className="py-2 text-right text-ink">{brl(e.priceBrl)}</td>
                      <td className="py-2 text-right">{brl(e.netBrl)}</td>
                      <td className="py-2 text-right">{brl(e.processingExpectedBrl + e.fixedCostBrl)}</td>
                      <td className="py-2 text-right">{brl(e.processingWorstBrl + e.fixedCostBrl)}</td>
                      <td className="py-2 text-right">
                        {pct(e.marginExpected)} <span className="text-muted">(mín. {pct(e.marginWorst)})</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ),
      )}
    </section>
  );
}
