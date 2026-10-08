"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { BookSummary } from "@/types/book";
import { LANGUAGES, languageLabel } from "@/lib/languages";
import { api } from "@/lib/client";
import { formatBytes, formatNumber } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ProgressBar } from "@/components/ui/progress-bar";
import { ArrowRight, Chevron } from "@/components/ui/icons";
import { ProviderPicker, type ProviderChoice } from "@/components/book/provider-picker";

type Phase =
  | { kind: "idle" }
  | { kind: "uploading"; file: File; progress: number }
  | { kind: "ready"; file: File; book: BookSummary }
  | { kind: "error"; message: string };

export interface FlowDefaults {
  targetLanguage: string;
  dialogueStyle: "target" | "source";
  deepContext: boolean;
  instructions: string;
  maxUploadMb: number;
  demo: boolean;
}

function uploadWithProgress(file: File, target: string, source: string, onProgress: (p: number) => void): Promise<BookSummary> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/books");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data: { book?: BookSummary; error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* resposta vazia */
      }
      if (xhr.status === 401) window.location.href = "/entrar";
      if (xhr.status >= 200 && xhr.status < 300 && data.book) resolve(data.book);
      else reject(new Error(data.error ?? "Não foi possível enviar o arquivo."));
    };
    xhr.onerror = () => reject(new Error("A conexão caiu durante o envio. Tente novamente."));
    const form = new FormData();
    form.append("file", file);
    form.append("targetLanguage", target);
    form.append("sourceLanguage", source);
    xhr.send(form);
  });
}

