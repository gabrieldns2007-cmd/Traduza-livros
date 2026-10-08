import Link from "next/link";

/** Logo tipográfico: “Verso” com o ponto final em vermelho de rubrica. */
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <Link href="/" aria-label="Verso — início" className={`serif text-[1.45rem] leading-none tracking-[-0.02em] text-ink ${className}`}>
      Verso<span className="text-accent">.</span>
    </Link>
  );
}
