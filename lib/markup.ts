/**
 * Marcação compacta dos segmentos.
 *
 * Cada parágrafo (ou título, item de lista…) do livro é guardado como texto
 * em que os elementos inline viram marcadores numerados:
 *
 *   Ele disse <em_3>baixinho</em_3>:<br_4/> — Venha.
 *
 * O número aponta para a tabela de tags do capítulo, que guarda a tag
 * original com todos os atributos (classes, ids, links). Assim:
 *   - o modelo de IA vê pouco ruído (economiza tokens e evita erros);
 *   - a reconstrução devolve exatamente a formatação original;
 *   - a interface consegue mostrar o texto com HTML seguro (sem atributos).
 *
 * No texto, apenas “<” e “>” são escapados (&lt; e &gt;).
 */
import type { InlineTag } from "@/types/book";
import { escapeXmlText, decodeBasicEntities } from "@/utils/xml";

export type Token =
  | { type: "text"; text: string }
  | { type: "open"; k: number; name: string }
  | { type: "close"; k: number; name: string }
  | { type: "void"; k: number; name: string };

const TAG_RE = /<\s*(\/?)\s*([A-Za-z][\w-]*)_(\d+)\s*(\/?)\s*>/g;

export function tokenize(markup: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const m of markup.matchAll(TAG_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) tokens.push({ type: "text", text: markup.slice(last, idx) });
    const [, closing, name, num, selfClosing] = m;
    const k = Number(num);
    if (closing) tokens.push({ type: "close", k, name });
    else if (selfClosing) tokens.push({ type: "void", k, name });
    else tokens.push({ type: "open", k, name });
    last = idx + m[0].length;
  }
  if (last < markup.length) tokens.push({ type: "text", text: markup.slice(last) });
  return tokens;
}

/** Texto puro (sem marcadores), com entidades básicas decodificadas. */
export function toPlainText(markup: string): string {
  return tokenize(markup)
    .map((t) => (t.type === "text" ? decodeBasicEntities(t.text) : ""))
    .join("");
}

/** Conjunto de índices de tags usados em uma marcação. */
export function tagKeys(markup: string): Set<number> {
  const keys = new Set<number>();
  for (const t of tokenize(markup)) if (t.type !== "text") keys.add(t.k);
  return keys;
}

export interface RepairResult {
  markup: string;
  /** tags da origem que não aparecem na tradução */
  missing: number[];
  /** problemas encontrados (tags desconhecidas, aninhamento quebrado…) */
  issues: number;
}

/**
 * Valida e conserta a marcação devolvida pelo modelo:
 *  - descarta marcadores desconhecidos;
 *  - trata tags vazias (br, img…) sempre como auto-fechadas;
 *  - fecha tags abertas e ignora fechamentos órfãos, garantindo aninhamento válido.
 */
export function repairMarkup(markup: string, tags: Record<string, InlineTag>, srcKeys: Set<number>): RepairResult {
  const out: string[] = [];
  const stack: number[] = [];
  let issues = 0;
  const seen = new Set<number>();

  for (const t of tokenize(markup)) {
    if (t.type === "text") {
      // normaliza: o texto não pode conter “<” ou “>” soltos
      out.push(escapeMarkupText(decodeBasicEntities(t.text)));
      continue;
    }
    const tag = tags[String(t.k)];
    if (!tag || !srcKeys.has(t.k)) {
      issues++;
      continue;
    }
    if (tag.v) {
      if (t.type === "close") continue; // </br_3> → ignora
      out.push(`<${safeName(tag.n)}_${t.k}/>`);
      seen.add(t.k);
      continue;
    }
    if (t.type === "void") {
      // <em_2/> de uma tag com conteúdo: vira par vazio, que é descartado
      issues++;
      continue;
    }
    if (t.type === "open") {
      stack.push(t.k);
      seen.add(t.k);
      out.push(`<${safeName(tag.n)}_${t.k}>`);
      continue;
    }
    // close
    const pos = stack.lastIndexOf(t.k);
    if (pos === -1) {
      issues++;
      continue;
    }
    while (stack.length > pos) {
      const k = stack.pop()!;
      if (k !== t.k) issues++;
      out.push(`</${safeName(tags[String(k)].n)}_${k}>`);
    }
  }
  while (stack.length) {
    const k = stack.pop()!;
    issues++;
    out.push(`</${safeName(tags[String(k)].n)}_${k}>`);
  }

  const missing = [...srcKeys].filter((k) => !seen.has(k));
  return { markup: out.join("").trim(), missing, issues };
}

/**
 * Último recurso quando o modelo perde tags: anexa ao final as tags vazias
 * que faltaram (âncoras, imagens, quebras), para não perder links nem imagens.
 */
export function appendMissingVoids(markup: string, missing: number[], tags: Record<string, InlineTag>): string {
  const extra = missing
    .filter((k) => tags[String(k)]?.v && tags[String(k)].n !== "br")
    .map((k) => `<${safeName(tags[String(k)].n)}_${k}/>`)
    .join("");
  return markup + extra;
}

