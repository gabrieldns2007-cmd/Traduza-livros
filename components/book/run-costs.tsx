import type { TranslationRun } from "@/types/book";
import { formatNumber } from "@/lib/format";

const SERVICE: Record<string, string> = {
  gemini: "Gemini",
  github: "GitHub Models",
  groq: "Groq",
  anthropic: "Anthropic",
  openai: "OpenAI",
  demo: "Demonstração",
};

function usd(v: number) {
  return v < 0.01 ? "< US$ 0,01" : `US$ ${v.toFixed(2).replace(".", ",")}`;
}

/**
 * Custos desta tradução (visão do dono do Verso): o que cada execução consumiu
 * e quanto custou pela tabela de preços — a base para conferir a margem real.
 */
export function RunCosts({ runs, words }: { runs: TranslationRun[]; words: number }) {
  if (!runs.length) return null;
  const total = runs.reduce(
    (t, r) => ({
      inputTokens: t.inputTokens + r.inputTokens,
      outputTokens: t.outputTokens + r.outputTokens,
      cost: t.cost + (r.costUsd ?? 0),
      words: t.words + r.words,
      ms: t.ms + r.activeMs,
      value: t.value + r.credits.valueMilli,
    }),
    { inputTokens: 0, outputTokens: 0, cost: 0, words: 0, ms: 0, value: 0 },
  );
  const per1k = total.words ? (total.cost / total.words) * 1000 : 0;
  const byok = runs.every((r) => r.billing !== "hosted");
  const demoOnly = runs.every((r) => r.billing === "none");

  return (
    <section className="mt-16">
      <h2 className="label">Custos desta tradução</h2>
      <p className="mt-2 text-[0.8125rem] leading-relaxed text-muted">
        {demoOnly
          ? "Modo demonstração: nenhum serviço de IA foi usado."
          : byok
            ? "Feita com a chave gratuita da própria pessoa: custo zero para você. Abaixo, quanto custaria pela tabela de preços."
            : "Pela tabela de preços dos modelos. Compare com o valor em créditos para ver a margem."}
      </p>
      <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div>
          <dt className="label">Custo</dt>
          <dd className="serif num mt-1 text-[1.25rem] text-ink">{usd(total.cost)}</dd>
          <dd className="text-[0.8125rem] text-muted">{usd(per1k)} / mil palavras</dd>
        </div>
        <div>
          <dt className="label">Tokens</dt>
          <dd className="serif num mt-1 text-[1.25rem] text-ink">{formatNumber(total.inputTokens + total.outputTokens)}</dd>
          <dd className="num text-[0.8125rem] text-muted">
            {formatNumber(total.inputTokens)} entrada · {formatNumber(total.outputTokens)} saída
          </dd>
        </div>
        <div>
          <dt className="label">Palavras</dt>
          <dd className="serif num mt-1 text-[1.25rem] text-ink">{formatNumber(total.words)}</dd>
          <dd className="num text-[0.8125rem] text-muted">de {formatNumber(words)}</dd>
        </div>
        <div>
          <dt className="label">Em créditos</dt>
          <dd className="serif num mt-1 text-[1.25rem] text-ink">{formatNumber(Math.ceil(total.value / 1000))}</dd>
          <dd className="text-[0.8125rem] text-muted">{Math.round(total.ms / 60000)} min de processamento</dd>
        </div>
      </dl>
      <ul className="mt-5 divide-y divide-rule border-y border-rule">
        {runs
          .slice()
          .reverse()
          .slice(0, 8)
          .map((r) => (
            <li key={r.id} className="flex items-baseline justify-between gap-4 py-2.5 text-[0.8125rem]">
              <span className="min-w-0 truncate text-ink-2">
                {r.kind === "preview" ? "Prévia" : "Tradução"} · {SERVICE[r.provider] ?? r.provider} · {r.model}
                <span className="text-muted"> · {new Date(r.startedAt).toLocaleDateString("pt-BR")}</span>
              </span>
              <span className="num shrink-0 text-ink-2">
                {formatNumber(r.words)} pal. · {r.costUsd === null ? "sem preço" : usd(r.costUsd)}
              </span>
            </li>
          ))}
      </ul>
    </section>
  );
}
