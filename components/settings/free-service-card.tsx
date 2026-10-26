"use client";

import { useState } from "react";
import { api } from "@/lib/client";
import { quotaText, type QuotaInfo } from "@/lib/quota-format";
import { PUBLIC_MODE } from "@/lib/mode";
import { Button } from "@/components/ui/button";

export interface FreeService {
  id: "gemini" | "github" | "groq" | "cloudflare" | "mistral";
  label: string;
  hasKey: boolean;
  keyHint: string;
  fromEnv: boolean;
  /** Cloudflare: o ID da conta também é necessário */
  account?: { hasValue: boolean; hint: string; fromEnv: boolean };
  /** chave (e conta) completas: o serviço pode traduzir */
  ready?: boolean;
  model: string;
  models: { id: string; label: string; note: string }[];
  quota: QuotaInfo | null;
  /** o que o serviço faz com o texto no nível gratuito */
  dataPolicy?: { note: string; trains: boolean | "default"; url: string } | null;
  /** limites gratuitos publicados */
  limitsNote?: string | null;
  /** falhas recentes (disjuntor): o serviço descansa até `blockedUntil` */
  health?: { state: string; blockedUntil: string | null; kind: string | null; lastError: string | null } | null;
}

const KEY_FIELD = {
  gemini: "geminiApiKey",
  github: "githubToken",
  groq: "groqApiKey",
  cloudflare: "cloudflareApiToken",
  mistral: "mistralApiKey",
} as const;
const MODEL_FIELD = {
  gemini: "geminiModel",
  github: "githubModel",
  groq: "groqModel",
  cloudflare: "cloudflareModel",
  mistral: "mistralModel",
} as const;

/** Como conseguir a chave gratuita de cada serviço (sem cartão). */
const HOW_TO: Partial<Record<FreeService["id"], { url: string; site: string; steps: string }>> = {
  gemini: {
    url: "https://aistudio.google.com/apikey",
    site: "aistudio.google.com/apikey",
    steps: "Entre com sua conta Google e toque em “Create API key”.",
  },
  groq: {
    url: "https://console.groq.com/keys",
    site: "console.groq.com/keys",
    steps: "Crie uma conta gratuita (sem cartão) e toque em “Create API Key”.",
  },
  cloudflare: {
    url: "https://dash.cloudflare.com/profile/api-tokens",
    site: "dash.cloudflare.com/profile/api-tokens",
    steps:
      "Crie uma conta gratuita (sem cartão). Copie o ID da conta (Account ID, na página inicial do painel) e crie um token de API com permissão para usar o Workers AI. Cole os dois aqui.",
  },
  mistral: {
    url: "https://console.mistral.ai/api-keys",
    site: "console.mistral.ai/api-keys",
    steps:
      "Crie uma conta (o modo Free não pede cartão) e gere uma chave. Depois, em Admin → Privacy, desligue “Anonymous improvement data” para a Mistral não treinar com os livros.",
  },
};

/** Aviso sobre o uso dos dados quando o servidor não manda (versão pública: só o Gemini treina). */
const DATA_NOTE: Partial<Record<FreeService["id"], string>> = {
  gemini: "No nível gratuito o Google pode usar o texto enviado para melhorar os produtos dele.",
};

/** Serviços que o fornecedor encerrou: o cartão só avisa (e deixa apagar a chave antiga). */
const RETIRED: Partial<Record<FreeService["id"], string>> = {
  github: PUBLIC_MODE
    ? "O GitHub encerrou este serviço em 30/07/2026 e ele não traduz mais. Para continuar traduzindo, salve a chave do Gemini ou do Groq aqui nesta lista."
    : "O GitHub encerrou este serviço em 30/07/2026 e ele não traduz mais. Se esta era a sua única chave, os clientes veem a tradução Grátis como “Em breve” até você salvar a chave de outro serviço gratuito aqui nesta lista.",
};

/** “às 14:05” hoje; “em 21/10 às 14:05” em outro dia. */
function backAt(iso: string) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? `às ${time}`
    : `em ${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} às ${time}`;
}

type CardProps = { service: FreeService; onChange: (payload: unknown) => void; endpoint?: string };

