/**
 * Idiomas suportados. `label` é o nome do idioma nele mesmo (como aparece na
 * interface: “English → Português (Brasil)”); `english` é usado nos prompts.
 */
export interface Language {
  code: string;
  label: string;
  english: string;
  /** script que precisa de fonte própria no PDF */
  script?: "cjk" | "rtl";
  /** código ISO 639-3 usado pelo detector (franc) */
  iso3?: string;
}

export const LANGUAGES: Language[] = [
  { code: "pt-BR", label: "Português (Brasil)", english: "Brazilian Portuguese", iso3: "por" },
  { code: "pt-PT", label: "Português (Portugal)", english: "European Portuguese" },
  { code: "en", label: "English", english: "English", iso3: "eng" },
  { code: "es", label: "Español", english: "Spanish", iso3: "spa" },
  { code: "fr", label: "Français", english: "French", iso3: "fra" },
  { code: "de", label: "Deutsch", english: "German", iso3: "deu" },
  { code: "it", label: "Italiano", english: "Italian", iso3: "ita" },
  { code: "nl", label: "Nederlands", english: "Dutch", iso3: "nld" },
  { code: "ca", label: "Català", english: "Catalan", iso3: "cat" },
  { code: "ro", label: "Română", english: "Romanian", iso3: "ron" },
  { code: "pl", label: "Polski", english: "Polish", iso3: "pol" },
  { code: "cs", label: "Čeština", english: "Czech", iso3: "ces" },
  { code: "hu", label: "Magyar", english: "Hungarian", iso3: "hun" },
  { code: "sv", label: "Svenska", english: "Swedish", iso3: "swe" },
  { code: "da", label: "Dansk", english: "Danish", iso3: "dan" },
  { code: "nb", label: "Norsk", english: "Norwegian (Bokmål)", iso3: "nob" },
  { code: "fi", label: "Suomi", english: "Finnish", iso3: "fin" },
  { code: "el", label: "Ελληνικά", english: "Greek", iso3: "ell" },
  { code: "ru", label: "Русский", english: "Russian", iso3: "rus" },
  { code: "uk", label: "Українська", english: "Ukrainian", iso3: "ukr" },
  { code: "tr", label: "Türkçe", english: "Turkish", iso3: "tur" },
  { code: "la", label: "Latina", english: "Latin" },
  { code: "ja", label: "日本語", english: "Japanese", script: "cjk", iso3: "jpn" },
  { code: "zh", label: "中文（简体）", english: "Simplified Chinese", script: "cjk", iso3: "cmn" },
  { code: "ko", label: "한국어", english: "Korean", script: "cjk", iso3: "kor" },
];

const byCode = new Map(LANGUAGES.map((l) => [l.code.toLowerCase(), l]));

/** Encontra um idioma por código BCP-47 aproximado (“en-US” → English, “pt” → pt-BR). */
export function findLanguage(code: string | null | undefined): Language | undefined {
  if (!code) return undefined;
  const c = code.trim().toLowerCase().replace("_", "-");
  if (byCode.has(c)) return byCode.get(c);
  if (c === "pt" || c.startsWith("pt-")) return c === "pt-pt" ? byCode.get("pt-pt") : byCode.get("pt-br");
  if (c.startsWith("zh")) return byCode.get("zh");
  if (c === "no" || c === "nn") return byCode.get("nb");
  const base = c.split("-")[0];
  return byCode.get(base);
}

export function languageLabel(code: string | null | undefined, fallback = "Detectar automaticamente"): string {
  return findLanguage(code)?.label ?? (code ? code : fallback);
}

export function languageEnglishName(code: string | null | undefined): string {
  return findLanguage(code)?.english ?? code ?? "the original language";
}

export function fromIso3(iso3: string): Language | undefined {
  return LANGUAGES.find((l) => l.iso3 === iso3);
}

export const DEFAULT_TARGET = "pt-BR";
