import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

type Variant = "primary" | "secondary" | "quiet";
type Size = "sm" | "md" | "lg";

/**
 * Ações do Verso. Tudo o que FAZ algo é botão (área de toque de pelo menos
 * 44 px, resposta ao toque, foco visível); navegação de texto continua link.
 */
const base =
  "inline-flex select-none items-center justify-center gap-2 rounded-full font-medium tracking-[-0.005em] whitespace-nowrap transition-[background-color,color,border-color,box-shadow,opacity,transform] duration-200 ease-out active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40";
const variants: Record<Variant, string> = {
  primary: "bg-ink text-paper shadow-[0_1px_0_rgba(255,255,255,0.06)_inset,0_6px_18px_-8px_rgba(0,0,0,0.45)] hover:bg-ink/88 active:bg-ink/80",
  secondary: "border border-rule-strong bg-paper text-ink hover:border-ink hover:bg-paper-2 active:bg-paper-3",
  quiet: "text-ink-2 hover:bg-paper-2 hover:text-ink active:bg-paper-3",
};
const sizes: Record<Size, string> = {
  sm: "h-11 px-5 text-[0.875rem]",
  md: "h-12 px-7 text-[0.9375rem]",
  lg: "h-14 px-8 text-[1rem]",
};

export function buttonClass({ variant = "primary", size = "md", className = "" }: { variant?: Variant; size?: Size; className?: string } = {}) {
  return `${base} ${variants[variant]} ${sizes[size]} ${className}`;
}

export function Button({ variant = "primary", size = "md", className = "", ...props }: ComponentProps<"button"> & { variant?: Variant; size?: Size }) {
  return <button className={buttonClass({ variant, size, className })} {...props} />;
}

export function ButtonLink({
  variant = "primary",
  size = "md",
  className = "",
  href,
  children,
  download,
}: {
  variant?: Variant;
  size?: Size;
  className?: string;
  href: string;
  children: ReactNode;
  download?: boolean;
}) {
  if (download) {
    return (
      <a href={href} download className={buttonClass({ variant, size, className })}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={buttonClass({ variant, size, className })}>
      {children}
    </Link>
  );
}
