"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { LANGUAGES } from "@/lib/languages";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Check } from "@/components/ui/icons";

interface Payload {
  settings: { providerId?: string; targetLanguage: string; dialogueStyle: "target" | "source"; deepContext: boolean; instructions: string };
  providers: { id: string; label: string; available: boolean; model: string; hint?: string }[];
  activeProvider: { id: string; model: string };
  dataDir: string;
  authEnabled: boolean;
  maxUploadMb: number;
}

export function SettingsForm() {
  const [data, setData] = useState<Payload | null>(null);
  const [form, setForm] = useState<Payload["settings"] | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    api<Payload>("/api/settings").then((d) => {
      setData(d);
      setForm(d.settings);
    });
  }, []);

  if (!data || !form) return <div className="mt-12 h-64 animate-pulse rounded-2xl bg-paper-2" />;

  const update = (patch: Partial<Payload["settings"]>) => {
    setForm({ ...form, ...patch });
    setStatus("idle");
  };

  const save = async () => {
    setStatus("saving");
    try {
      const d = await api<Payload>("/api/settings", { method: "PUT", json: { ...form, providerId: form.providerId ?? data.activeProvider.id } });
      setData(d);
      setForm(d.settings);
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  };

  const selected = form.providerId ?? data.activeProvider.id;

  return (
    <div className="rise mt-10 sm:mt-14">
      <Section title="Tradução" note="Chaves de API ficam apenas no servidor, no arquivo .env.local — nunca no navegador.">
        <div className="space-y-2" role="radiogroup" aria-label="Provedor de IA">
          {data.providers.map((p) => {
            const isSel = selected === p.id;
            return (
              <button
                key={p.id}
                role="radio"
                aria-checked={isSel}
                disabled={!p.available}
                onClick={() => update({ providerId: p.id })}
                className={`flex w-full items-start gap-3 rounded-xl border px-4 py-3.5 text-left transition-colors disabled:cursor-not-allowed ${isSel ? "border-ink" : "border-rule hover:border-rule-strong"} ${!p.available ? "opacity-55" : ""}`}
              >
                <span
                  className={`mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${isSel ? "border-ink bg-ink" : "border-rule-strong"}`}
                >
                  {isSel && <span className="h-1.5 w-1.5 rounded-full bg-paper" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-[0.9375rem] text-ink">{p.label}</span>
                  <span className="mt-0.5 block text-[0.8125rem] text-muted">
                    {p.available ? (p.id === "demo" ? p.hint : `Modelo: ${p.model}`) : p.hint}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
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
            description="Resume cada capítulo e amplia o glossário antes de traduzir. Recomendado para ficção."
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
