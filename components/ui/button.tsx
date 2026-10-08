import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

type Variant = "primary" | "secondary" | "quiet";

const base =
  "inline-flex items-center justify-center gap-2 rounded-full text-[0.9375rem] font-medium tracking-[-0.005em] transition-[background-color,color,border-color,opacity,transform] duration-200 active:scale-[0.985] disabled:opacity-40 disabled:active:scale-100";
const variants: Record<Variant, string> = {
  primary: "bg-ink text-paper hover:bg-ink/88 h-12 px-7",
  secondary: "border border-rule-strong text-ink hover:border-ink h-12 px-7",
  quiet: "text-ink-2 hover:text-ink h-10 px-3",
};

export function Button({ variant = "primary", className = "", ...props }: ComponentProps<"button"> & { variant?: Variant }) {
  return <button className={`${base} ${variants[variant]} ${className}`} {...props} />;
}

export function ButtonLink({
  variant = "primary",
  className = "",
  href,
  children,
  download,
}: {
  variant?: Variant;
  className?: string;
  href: string;
  children: ReactNode;
  download?: boolean;
}) {
  if (download) {
    return (
      <a href={href} download className={`${base} ${variants[variant]} ${className}`}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={`${base} ${variants[variant]} ${className}`}>
      {children}
    </Link>
  );
}
