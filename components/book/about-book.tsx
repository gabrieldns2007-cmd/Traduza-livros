import type { BookProfile } from "@/types/book";

export function AboutBook({ profile }: { profile: BookProfile }) {
  const rows = [
    ["Gênero", profile.genre],
    ["Tom", profile.tone],
    ["Narração", profile.narrativeVoice],
    ["Estilo", profile.styleNotes],
  ].filter(([, v]) => v);
  return (
    <section className="mt-16">
      <h2 className="label">Sobre o livro</h2>
      {profile.synopsis && <p className="serif mt-4 text-[1.125rem] leading-relaxed text-ink-2 italic">{profile.synopsis}</p>}
      <dl className="mt-5 divide-y divide-rule border-y border-rule">
        {rows.map(([k, v]) => (
          <div key={k} className="grid gap-1 py-3.5 sm:grid-cols-[7rem_1fr] sm:gap-4">
            <dt className="text-[0.8125rem] text-muted">{k}</dt>
            <dd className="text-[0.9375rem] leading-relaxed text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-[0.75rem] text-muted">Notas usadas pelo tradutor para manter tom e estilo ao longo do livro.</p>
    </section>
  );
}
