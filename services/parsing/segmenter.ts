/**
 * Segmentação de um documento XHTML de capítulo.
 *
 * Percorre o <body> e encontra os “blocos de texto” (parágrafos, títulos,
 * itens de lista, células…). Cada bloco vira um Segment com o conteúdo em
 * marcação compacta, e no XHTML o conteúdo é trocado por <!--tl:N-->.
 * O resultado (o “esqueleto”) é guardado e, na exportação, os marcadores são
 * substituídos pelas traduções — todo o resto (CSS, ids, imagens, links,
 * estrutura) permanece idêntico ao original.
 */
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { Comment } from "domhandler";
import { prepend, removeElement } from "domutils";
import posix from "node:path/posix";
import type { DocContent, DisplayBlock, InlineTag, Segment, SegmentRole } from "@/types/book";
import { escapeMarkupText, safeName } from "@/lib/markup";
import { collapseWhitespace, countWords, hasMeaningfulText } from "@/utils/text";
import { escapeXmlAttr, fixBareAmpersands, forceUtf8Declaration, normalizeHtmlEntities } from "@/utils/xml";

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "caption",
  "center",
  "colgroup",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "legend",
  "li",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
  "html",
  "table",
]);

/** Blocos que nunca traduzimos (mantidos como estão). */
const SKIP_TAGS = new Set([
  "script",
  "style",
  "pre",
  "svg",
  "math",
  "head",
  "template",
  "object",
  "iframe",
  "video",
  "audio",
  "canvas",
  "noscript",
  "textarea",
  "select",
  "button",
  "map",
]);

/** Elementos inline sem conteúdo traduzível: viram marcadores vazios. */
const VOID_INLINE = new Set([
  "br",
  "img",
  "hr",
  "wbr",
  "input",
  "image",
  "svg",
  "math",
  "object",
  "video",
  "audio",
  "iframe",
  "embed",
  "source",
  "track",
  "area",
  "canvas",
  "ruby",
  "rt",
  "rp",
  "script",
  "style",
  "noscript",
]);

export interface SegmentedDocument {
  skeleton: string;
  content: DocContent;
  /** id de elemento → índice do segmento em que (ou antes do qual) ele aparece */
  anchors: Record<string, number>;
  title: string | null;
  words: number;
}

export function localName(el: Element): string {
  const n = el.name.toLowerCase();
  const i = n.indexOf(":");
  return i >= 0 ? n.slice(i + 1) : n;
}

function isElement(node: AnyNode): node is Element {
  return node.type === "tag" || node.type === "script" || node.type === "style";
}

/** Prepara o texto bruto do arquivo para o parser XML. */
export function prepareXhtmlSource(source: string): string {
  return forceUtf8Declaration(fixBareAmpersands(normalizeHtmlEntities(source)));
}

/** Carrega um documento XHTML de forma tolerante (com fallback para parser HTML). */
export function loadXhtml(source: string): cheerio.CheerioAPI {
  const prepared = prepareXhtmlSource(source);
  const $ = cheerio.load(prepared, { xml: { xmlMode: true, decodeEntities: true } });
  // Sintoma de HTML não-XHTML (ex.: <br> sem barra): elementos vazios com filhos.
  let broken = false;
  $("br, img, hr, meta, link, input").each((_, el) => {
    if ((el as Element).children?.length) broken = true;
  });
  if (!broken) return $;

  const html = cheerio.load(prepared, { xml: false });
  const htmlEl = html("html").first();
  if (!htmlEl.attr("xmlns")) htmlEl.attr("xmlns", "http://www.w3.org/1999/xhtml");
  const body = `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n${html.xml(htmlEl)}`;
  return cheerio.load(body, { xml: { xmlMode: true, decodeEntities: true } });
}

