/** Tela de carregamento editorial: aparece imediatamente ao navegar. */
export function PageLoading({ label = "Abrindo…" }: { label?: string }) {
  return (
    <main className="mx-auto w-full max-w-[44rem] px-5 pt-10 pb-24 sm:px-8 sm:pt-14" aria-busy="true" aria-live="polite">
      <div className="relative h-[3px] w-full overflow-hidden rounded-full bg-rule">
        <div className="shimmer absolute inset-y-0 w-1/3 rounded-full bg-accent/70" />
      </div>
      <p className="label mt-6">{label}</p>
      <div className="mt-6 space-y-3">
        <div className="h-9 w-3/4 animate-pulse rounded-lg bg-paper-2" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-paper-2" />
        <div className="mt-8 h-24 animate-pulse rounded-2xl bg-paper-2" />
      </div>
    </main>
  );
}