export function FreeServiceCard(props: CardProps) {
  // serviço encerrado: o cartão só aparece para quem ainda tem uma chave dele salva (para saber e poder apagar)
  if (RETIRED[props.service.id]) return props.service.hasKey ? <RetiredServiceCard {...props} /> : null;
  return <ActiveServiceCard {...props} />;
}

function RetiredServiceCard({ service, onChange, endpoint = "/api/settings" }: CardProps) {
  const [state, setState] = useState<{ busy: boolean; message: string; ok?: boolean }>({ busy: false, message: "" });

  const removeKey = async () => {
    setState({ busy: true, message: "" });
    try {
      onChange(await api<unknown>(endpoint, { method: "PUT", json: { [KEY_FIELD[service.id]]: "" } }));
      setState({ busy: false, message: "Chave removida." });
    } catch (err) {
      setState({ busy: false, ok: false, message: (err as Error).message });
    }
  };

  return (
    <div className="rounded-2xl border border-rule px-4 py-4 sm:px-5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[1rem] font-medium text-ink-2">{service.label}</h3>
        <span className="shrink-0 text-[0.75rem] text-muted">Encerrado</span>
      </div>
      <p className="mt-1.5 text-[0.875rem] leading-relaxed text-ink-2">{RETIRED[service.id]}</p>
      {service.hasKey && !service.fromEnv && (
        <button
          onClick={removeKey}
          disabled={state.busy}
          className="link relative mt-3 text-[0.8125rem] text-muted before:absolute before:-inset-x-2 before:-inset-y-3 before:content-[''] hover:text-ink"
        >
          Apagar a chave antiga
        </button>
      )}
      {state.message && <p className={`mt-3 text-[0.875rem] ${state.ok === false ? "text-accent" : "text-ok"}`}>{state.message}</p>}
    </div>
  );
}