export function segmentDocument(source: string, docPath: string): SegmentedDocument {
  const $ = loadXhtml(source);
  const tags: Record<string, InlineTag> = {};
  const segments: Segment[] = [];
  const blocks: DisplayBlock[] = [];
  const anchors: Record<string, number> = {};
  let tagCounter = 0;
  const blockMemo = new WeakMap<AnyNode, boolean>();
  const docDir = posix.dirname(docPath);

  const hasBlock = (node: AnyNode): boolean => {
    if (!isElement(node)) return false;
    const cached = blockMemo.get(node);
    if (cached !== undefined) return cached;
    const name = localName(node);
    let result = BLOCK_TAGS.has(name) || (SKIP_TAGS.has(name) && name !== "svg" && name !== "math");
    if (!result && !VOID_INLINE.has(name)) result = node.children.some(hasBlock);
    blockMemo.set(node, result);
    return result;
  };

  const textOf = (nodes: AnyNode[]): string => nodes.map((n) => $(n).text()).join("");

  /** registra ids (alvos de links/sumário) na posição do próximo segmento */
  const noteId = (el: Element) => {
    const id = el.attribs?.id ?? (localName(el) === "a" ? el.attribs?.name : undefined);
    if (id && anchors[id] === undefined) anchors[id] = segments.length;
  };
  const noteIdsDeep = (node: AnyNode) => {
    if (!isElement(node)) return;
    noteId(node);
    $(node)
      .find("[id]")
      .each((_, el) => noteId(el as Element));
  };

  const openTag = (el: Element): string => {
    const attrs = Object.entries(el.attribs ?? {})
      .map(([k, v]) => ` ${k}="${escapeXmlAttr(v)}"`)
      .join("");
    return `<${el.name}${attrs}>`;
  };

  const register = (tag: InlineTag): number => {
    const k = ++tagCounter;
    tags[String(k)] = tag;
    return k;
  };

  /** Converte nós inline em marcação compacta. */
  const toMarkup = (nodes: AnyNode[]): string => {
    let out = "";
    for (const node of nodes) {
      if (node.type === "text") {
        out += escapeMarkupText(collapseWhitespace((node as unknown as { data: string }).data));
      } else if (node.type === "cdata") {
        out += escapeMarkupText(collapseWhitespace($(node).text()));
      } else if (isElement(node)) {
        noteIdsDeep(node);
        const name = localName(node);
        const text = $(node).text();
        const isVoid = VOID_INLINE.has(name) || (!hasMeaningfulText(text) && !/\S/.test(text) && !node.children.some(isElement));
        if (isVoid) {
          const k = register({ n: name, o: $.xml(node), v: 1 });
          out += `<${safeName(name)}_${k}/>`;
        } else {
          const k = register({ n: node.name, o: openTag(node) });
          out += `<${safeName(name)}_${k}>${toMarkup(node.children)}</${safeName(name)}_${k}>`;
        }
      }
      // comentários e instruções de processamento são descartados
    }
    return out;
  };

  const roleFor = (el: Element | null, ctx: Ctx): { role: SegmentRole; level?: number; center?: boolean } => {
    const name = el ? localName(el) : "";
    const cls = el ? `${el.attribs?.class ?? ""} ${el.attribs?.style ?? ""}` : "";
    const center = /center|centr/i.test(cls) || ctx.center;
    const h = name.match(/^h([1-6])$/);
    if (h) return { role: "heading", level: Number(h[1]), center };
    if (name === "li" || name === "dt" || name === "dd") return { role: "list", center };
    if (name === "td" || name === "th") return { role: "cell", center };
    if (name === "figcaption" || name === "caption") return { role: "caption", center };
    if (ctx.quote) return { role: "quote", center };
    if (/\b(chapter-?title|chap-?title|chapter-?head|chaptitle|title|heading|titulo|capitulo)\b/i.test(cls)) {
      return { role: "heading", level: 2, center };
    }
    return { role: "paragraph", center };
  };

  const addSegment = (nodes: AnyNode[], container: Element | null, ctx: Ctx) => {
    const src = toMarkup(nodes).trim();
    const plain = textOf(nodes);
    const i = segments.length;
    const words = countWords(plain);
    const r = roleFor(container, ctx);
    // títulos “por classe” só se forem curtos
    if (r.role === "heading" && !/^h[1-6]$/.test(container ? localName(container) : "") && words > 14) r.role = ctx.quote ? "quote" : "paragraph";
    segments.push({ i, tag: container ? localName(container) : "span", ...r, src, words });
    blocks.push({ t: "s", i });
    return i;
  };

  const pushImages = (node: AnyNode) => {
    $(node)
      .find("img, image, svg\\:image")
      .addBack("img, image")
      .each((_, img) => {
        const el = img as Element;
        const src = el.attribs?.src ?? el.attribs?.["xlink:href"] ?? el.attribs?.href;
        if (src && !/^(data:|https?:)/i.test(src)) {
          blocks.push({ t: "img", src: resolvePath(docDir, src), alt: el.attribs?.alt || undefined });
        }
      });
  };

  type Ctx = { quote: boolean; center: boolean; depth: number };

  const handleRun = (run: AnyNode[], parent: Element, ctx: Ctx) => {
    const text = textOf(run);
    if (hasMeaningfulText(text)) {
      const i = addSegment(run, parent === bodyEl ? null : parent, ctx);
      prepend(run[0], new Comment(`tl:${i}`));
      for (const n of run) removeElement(n);
    } else if (/\S/.test(text)) {
      for (const n of run) noteIdsDeep(n);
      blocks.push({ t: "orn", text: collapseWhitespace(text).trim() });
    } else {
      for (const n of run) {
        noteIdsDeep(n);
        pushImages(n);
      }
    }
  };

  const walk = (el: Element, ctx: Ctx) => {
    if (ctx.depth > 200) return;
    const name = localName(el);
    noteId(el);
    if (SKIP_TAGS.has(name)) {
      noteIdsDeep(el);
      pushImages(el);
      return;
    }
    if (name === "hr") {
      blocks.push({ t: "hr" });
      return;
    }
    const nextCtx: Ctx = {
      quote: ctx.quote || name === "blockquote",
      center: ctx.center || name === "center",
      depth: ctx.depth + 1,
    };

    if (!hasBlockChildren(el)) {
      // bloco “folha”: todo o conteúdo é um segmento
      const text = $(el).text();
      if (hasMeaningfulText(text) && el !== bodyEl) {
        const i = addSegment(el.children, el, nextCtx);
        $(el)
          .empty()
          .append(new Comment(`tl:${i}`));
      } else if (hasMeaningfulText(text)) {
        handleRun([...el.children], el, nextCtx);
      } else if (/\S/.test(text)) {
        noteIdsDeep(el);
        blocks.push({ t: "orn", text: collapseWhitespace(text).trim() });
      } else {
        noteIdsDeep(el);
        pushImages(el);
      }
      return;
    }

    // conteúdo misto: agrupa nós inline consecutivos em “runs”
    let run: AnyNode[] = [];
    const children = [...el.children];
    for (const child of children) {
      if (isElement(child) && hasBlock(child)) {
        if (run.length) handleRun(run, el, nextCtx);
        run = [];
        walk(child, nextCtx);
      } else if (child.type === "text" || child.type === "cdata" || isElement(child)) {
        run.push(child);
      }
    }
    if (run.length) handleRun(run, el, nextCtx);
  };

  const hasBlockChildren = (el: Element) => el.children.some(hasBlock);

  const bodyEl = ($("body").get(0) ??
    $.root()
      .children()
      .filter((_, n) => isElement(n))
      .get(0)) as Element | undefined;
  if (bodyEl) walk(bodyEl, { quote: false, center: false, depth: 0 });

  // título provável: primeiro título do documento
  const firstHeading = segments.find((s) => s.role === "heading" && (s.level ?? 9) <= 3) ?? segments.find((s) => s.role === "heading");
  const title = firstHeading ? collapseWhitespace(markupPlain(firstHeading.src)).trim().slice(0, 160) : null;

  return {
    skeleton: $.xml(),
    content: { tags, segments, blocks },
    anchors,
    title,
    words: segments.reduce((sum, s) => sum + s.words, 0),
  };
}

function markupPlain(src: string): string {
  return src
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** Resolve um caminho relativo (possivelmente URL-encoded) a partir de um diretório do EPUB. */
export function resolvePath(dir: string, href: string): string {
  const clean = href.split("#")[0].split("?")[0];
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    /* mantém como está */
  }
  return posix.normalize(posix.join(dir === "." ? "" : dir, decoded)).replace(/^\/+/, "");
}
