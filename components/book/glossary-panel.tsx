"use client";

import { useState } from "react";
import type { GlossaryEntry, GlossaryType } from "@/types/book";
import { api } from "@/lib/client";

const TYPE_LABELS: Record<GlossaryType, string> = {
  character: "Personagens",
  place: "Lugares",
  organization: "Organizações",
  term: "Termos",
  other: "Outros",
};
const ORDER: GlossaryType[] = ["character", "place", "organization", "term", "other"];

export function GlossaryPanel({
  bookId,
  entries,
  onChange,
  live,
}: {
  bookId: string;
  entries: GlossaryEntry[];
  onChange: (e: GlossaryEntry[]) => void;
  live: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ term: "", translation: "", type: "term" as GlossaryType, note: "" });
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");

  const groups = ORDER.map((t) => [t, entries.filter((e) => e.type === t)] as const).filter(([, list]) => list.length);
  const LIMIT = 14;
  let shown = 0;

  const save = async () => {
    setError("");
    try {
      const res = editing
        ? await api<{ entries: GlossaryEntry[] }>(`/api/books/${bookId}/glossary`, { method: "PATCH", json: { id: editing, ...draft } })
        : await api<{ entries: GlossaryEntry[] }>(`/api/books/${bookId}/glossary`, { method: "POST", json: draft });
      onChange(res.entries);
      setEditing(null);
      setAdding(false);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async (id: string) => {
    const res = await api<{ entries: GlossaryEntry[] }>(`/api/books/${bookId}/glossary?entry=${encodeURIComponent(id)}`, { method: "DELETE" });
    onChange(res.entries);
    setEditing(null);
  };

  const editor = (
    <div className="rise space-y-3 rounded-xl bg-paper-2 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <input
          value={draft.term}
          onChange={(e) => setDraft({ ...draft, term: e.target.value })}
          placeholder="Termo no original"
          className="serif w-full border-b border-rule-strong bg-transparent py-1.5 text-[1.0625rem] outline-none focus:border-ink"
        />
        <input
          value={draft.translation}
          onChange={(e) => setDraft({ ...draft, translation: e.target.value })}
          placeholder="Como traduzir"
          className="serif w-full border-b border-rule-strong bg-transparent py-1.5 text-[1.0625rem] outline-none focus:border-ink"
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {ORDER.map((t) => (
          <button
            key={t}
            onClick={() => setDraft({ ...draft, type: t })}
            className={`rounded-full px-3 py-1 text-[0.75rem] transition-colors ${draft.type === t ? "bg-ink text-paper" : "text-ink-2 hover:bg-paper-3"}`}
          >
            {TYPE_LABELS[t]}
          </button>
        ))}
      </div>
      <input
        value={draft.note}
        onChange={(e) => setDraft({ ...draft, note: e.target.value })}
        placeholder="Nota (opcional)"
        className="w-full border-b border-rule-strong bg-transparent py-1.5 text-[0.875rem] outline-none focus:border-ink"
      />
      {error && <p className="text-[0.8125rem] text-accent">{error}</p>}
      <div className="flex items-center gap-2 pt-1">
        <button onClick={save} className="rounded-full bg-ink px-4 py-1.5 text-[0.8125rem] text-paper">
          Salvar
        </button>
        <button
          onClick={() => {
            setEditing(null);
            setAdding(false);
          }}
          className="px-3 py-1.5 text-[0.8125rem] text-muted"
        >
          Cancelar
        </button>
        {editing && (
          <button onClick={() => remove(editing)} className="ml-auto px-2 py-1.5 text-[0.8125rem] text-muted hover:text-accent">
            Remover
          </button>
        )}
      </div>
    </div>
  );

  return (
    <section className="mt-16">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="label">Glossário</h2>
        <button
          onClick={() => {
            setAdding(true);
            setEditing(null);
            setDraft({ term: "", translation: "", type: "character", note: "" });
          }}
          className="link relative text-[0.8125rem] text-muted before:absolute before:-inset-x-2 before:-inset-y-3 before:content-[''] hover:text-ink"
        >
          Adicionar termo
        </button>
      </div>
      <p className="mt-2 text-[0.875rem] leading-relaxed text-muted">
        {entries.length
          ? "Nomes e termos mantidos iguais do começo ao fim. Toque em um termo para corrigir — vale para os próximos trechos traduzidos."
          : live
            ? "Os personagens, lugares e termos aparecem aqui conforme o livro é lido."
            : "Nenhum termo ainda."}
      </p>

      {adding && <div className="mt-4">{editor}</div>}

      {groups.map(([type, list]) => {
        if (!expanded && shown >= LIMIT) return null;
        const visible = expanded ? list : list.slice(0, Math.max(0, LIMIT - shown));
        shown += visible.length;
        return (
          <div key={type} className="mt-6">
            <h3 className="serif text-[0.9375rem] text-ink-2 italic">{TYPE_LABELS[type]}</h3>
            <ul className="mt-1.5 border-t border-rule">
              {visible.map((e) =>
                editing === e.id ? (
                  <li key={e.id} className="py-2">
                    {editor}
                  </li>
                ) : (
                  <li key={e.id} className="border-b border-rule">
                    <button
                      onClick={() => {
                        setEditing(e.id);
                        setAdding(false);
                        setDraft({ term: e.term, translation: e.translation, type: e.type, note: e.note ?? "" });
                      }}
                      className="grid w-full grid-cols-[1fr_auto_1fr] items-baseline gap-3 py-2.5 text-left transition-colors hover:bg-paper-2/70 sm:-mx-2 sm:w-[calc(100%+1rem)] sm:px-2"
                    >
                      <span className="serif truncate text-[1rem] text-ink">{e.term}</span>
                      <span className="text-[0.75rem] text-rule-strong">→</span>
                      <span className="serif truncate text-[1rem] text-ink-2">
                        {e.translation}
                        {e.origin === "user" && (
                          <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-accent align-middle" title="Editado por você" />
                        )}
                      </span>
                    </button>
                  </li>
                ),
              )}
            </ul>
          </div>
        );
      })}

      {entries.length > LIMIT && (
        <button onClick={() => setExpanded((v) => !v)} className="link mt-5 text-[0.875rem] text-ink-2 hover:text-ink">
          {expanded ? "Mostrar menos" : `Ver todos os ${entries.length} termos`}
        </button>
      )}
    </section>
  );
}