function ActiveServiceCard({ service, onChange, endpoint = "/api/settings" }: CardProps) {
  const [draft, setDraft] = useState("");
  const [account, setAccount] = useState("");
  const [state, setState] = useState<{ busy: boolean; message: string; ok?: boolean }>({ busy: false, message: "" });
  const how = HOW_TO[service.id];
  const quota = quotaText(service.quota);
  const needsAccount = service.id === "cloudflare";
  const accountMissing = needsAccount && !service.account?.hasValue;
  const ready = service.ready ?? service.hasKey;
  const dataNote = service.dataPolicy?.note ?? DATA_NOTE[service.id];
  const blocked = service.health?.blockedUntil;

  const put = async (body: Record<string, string>) => {
    const d = await api<unknown>(endpoint, { method: "PUT", json: body });
    onChange(d);
  };

  const save = async (value: string, accountId = "") => {
    setState({ busy: true, message: "" });
    try {
      const body: Record<string, string> = {};
      if (value || !accountId) body[KEY_FIELD[service.id]] = value;
      if (needsAccount && (accountId || !value)) body.cloudflareAccountId = accountId;
      await put(body);
      setDraft("");
      setAccount("");
      if (!value && !accountId) return setState({ busy: false, message: "Chave removida." });
      const test = await api<{ ok: boolean; message?: string }>(endpoint, { method: "POST", json: { service: service.id } });
      setState({
        busy: false,
        ok: test.ok,
        message: test.message ?? (test.ok ? `Chave salva e funcionando. ${service.label} está pronto.` : "A chave não funcionou."),
      });
    } catch (err) {
      setState({ busy: false, ok: false, message: (err as Error).message });
    }
  };

  const canSave = Boolean(draft.trim()) || (needsAccount && Boolean(account.trim()));

  return (
    <div className="rounded-2xl border border-rule px-4 py-4 sm:px-5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[1rem] font-medium text-ink">{service.label}</h3>
        <span className={`shrink-0 text-[0.75rem] ${ready ? "text-ok" : "text-muted"}`}>
          {ready ? "Pronto" : service.hasKey && accountMissing ? "Falta o ID da conta" : "Sem chave"}
        </span>
      </div>

      {service.hasKey || service.account?.hasValue ? (
        <>
          <p className="mt-1 text-[0.875rem] text-ink-2">
            {service.hasKey && (
              <>
                {needsAccount ? "Token" : "Chave"} <span className="num text-muted">{service.keyHint}</span>
                {service.fromEnv && <span className="text-muted"> (variável de ambiente)</span>}
              </>
            )}
            {needsAccount && service.account?.hasValue && (
              <>
                {service.hasKey ? " · " : ""}Conta <span className="num text-muted">{service.account.hint}</span>
                {service.account.fromEnv && <span className="text-muted"> (variável de ambiente)</span>}
              </>
            )}
          </p>
          {quota && (
            <p className={`mt-1 text-[0.875rem] ${quota.tone === "out" ? "text-accent" : quota.tone === "low" ? "text-ink" : "text-ok"}`}>
              {quota.text}
            </p>
          )}
          {blocked && (
            <p className="mt-1 text-[0.875rem] text-accent">
              {service.health?.kind === "fatal" ? "Recusou a chave ou o modelo" : "Com falhas agora"}: descansa e volta {backAt(blocked)}.
            </p>
          )}
        </>
      ) : (
        how && (
          <p className="mt-1.5 text-[0.875rem] leading-relaxed text-ink-2">
            Abra{" "}
            <a href={how.url} target="_blank" rel="noreferrer" className="link text-ink">
              {how.site}
            </a>
            . {how.steps}
          </p>
        )
      )}
      {service.limitsNote && <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-muted">{service.limitsNote}</p>}
      {dataNote && (
        <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-muted">
          {dataNote}
          {service.dataPolicy?.url && (
            <>
              {" "}
              <a href={service.dataPolicy.url} target="_blank" rel="noreferrer" className="link">
                Termos
              </a>
              .
            </>
          )}
        </p>
      )}

      {!service.fromEnv && (
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
          {needsAccount && !service.account?.fromEnv && (
            <label className="block flex-1">
              <span className="label">{service.account?.hasValue ? "Trocar ID da conta" : "ID da conta"}</span>
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                placeholder="Account ID"
                className="mt-1.5 w-full border-b border-rule-strong bg-transparent py-2 text-[1rem] text-ink outline-none focus:border-ink"
              />
            </label>
          )}
          <label className="block flex-1">
            <span className="label">{service.hasKey ? (needsAccount ? "Trocar token" : "Trocar chave") : needsAccount ? "Token" : "Chave"}</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={needsAccount ? "Cole o token aqui" : "Cole a chave aqui"}
              className="mt-1.5 w-full border-b border-rule-strong bg-transparent py-2 text-[1rem] text-ink outline-none focus:border-ink"
            />
          </label>
          <Button size="sm" onClick={() => save(draft.trim(), account.trim())} disabled={state.busy || !canSave}>
            {state.busy ? "Testando…" : "Salvar e testar"}
          </Button>
        </div>
      )}
      {state.message && <p className={`mt-3 text-[0.875rem] ${state.ok === false ? "text-accent" : "text-ok"}`}>{state.message}</p>}

      {service.hasKey && service.models.length > 1 && (
        <div className="mt-4">
          <span className="label">Modelo</span>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {service.models.map((m) => {
              const sel = service.model === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => !sel && put({ [MODEL_FIELD[service.id]]: m.id }).catch(() => {})}
                  className={`rounded-xl border px-4 py-3 text-left transition-colors active:bg-paper-2 ${sel ? "border-ink" : "border-rule hover:border-rule-strong"}`}
                >
                  <span className="block text-[0.9375rem] text-ink">{m.label}</span>
                  <span className="mt-0.5 block text-[0.8125rem] text-muted">{m.note}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      {service.hasKey && service.models.length === 1 && (
        <p className="mt-3 text-[0.8125rem] text-muted">
          Modelo: <span className="text-ink-2">{service.models[0].label}</span> · {service.models[0].note}
        </p>
      )}

      {(service.hasKey || service.account?.hasValue) && !service.fromEnv && (
        <button onClick={() => save("")} className="link mt-3 text-[0.8125rem] text-muted hover:text-ink">
          {needsAccount ? "Remover token e conta" : "Remover chave"}
        </button>
      )}
    </div>
  );
}
