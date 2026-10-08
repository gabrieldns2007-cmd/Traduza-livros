/**
 * Hifenização para o texto justificado do PDF: insere hifens condicionais
 * (U+00AD), que o pdfkit usa para quebrar palavras longas no fim da linha.
 */
type Hyphenate = (text: string) => string;

const LOADERS: Record<string, () => Promise<{ hyphenateSync: (t: string, o?: { minWordLength?: number }) => string }>> = {
  pt: () => import("hyphen/pt"),
  en: () => import("hyphen/en-us"),
  es: () => import("hyphen/es"),
  fr: () => import("hyphen/fr"),
  de: () => import("hyphen/de-1996"),
  it: () => import("hyphen/it"),
  nl: () => import("hyphen/nl"),
  ca: () => import("hyphen/ca"),
  ro: () => import("hyphen/ro"),
  pl: () => import("hyphen/pl"),
  cs: () => import("hyphen/cs"),
  hu: () => import("hyphen/hu"),
  sv: () => import("hyphen/sv"),
  da: () => import("hyphen/da"),
  nb: () => import("hyphen/nb"),
  fi: () => import("hyphen/fi"),
  el: () => import("hyphen/el-monoton"),
  ru: () => import("hyphen/ru"),
  uk: () => import("hyphen/uk"),
  tr: () => import("hyphen/tr"),
  la: () => import("hyphen/la"),
};

export async function getHyphenator(lang: string): Promise<Hyphenate> {
  const base = lang.toLowerCase().split("-")[0];
  const loader = LOADERS[base];
  if (!loader) return (t) => t;
  try {
    const mod = await loader();
    const fn = mod.hyphenateSync ?? (mod as unknown as { default: { hyphenateSync: typeof mod.hyphenateSync } }).default.hyphenateSync;
    return (text) => fn(text, { minWordLength: 7 });
  } catch {
    return (t) => t;
  }
}
