import { decodeHTML } from "entities";

export function escapeXmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeXmlAttr(text: string): string {
  return escapeXmlText(text).replace(/"/g, "&quot;");
}

const BASIC: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Decodifica entidades básicas e numéricas (o que um modelo costuma devolver). */
export function decodeBasicEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body[0] === "#") {
      const cp = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return BASIC[body] ?? m;
  });
}

const XML_ENTITIES = new Set(["amp", "lt", "gt", "quot", "apos"]);

/**
 * Livros EPUB 2 costumam usar entidades HTML (&nbsp;, &mdash;…) que não são
 * válidas em XML puro. Convertemos todas para referências numéricas antes
 * de fazer o parse.
 */
export function normalizeHtmlEntities(source: string): string {
  return source.replace(/&([A-Za-z][A-Za-z0-9]{1,31});/g, (m, name: string) => {
    if (XML_ENTITIES.has(name)) return m;
    const decoded = decodeHTML(m);
    if (decoded === m) return "&amp;" + name + ";"; // entidade desconhecida: mantém o texto visível
    return [...decoded].map((ch) => `&#x${ch.codePointAt(0)!.toString(16)};`).join("");
  });
}

/** Escapa “&” soltos (que não iniciam uma entidade) — comum em XHTML malformado. */
export function fixBareAmpersands(source: string): string {
  return source.replace(/&(?!(#x[0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);)/g, "&amp;");
}

/** Decodifica bytes de um documento XML/XHTML respeitando BOM e declaração de encoding. */
export function decodeXmlBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 200));
  const m = head.match(/<\?xml[^>]*encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/i);
  const enc = m?.[1]?.toLowerCase();
  if (enc && enc !== "utf-8" && enc !== "utf8") {
    try {
      return new TextDecoder(enc).decode(bytes);
    } catch {
      /* encoding desconhecido: tenta UTF-8 */
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/** Garante que a declaração XML (se houver) diga UTF-8, já que salvamos tudo em UTF-8. */
export function forceUtf8Declaration(source: string): string {
  return source.replace(/^(\s*<\?xml[^>]*?encoding\s*=\s*["'])([^"']+)(["'])/i, "$1utf-8$3");
}