/** Converte a marcação em XHTML usando as tags originais. */
export function renderXhtml(markup: string, tags: Record<string, InlineTag>, usedIds?: Set<string>): string {
  const ids = usedIds ?? new Set<string>();
  const parts: string[] = [];
  const stack: number[] = [];
  for (const t of tokenize(markup)) {
    if (t.type === "text") {
      parts.push(escapeXmlText(decodeBasicEntities(t.text)));
      continue;
    }
    const tag = tags[String(t.k)];
    if (!tag) continue;
    if (tag.v) {
      if (t.type !== "close") parts.push(dedupeId(tag.o, ids));
      continue;
    }
    if (t.type === "open") {
      stack.push(t.k);
      parts.push(dedupeId(tag.o, ids));
    } else if (t.type === "close") {
      const pos = stack.lastIndexOf(t.k);
      if (pos === -1) continue;
      while (stack.length > pos) {
        const k = stack.pop()!;
        parts.push(`</${tags[String(k)].n}>`);
      }
    }
  }
  while (stack.length) parts.push(`</${tags[String(stack.pop()!)].n}>`);
  return parts.join("");
}

/* ---------- HTML seguro para a interface ---------- */

const SAFE_INLINE: Record<string, string> = {
  em: "em",
  i: "em",
  cite: "em",
  dfn: "em",
  var: "em",
  strong: "strong",
  b: "strong",
  u: "u",
  ins: "u",
  s: "s",
  strike: "s",
  del: "s",
  sup: "sup",
  sub: "sub",
  small: "small",
  code: "code",
  kbd: "code",
  tt: "code",
  q: "q",
};

/**
 * HTML para exibir/editar na interface. Só usa tags inline conhecidas, sem
 * nenhum atributo vindo do livro. Cada elemento leva `data-k` para que as
 * edições possam ser convertidas de volta na marcação compacta.
 */
export function renderSafeHtml(markup: string, tags: Record<string, InlineTag>): string {
  const parts: string[] = [];
  const stack: { k: number; el: string }[] = [];
  for (const t of tokenize(markup)) {
    if (t.type === "text") {
      parts.push(escapeHtml(decodeBasicEntities(t.text)));
      continue;
    }
    const tag = tags[String(t.k)];
    if (!tag) continue;
    if (tag.v) {
      if (t.type === "close") continue;
      if (tag.n === "br") parts.push(`<br data-k="${t.k}">`);
      else parts.push(`<span data-k="${t.k}" data-v="1" class="inline-object" contenteditable="false"></span>`);
      continue;
    }
    if (t.type === "open") {
      const el = SAFE_INLINE[tag.n.toLowerCase()] ?? "span";
      const cls =
        el === "span" && /\b(ital|em)\w*/i.test(tag.o)
          ? ' class="it"'
          : el === "span" && /\b(bold|strong)\w*/i.test(tag.o)
            ? ' class="bd"'
            : el === "span" && /small-?caps|\bsc\b/i.test(tag.o)
              ? ' class="sc"'
              : "";
      stack.push({ k: t.k, el });
      parts.push(`<${el} data-k="${t.k}"${cls}>`);
    } else if (t.type === "close") {
      const pos = stack.map((s) => s.k).lastIndexOf(t.k);
      if (pos === -1) continue;
      while (stack.length > pos) parts.push(`</${stack.pop()!.el}>`);
    }
  }
  while (stack.length) parts.push(`</${stack.pop()!.el}>`);
  return parts.join("");
}

/* ---------- edições vindas do editor ---------- */

export interface EditedNode {
  /** texto */
  x?: string;
  /** índice da tag existente */
  k?: number;
  /** nova formatação criada pelo usuário */
  f?: "em" | "strong";
  /** quebra de linha nova */
  br?: true;
  c?: EditedNode[];
}

/**
 * Converte a árvore enviada pelo editor (ver components/review) em marcação
 * compacta, criando novas tags quando o usuário aplicou itálico/negrito.
 */
export function markupFromEdit(nodes: EditedNode[], tags: Record<string, InlineTag>): string {
  let next = Math.max(0, ...Object.keys(tags).map(Number)) + 1;
  const walk = (list: EditedNode[], depth: number): string => {
    if (depth > 20) return "";
    return list
      .map((n) => {
        if (typeof n.x === "string") return escapeMarkupText(n.x);
        if (n.br) {
          const k = next++;
          tags[String(k)] = { n: "br", o: "<br/>", v: 1 };
          return `<br_${k}/>`;
        }
        if (typeof n.k === "number") {
          const tag = tags[String(n.k)];
          if (!tag) return walk(n.c ?? [], depth + 1);
          if (tag.v) return `<${safeName(tag.n)}_${n.k}/>`;
          const inner = walk(n.c ?? [], depth + 1);
          return inner ? `<${safeName(tag.n)}_${n.k}>${inner}</${safeName(tag.n)}_${n.k}>` : "";
        }
        if (n.f === "em" || n.f === "strong") {
          const inner = walk(n.c ?? [], depth + 1);
          if (!inner) return "";
          const k = next++;
          tags[String(k)] = { n: n.f, o: `<${n.f}>` };
          return `<${n.f}_${k}>${inner}</${n.f}_${k}>`;
        }
        return walk(n.c ?? [], depth + 1);
      })
      .join("");
  };
  return walk(nodes, 0).replace(/\s+/g, " ").trim();
}

/* ---------- utilidades ---------- */

export function escapeMarkupText(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9-]/g, "-").replace(/^-+/, "") || "x";
}

function dedupeId(openTag: string, ids: Set<string>): string {
  const m = openTag.match(/\sid="([^"]*)"/);
  if (!m) return openTag;
  if (ids.has(m[1])) return openTag.replace(m[0], "");
  ids.add(m[1]);
  return openTag;
}
