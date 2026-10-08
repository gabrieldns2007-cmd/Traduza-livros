/**
 * Reconstrução: devolve a tradução ao esqueleto XHTML de cada arquivo.
 * Tudo que não é texto (CSS, imagens, ids, links, classes) vem do original.
 */
import type { BookMeta, DocContent } from "@/types/book";
import { renderXhtml } from "@/lib/markup";
import { escapeXmlAttr } from "@/utils/xml";

const MARKER_RE = /<!--tl:(\d+)-->/g;

export function fillSkeleton(skeleton: string, content: DocContent, lang: string): string {
  const usedIds = new Set<string>();
  const filled = skeleton.replace(MARKER_RE, (_, n: string) => {
    const seg = content.segments[Number(n)];
    if (!seg) return "";
    return renderXhtml(seg.out ?? seg.src, content.tags, usedIds);
  });
  return setDocumentLanguage(filled, lang);
}

/** Ajusta lang/xml:lang no elemento <html> para o idioma da tradução. */
export function setDocumentLanguage(xhtml: string, lang: string): string {
  return xhtml.replace(/<html\b([^>]*)>/i, (_m, attrs: string) => {
    let a = attrs;
    const v = escapeXmlAttr(lang);
    a = /\sxml:lang\s*=/.test(a) ? a.replace(/(\sxml:lang\s*=\s*)(["'])[^"']*\2/, `$1"${v}"`) : `${a} xml:lang="${v}"`;
    a = /\slang\s*=/.test(a) ? a.replace(/(\slang\s*=\s*)(["'])[^"']*\2/, `$1"${v}"`) : `${a} lang="${v}"`;
    return `<html${a}>`;
  });
}

/** Mapa “rótulo original do sumário → rótulo traduzido”. */
export function tocLabelMap(meta: BookMeta): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of meta.toc) if (t.translatedLabel) map.set(t.label, t.translatedLabel);
  for (const c of meta.chapters) if (c.translatedTitle && !map.has(c.title)) map.set(c.title, c.translatedTitle);
  return map;
}
