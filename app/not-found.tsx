import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto w-full max-w-[42rem] px-5 pt-16 pb-24 sm:px-8 sm:pt-24">
      <p className="label">Página não encontrada</p>
      <h1 className="serif mt-4 text-[2.4rem] leading-tight tracking-[-0.03em] text-ink">Esta página saiu da estante.</h1>
      <Link href="/livros" className="link mt-8 inline-block text-ink-2 hover:text-ink">
        Ver meus livros
      </Link>
    </main>
  );
}
