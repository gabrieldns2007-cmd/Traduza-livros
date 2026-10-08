/**
 * Exportação EPUB.
 *
 * Parte do EPUB de origem e troca apenas o que mudou: o texto dos capítulos,
 * os rótulos do sumário (nav/NCX) e os metadados de idioma/título. O pacote
 * é remontado com o `mimetype` como primeira entrada, sem compressão, como
 * exige a especificação — o resultado abre no Kindle, Apple Books, Kobo etc.
 */
import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import JSZip from "jszip";
import type { BookMeta } from "@/types/book";
import { store } from "@/lib/storage";
import { findZipFile, openZip, readPackage, readZipText } from "@/services/parsing/epub-package";
import { localName } from "@/services/parsing/segmenter";
import { fillSkeleton, setDocumentLanguage, tocLabelMap } from "@/services/reconstruction/book-builder";
import { collapseWhitespace } from "@/utils/text";
import { normalizeHtmlEntities, forceUtf8Declaration } from "@/utils/xml";

function loadXml(source: string) {
  return cheerio.load(forceUtf8Declaration(normalizeHtmlEntities(source)), { xml: { xmlMode: true, decodeEntities: true } });
}

function elementsByLocal($: cheerio.CheerioAPI, name: string): Element[] {
  return ($("*").toArray() as Element[]).filter((el) => localName(el) === name);
}

export async function buildTranslatedEpub(meta: BookMeta): Promise<Uint8Array> {
  const source = await store.readFile(meta.id, "source.epub");
  const zip = await openZip(new Uint8Array(source));
  const pkg = await readPackage(zip);
  const lang = meta.targetLanguage;
  const title = meta.translatedTitle || meta.title;
  const labels = tocLabelMap(meta);

  /** caminho no zip → novo conteúdo */
  const replaced = new Map<string, string>();

  // 1. capítulos
  for (const doc of meta.docs) {
    const skeleton = await store.readSkeleton(meta.id, doc.id);
    const entry = findZipFile(zip, doc.href);
    if (!skeleton || !entry) continue;
    const content = await store.readDoc(meta.id, doc.id);
    replaced.set(entry.name, fillSkeleton(skeleton, content, lang));
  }

  // 2. sumário EPUB 3 (nav)
  if (pkg.navPath) {
    const entry = findZipFile(zip, pkg.navPath);
    const src = entry ? await readZipText(zip, entry.name) : null;
    if (entry && src) {
      const $ = loadXml(src);
      for (const el of [...elementsByLocal($, "a"), ...elementsByLocal($, "span"), ...elementsByLocal($, "h1"), ...elementsByLocal($, "h2")]) {
        const text = collapseWhitespace($(el).text()).trim();
        const t = labels.get(text);
        if (t) $(el).text(t);
      }
      const titleEl = elementsByLocal($, "title")[0];
      if (titleEl) $(titleEl).text(title);
      replaced.set(entry.name, setDocumentLanguage($.xml(), lang));
    }
  }

  // 3. sumário EPUB 2 (NCX)
  if (pkg.ncxPath) {
    const entry = findZipFile(zip, pkg.ncxPath);
    const src = entry ? await readZipText(zip, entry.name) : null;
    if (entry && src) {
      const $ = loadXml(src);
      for (const label of elementsByLocal($, "navlabel")) {
        const textEl = label.children.find((c): c is Element => c.type === "tag" && localName(c) === "text");
        if (!textEl) continue;
        const t = labels.get(collapseWhitespace($(textEl).text()).trim());
        if (t) $(textEl).text(t);
      }
      const docTitle = elementsByLocal($, "doctitle")[0];
      const docTitleText = docTitle?.children.find((c): c is Element => c.type === "tag" && localName(c) === "text");
      if (docTitleText) $(docTitleText).text(title);
      const root = elementsByLocal($, "ncx")[0];
      if (root?.attribs["xml:lang"]) root.attribs["xml:lang"] = lang;
      replaced.set(entry.name, $.xml());
    }
  }

  // 4. metadados do pacote (OPF)
  {
    const entry = findZipFile(zip, pkg.opfPath)!;
    const src = (await readZipText(zip, entry.name))!;
    const $ = loadXml(src);
    const pkgEl = elementsByLocal($, "package")[0];
    if (pkgEl?.attribs["xml:lang"]) pkgEl.attribs["xml:lang"] = lang;
    const metadata = elementsByLocal($, "metadata")[0];
    const langEls = elementsByLocal($, "language");
    if (langEls.length) {
      $(langEls[0]).text(lang);
      for (const extra of langEls.slice(1)) $(extra).remove();
    } else if (metadata) {
      $(metadata).append(`<dc:language>${lang}</dc:language>`);
    }
    const titleEl = elementsByLocal($, "title")[0];
    if (titleEl && meta.translatedTitle) $(titleEl).text(meta.translatedTitle);
    // EPUB 3 exige dcterms:modified atualizado
    if (pkg.version.startsWith("3") && metadata) {
      const modified = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      const mod = elementsByLocal($, "meta").find((m) => m.attribs.property === "dcterms:modified");
      if (mod) $(mod).text(modified);
      else $(metadata).append(`<meta property="dcterms:modified">${modified}</meta>`);
    }
    replaced.set(entry.name, $.xml());
  }

  // 5. remonta o pacote: mimetype primeiro e sem compressão
  const out = new JSZip();
  out.file("mimetype", "application/epub+zip", { compression: "STORE" });
  for (const [name, file] of Object.entries(zip.files)) {
    if (name === "mimetype" || file.dir) continue;
    const content = replaced.get(name);
    if (content !== undefined) out.file(name, content);
    else out.file(name, await file.async("uint8array"));
  }
  return out.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    mimeType: "application/epub+zip",
  });
}
