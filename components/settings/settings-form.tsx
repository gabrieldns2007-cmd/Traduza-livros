"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { LANGUAGES } from "@/lib/languages";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Check } from "@/components/ui/icons";

interface Payload {
  settings: {
    providerId?: string;
    targetLanguage: string;
    dialogueStyle: "target" | "source";
    deepContext: boolean;
    instructions: string;
    geminiModel?: string;
  };
  gemini: { hasKey: boolean; keyHint: string; fromEnv: boolean; models: { id: string; label: string; note: string }[] };
  providers: { id: string; label: string; available: boolean; paid: boolean; model: string; hint?: string }[];
  defaultProvider: string;
  dataDir: string;
  authEnabled: boolean;
  maxUploadMb: number;
}

export function SettingsForm() {
  const [data, setData] = useState<Payload | null>(null);
  const [form, setForm] = useState<Payload["settings"] | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [loadError, setLoadError] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [keyState, setKeyState] = useState<{ busy: boolean; message: string; ok?: boolean }>({ busy: false, message: "" });

  useEffect(() => {
    api<Payload>("/api/settings")
      .then((d) => {
        setData(d);
        setForm(d.settings);
      })
      .catch((e) => setLoadError((e as Error).message));
  }, []);

  if (loadError) return <p className="mt-12 text-[0.9375rem] text-accent">Não foi possível carregar as configurações: {loadError}</p>;
  if (!data || !form) return <div className="mt-12 h-64 animate-pulse rounded-2xl bg-paper-2" aria-label="Carregando" />;

  const update = (patch: Partial<Payload["settings"]>) => {
    setForm({ ...form, ...patch });
    setStatus("idle");
  };

  const save = async () => {
    setStatus("saving");
    try {
      const d = await api<Payload>("/api/settings", { method: "PUT", json: form });
      setData(d);
      setForm(d.settings);
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  };

  const saveKey = async (value: string) => {
    setKeyState({ busy: true, message: "" });
    try {
      const d = await api<Payload>("/api/settings", { method: "PUT", json: { geminiApiKey: value } });
      setData(d);
      setKeyDraft("");
      if (!value) return setKeyState({ busy: false, message: "Chave removida." });
      const test = await api<{ ok: boolean; message?: string; models?: { id: string; available: boolean }[] }>("/api/settings", { method: "POST" });
      setKeyState({
        busy: false,
        ok: test.ok,
        message: test.ok ? "Chave salva e funcionando. Gemini Free está pronto." : (test.message ?? "A chave não funcionou."),
      });
    } catch (err) {
      setKeyState({ busy: false, message: (err as Error).message, ok: false });
    }
  };

  const freeDefault =
    form.providerId && data.providers.find((p) => p.id === form.providerId && !p.paid && p.available) ? form.providerId : data.defaultProvider;

  return (
    <div className="rise mt-10 sm:mt-14">
      <Section title="Gemini Free" note="Tradução gratuita do Google, sem cartão. A chave fica só no servidor — nunca volta para o navegador.">
        {data.gemini.hasKey ? (
          <p className="text-[0.9375rem] text-ink">
            Chave configurada <span className="num text-muted">{data.gemini.keyHint}</span>
            {data.gemini.fromEnv && <span className="text-muted"> (variável de ambiente)</span>}
          </p>
        ) : (
          <p className="text-[0.9375rem] text-ink-2">
            Crie uma chave gratuita em{" "}
            <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="link text-ink">
              aistudio.google.com/apikey
            </a>{" "}
            (botão “Create API key”) e cole aqui.
          </p>
        )}
        {!data.gemini.fromEnv && (
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="block flex-1">
              <span className="label">{data.gemini.hasKey ? "Trocar chave" : "Chave da API"}</span>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                placeholder="Cole a chave aqui"
                className="mt-1.5 w-full border-b border-rule-strong bg-transparent py-2 text-[1rem] text-ink outline-none focus:border-ink"
              />
            </label>
            <Button onClick={() => saveKey(keyDraft)} disabled={keyState.busy || !keyDraft.trim()} className="h-11 px-5 text-[0.875rem]">
              {keyState.busy ? "Testando…" : "Salvar e testar"}
            </Button>
          </div>
        )}
        {keyState.message && <p className={`mt-3 text-[0.875rem] ${keyState.ok === false ? "text-accent" : "text-ok"}`}>{keyState.message}</p>}
        {data.gemini.hasKey && !data.gemini.fromEnv && (
          <button onClick={() => saveKey("")} className="link mt-3 text-[0.8125rem] text-muted hover:text-ink">
            Remover chave
          </button>
        )}
        <div className="mt-6">
          <span className="label">Modelo</span>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {data.gemini.models.map((m) => {
              const sel = (form.geminiModel ?? data.gemini.models[0].id) === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => update({ geminiModel: m.id })}
                  className={`rounded-xl border px-4 py-3 text-left transition-colors active:bg-paper-2 ${sel ? "border-ink" : "border-rule hover:border-rule-strong"}`}
                >
                  <span className="block text-[0.9375rem] text-ink">{m.label}</span>
                  <span className="mt-0.5 block text-[0.8125rem] text-muted">{m.note}</span>
                </button>
              );
            })}
          </div>
        </div>
      </Section>

      <Section
        title="Provedores"
        note="O provedor é escolhido em cada livro, antes de começar. Provedores pagos sempre pedem confirmação e nunca são usados automaticamente."
      >
        <ul className="divide-y divide-rule border-y border-rule">
          {data.providers.map((p) => (
            <li key={p.id} className="flex items-baseline justify-between gap-4 py-3">
              <span className="min-w-0">
                <span className="block text-[0.9375rem] text-ink">
                  {p.label}
                  {p.id === freeDefault && <span className="ml-2 text-[0.75rem] text-muted">padrão</span>}
                </span>
                <span className="mt-0.5 block truncate text-[0.8125rem] text-muted">{p.available ? p.model : p.hint}</span>
              </span>
              <span className={`shrink-0 text-[0.75rem] ${p.paid ? "text-accent" : "text-ok"}`}>
                {p.paid ? "Pago" : "Gratuito"} {p.available ? "" : "· não configurado"}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Padrões para novos livros">
        <Select label="Traduzir para" value={form.targetLanguage} onChange={(e) => update({ targetLanguage: e.target.value })}>
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </Select>
        <div className="mt-7">
          <span className="label">Diálogos</span>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {(
              [
                ["target", "Padrão do idioma", "Ex.: travessão nos diálogos em português"],
                ["source", "Como no original", "Mantém aspas, só ajusta o estilo"],
              ] as const
            ).map(([v, title, desc]) => (
              <button
                key={v}
                onClick={() => update({ dialogueStyle: v })}
                className={`rounded-xl border px-4 py-3 text-left transition-colors ${form.dialogueStyle === v ? "border-ink" : "border-rule hover:border-rule-strong"}`}
              >
                <span className="block text-[0.9375rem] text-ink">{title}</span>
                <span className="mt-0.5 block text-[0.8125rem] text-muted">{desc}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="mt-7">
          <Switch
            checked={form.deepContext}
            onChange={(v) => update({ deepContext: v })}
            label="Leitura atenta de cada capítulo"
            description="Uma chamada extra por capítulo para resumir a história. Melhora a continuidade, mas gasta mais cota. Desligado por padrão."
          />
        </div>
        <label className="mt-7 block">
          <span className="label">Instruções padrão para o tradutor</span>
          <textarea
            value={form.instructions}
            onChange={(e) => update({ instructions: e.target.value })}
            rows={3}
            placeholder="Ex.: prefira um registro natural do português brasileiro contemporâneo."
            className="serif mt-2 w-full resize-y rounded-xl border border-rule bg-transparent px-4 py-3 text-[1.0625rem] leading-relaxed text-ink placeholder:text-muted/80 focus:border-ink-2 focus:outline-none"
          />
        </label>
      </Section>

      <div className="mt-10 flex items-center gap-4">
        <Button onClick={save} disabled={status === "saving"}>
          {status === "saving" ? "Salvando…" : "Salvar"}
        </Button>
        {status === "saved" && (
          <span className="fade-in inline-flex items-center gap-1.5 text-[0.875rem] text-ok">
            <Check /> Salvo
          </span>
        )}
        {status === "error" && <span className="text-[0.875rem] text-accent">Não foi possível salvar.</span>}
      </div>

      <Section title="Privacidade e arquivos">
        <p className="text-[0.9375rem] leading-relaxed text-ink-2">
          Seus livros ficam no servidor onde o Verso está rodando, na pasta{" "}
          <code className="rounded bg-paper-2 px-1.5 py-0.5 text-[0.8125rem]">{data.dataDir}</code>. O texto é enviado ao provedor de IA somente para
          ser traduzido. Não há contas nem rastreamento.
        </p>
        <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink-2">
          {data.authEnabled
            ? "O acesso está protegido por senha (APP_PASSWORD)."
            : "O acesso não tem senha. Se for usar fora da sua rede, defina APP_PASSWORD."}{" "}
          Limite de envio: {data.maxUploadMb} MB por arquivo.
        </p>
        {data.authEnabled && (
          <button
            onClick={async () => {
              await api("/api/auth", { method: "DELETE" });
              window.location.href = "/entrar";
            }}
            className="link mt-4 text-[0.875rem] text-muted hover:text-ink"
          >
            Sair deste aparelho
          </button>
        )}
      </Section>

      <Section title="Kindle">
        <p className="text-[0.9375rem] leading-relaxed text-ink-2">
          O EPUB gerado é compatível com o Kindle. Para enviar: use o app Kindle no celular (Compartilhar → Kindle), arraste o arquivo em{" "}
          <a href="https://www.amazon.com/sendtokindle" target="_blank" rel="noreferrer" className="link text-ink">
            amazon.com/sendtokindle
          </a>{" "}
          ou mande por e-mail para o endereço do seu Kindle.
        </p>
      </Section>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="mt-12 border-t border-rule pt-6 first:mt-0">
      <h2 className="label">{title}</h2>
      {note && <p className="mt-2 text-[0.8125rem] leading-relaxed text-muted">{note}</p>}
      <div className="mt-5">{children}</div>
    </section>
  );
}