export function TranslateFlow({ defaults }: { defaults: FlowDefaults }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const [source, setSource] = useState("auto");
  const [target, setTarget] = useState(defaults.targetLanguage);
  const [moreOpen, setMoreOpen] = useState(false);
  const [instructions, setInstructions] = useState(defaults.instructions);
  const [dialogueStyle, setDialogueStyle] = useState(defaults.dialogueStyle);
  const [deepContext, setDeepContext] = useState(defaults.deepContext);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");
  const [choice, setChoice] = useState<ProviderChoice | null>(null);

  const pick = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      if (!/\.(epub|pdf)$/i.test(file.name)) {
        setPhase({ kind: "error", message: "Esse formato ainda não é aceito. Escolha um arquivo .epub ou .pdf." });
        return;
      }
      if (file.size > defaults.maxUploadMb * 1024 * 1024) {
        setPhase({ kind: "error", message: `O arquivo passa do limite de ${defaults.maxUploadMb} MB.` });
        return;
      }
      setPhase({ kind: "uploading", file, progress: 0 });
      try {
        const book = await uploadWithProgress(file, target, source, (progress) => setPhase({ kind: "uploading", file, progress }));
        setPhase({ kind: "ready", file, book });
      } catch (err) {
        setPhase({ kind: "error", message: (err as Error).message });
      }
    },
    [defaults.maxUploadMb, source, target],
  );

  const reset = async () => {
    if (phase.kind === "ready") {
      // descarta o rascunho que não chegou a ser traduzido
      void api(`/api/books/${phase.book.id}`, { method: "DELETE" }).catch(() => undefined);
    }
    setPhase({ kind: "idle" });
    setStartError("");
    if (inputRef.current) inputRef.current.value = "";
  };

  const start = async () => {
    if (phase.kind !== "ready") return;
    setStarting(true);
    setStartError("");
    try {
      await api(`/api/books/${phase.book.id}/translate`, {
        method: "POST",
        json: {
          action: "start",
          targetLanguage: target,
          sourceLanguage: source,
          options: { instructions, dialogueStyle, deepContext },
          providerId: choice?.providerId,
          confirmCost: choice?.confirmCost,
        },
      });
      router.push(`/livros/${phase.book.id}`);
    } catch (err) {
      setStartError((err as Error).message);
      setStarting(false);
    }
  };

  const detected = phase.kind === "ready" ? phase.book.detectedLanguage : null;
  const sameLanguage = phase.kind === "ready" && (source === "auto" ? detected : source)?.split("-")[0] === target.split("-")[0];

  return (
    <div className="w-full">
      <input
        ref={inputRef}
        type="file"
        accept=".epub,.pdf,application/epub+zip,application/pdf"
        className="sr-only"
        onChange={(e) => pick(e.target.files?.[0])}
        aria-label="Escolher arquivo"
      />

      {/* ---------- área de envio ---------- */}
      {(phase.kind === "idle" || phase.kind === "error") && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            pick(e.dataTransfer.files?.[0]);
          }}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
          className={`group relative cursor-pointer rounded-[1.25rem] border px-6 py-12 text-center transition-colors duration-300 sm:py-16 ${
            dragging ? "border-accent bg-accent-soft/50" : "border-rule-strong hover:border-ink-2 hover:bg-paper-2/60"
          }`}
        >
          <BookGlyph />
          <p className="serif mt-5 text-[1.55rem] leading-tight tracking-[-0.01em] text-ink sm:text-[1.75rem]">
            <span className="[@media(pointer:coarse)]:hidden">Arraste seu livro aqui</span>
            <span className="hidden [@media(pointer:coarse)]:inline">Escolha um livro para começar</span>
          </p>
          <p className="mt-3 text-[0.9375rem] text-ink-2">
            <span className="[@media(pointer:coarse)]:hidden">ou </span>
            <span className="link text-ink">escolher arquivo</span>
          </p>
          <p className="label mt-7">EPUB ou PDF · até {defaults.maxUploadMb} MB</p>
          {phase.kind === "error" && (
            <p className="rise mx-auto mt-5 max-w-sm text-[0.9375rem] text-accent" role="alert">
              {phase.message}
            </p>
          )}
        </div>
      )}

      {/* ---------- enviando / lendo ---------- */}
      {phase.kind === "uploading" && (
        <div className="rise rounded-[1.25rem] border border-rule px-6 py-10 sm:px-10">
          <p className="label">{phase.progress < 1 ? "Enviando" : "Lendo o livro"}</p>
          <p className="serif mt-3 truncate text-[1.35rem] text-ink">{phase.file.name}</p>
          <ProgressBar value={phase.progress < 1 ? phase.progress * 85 : 92} active className="mt-6" />
          <p className="mt-3 text-[0.875rem] text-muted">
            {phase.progress < 1 ? `${Math.round(phase.progress * 100)}% de ${formatBytes(phase.file.size)}` : "Identificando capítulos e estrutura…"}
          </p>
        </div>
      )}

      {/* ---------- pronto para começar ---------- */}
      {phase.kind === "ready" && (
        <div className="rise">
          <div className="rounded-[1.25rem] border border-rule px-6 py-7 sm:px-9 sm:py-8">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="label">Seu livro</p>
                <h2 className="serif mt-2 text-[1.75rem] leading-[1.15] tracking-[-0.015em] text-ink text-balance sm:text-[2rem]">
                  {phase.book.title}
                </h2>
                {phase.book.author && <p className="serif mt-1 text-[1.0625rem] text-ink-2 italic">{phase.book.author}</p>}
              </div>
            </div>
            <div className="mt-6 border-t border-rule pt-4">
              <p className="truncate text-[0.875rem] text-ink-2">{phase.file.name}</p>
              <p className="num mt-1 text-[0.8125rem] text-muted">
                {formatBytes(phase.file.size)} · {phase.book.originalFormat.toUpperCase()} · {phase.book.chapters}{" "}
                {phase.book.chapters === 1 ? "capítulo" : "capítulos"} · {formatNumber(phase.book.words)} palavras
              </p>
              <button onClick={reset} className="link mt-3 text-[0.8125rem] text-muted hover:text-ink">
                Trocar arquivo
              </button>
            </div>
          </div>

          <div className="mt-9 grid gap-7 sm:grid-cols-[1fr_auto_1fr] sm:items-end sm:gap-5">
            <Select
              label="Idioma original"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              hint={detected ? `Detectamos: ${languageLabel(detected)}` : undefined}
            >
              <option value="auto">Detectar automaticamente</option>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </Select>
            <ArrowRight className="mx-auto hidden h-5 w-5 text-muted sm:mb-3 sm:block" />
            <Select label="Traduzir para" value={target} onChange={(e) => setTarget(e.target.value)} hint={detected ? " " : undefined}>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </Select>
          </div>

          {sameLanguage && <p className="mt-4 text-[0.875rem] text-accent">O livro parece já estar neste idioma.</p>}

          {/* opções avançadas */}
          <div className="mt-8 border-t border-rule">
            <button
              type="button"
              onClick={() => setMoreOpen((v) => !v)}
              className="flex w-full items-center justify-between py-4 text-left text-[0.9375rem] text-ink-2 hover:text-ink"
              aria-expanded={moreOpen}
            >
              Ajustes da tradução
              <Chevron className={`h-4 w-4 transition-transform duration-300 ${moreOpen ? "rotate-180" : ""}`} />
            </button>
            {moreOpen && (
              <div className="rise space-y-6 pb-6">
                <label className="block">
                  <span className="label">Instruções para o tradutor</span>
                  <textarea
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    rows={3}
                    placeholder="Ex.: use “você”, nunca “tu”. Mantenha os termos de esgrima em francês."
                    className="serif mt-2 w-full resize-y rounded-xl border border-rule bg-transparent px-4 py-3 text-[1.0625rem] leading-relaxed text-ink placeholder:text-muted/80 focus:border-ink-2 focus:outline-none"
                  />
                </label>
                <div>
                  <span className="label">Diálogos</span>
                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {(
                      [
                        ["target", "Padrão do idioma", "Ex.: travessão nos diálogos em português"],
                        ["source", "Como no original", "Mantém aspas, só ajusta o estilo"],
                      ] as const
                    ).map(([v, title, desc]) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setDialogueStyle(v)}
                        className={`rounded-xl border px-4 py-3 text-left transition-colors ${dialogueStyle === v ? "border-ink" : "border-rule hover:border-rule-strong"}`}
                      >
                        <span className="block text-[0.9375rem] text-ink">{title}</span>
                        <span className="mt-0.5 block text-[0.8125rem] text-muted">{desc}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <Switch
                  checked={deepContext}
                  onChange={setDeepContext}
                  label="Leitura atenta de cada capítulo"
                  description="Antes de traduzir, o capítulo é lido para resumir a história e encontrar nomes novos. Mais consistência, custo um pouco maior."
                />
              </div>
            )}
          </div>

          <div className="mt-8">
            <ProviderPicker bookId={phase.book.id} onChange={setChoice} />
          </div>

          <div className="mt-6 flex flex-col items-stretch gap-4 sm:flex-row sm:items-center">
            <Button onClick={start} disabled={starting || !choice?.ready} className="w-full sm:w-auto">
              {starting ? "Começando…" : "Começar tradução"}
              {!starting && <ArrowRight />}
            </Button>
            <p className="text-center text-[0.8125rem] leading-snug text-muted sm:text-left">
              A tradução continua no servidor, mesmo se você fechar esta página.
            </p>
          </div>
          {startError && (
            <p className="mt-4 text-[0.9375rem] text-accent" role="alert">
              {startError}
            </p>
          )}
          {defaults.demo && (
            <p className="mt-6 rounded-xl bg-paper-2 px-4 py-3 text-[0.8125rem] leading-relaxed text-ink-2">
              <strong className="font-medium text-ink">Modo demonstração.</strong> Nenhum provedor de IA está configurado, então o texto será copiado
              sem tradução — útil para testar o fluxo. Configure uma chave em <code className="text-[0.75rem]">.env.local</code>.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Pequeno desenho tipográfico: três lombadas de livro. */
function BookGlyph() {
  return (
    <svg viewBox="0 0 64 40" className="mx-auto h-9 w-14 text-ink-2 transition-transform duration-500 group-hover:-translate-y-0.5" aria-hidden>
      <g fill="none" stroke="currentColor" strokeWidth="1.3">
        <rect x="14" y="6" width="9" height="30" rx="1.2" />
        <rect x="25" y="3" width="8" height="33" rx="1.2" />
        <path d="M36.5 8.5l7.6-2.1 7.7 28.3-7.6 2z" />
        <path d="M8 36.5h48" strokeLinecap="round" />
      </g>
      <path d="M27 9h4M27 11.5h4" stroke="var(--accent)" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}
