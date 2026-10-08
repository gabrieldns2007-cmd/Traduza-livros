"use client";

import { useState } from "react";
import { api } from "@/lib/client";
import { quotaText, type QuotaInfo } from "@/lib/quota-format";
import { Button } from "@/components/ui/button";

export interface FreeService {
  id: "gemini" | "github" | "groq";
  label: string;
  hasKey: boolean;
  keyHint: string;
  fromEnv: boolean;
  model: string;
  models: { id: string; label: string; note: string }[];
  quota: QuotaInfo | null;
}

const KEY_FIELD = { gemini: "geminiApiKey", github: "githubToken", groq: "groqApiKey" } as const;
const MODEL_FIELD = { gemini: "geminiModel", github: "githubModel", groq: "groqModel" } as const;

/** Como conseguir a chave gratuita de cada serviço (sem cartão). */
const HOW_TO: Record<FreeService["id"], { url: string; site: string; steps: string; note?: string }> = {
  gemini: {
    url: "https://aistudio.google.com/apikey",
    site: "aistudio.google.com/apikey",
    steps: "Entre com sua conta Google e toque em “Create API key”.",
    note: "No nível gratuito o Google pode usar o texto enviado para melhorar os produtos dele.",
  },
  github: {
    url: "https://github.com/settings/personal-access-tokens/new",
    site: "github.com/settings/personal-access-tokens/new",
    steps:
      "Dê um nome (ex.: Verso), em “Permissions” toque em “Add permissions”, escolha “Models” e deixe “Read-only”. Toque em “Generate token” e copie.",
    note: "Usa a sua conta do GitHub. O teste gasta 1 pedido da cota do dia.",
  },
  groq: {
    url: "https://console.groq.com/keys",
    site: "console.groq.com/keys",
    steps: "Crie uma conta gratuita (sem cartão) e toque em “Create API Key”.",
  },
};

export function FreeServiceCard({
  service,
  onChange,
  endpoint = "/api/settings",
}: {
  service: FreeService;
  onChange: (payload: unknown) => void;
  endpoint?: string;
}) {
  const [draft, setDraft] = useState("");
  const [state, setState] = useState<{ busy: boolean; message: string; ok?: boolean }>({ busy: false, message: "" });
  const how = HOW_TO[service.id];
  const quota = quotaText(service.quota);

  const put = async (body: Record<string, string>) => {
    const d = await api<unknown>(endpoint, { method: "PUT", json: body });
    onChange(d);
  };

  const saveKey = async (value: string) => {
    setState({ busy: true, message: "" });
    try {
      await put({ [KEY_FIELD[service.id]]: value });
      setDraft("");
      if (!value) return setState({ busy: false, message: "Chave removida." });
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

  return (
    <div className="rounded-2xl border border-rule px-4 py-4 sm:px-5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[1rem] font-medium text-ink">{service.label}</h3>
        <span className={`shrink-0 text-[0.75rem] ${service.hasKey ? "text-ok" : "text-muted"}`}>{service.hasKey ? "Pronto" : "Sem chave"}</span>
      </div>

      {service.hasKey ? (
        <>
          <p className="mt-1 text-[0.875rem] text-ink-2">
            Chave <span className="num text-muted">{service.keyHint}</span>
            {service.fromEnv && <span className="text-muted"> (variável de ambiente)</span>}
          </p>
          {quota && (
            <p className={`mt-1 text-[0.875rem] ${quota.tone === "out" ? "text-accent" : quota.tone === "low" ? "text-ink" : "text-ok"}`}>
              {quota.text}
            </p>
          )}
        </>
      ) : (
        <p className="mt-1.5 text-[0.875rem] leading-relaxed text-ink-2">
          Abra{" "}
          <a href={how.url} target="_blank" rel="noreferrer" className="link text-ink">
            {how.site}
          </a>
          . {how.steps}
        </p>
      )}
      {how.note && <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-muted">{how.note}</p>}

      {!service.fromEnv && (
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="block flex-1">
            <span className="label">{service.hasKey ? "Trocar chave" : "Chave"}</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Cole a chave aqui"
              className="mt-1.5 w-full border-b border-rule-strong bg-transparent py-2 text-[1rem] text-ink outline-none focus:border-ink"
            />
          </label>
          <Button size="sm" onClick={() => saveKey(draft)} disabled={state.busy || !draft.trim()}>
            {state.busy ? "Testando…" : "Salvar e testar"}
          </Button>
        </div>
      )}
      {state.message && <p className={`mt-3 text-[0.875rem] ${state.ok === false ? "text-accent" : "text-ok"}`}>{state.message}</p>}

      {service.hasKey && (
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

      {service.hasKey && !service.fromEnv && (
        <button onClick={() => saveKey("")} className="link mt-3 text-[0.8125rem] text-muted hover:text-ink">
          Remover chave
        </button>
      )}
    </div>
  );
}
