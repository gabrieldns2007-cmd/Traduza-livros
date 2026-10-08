/**
 * Leitura da estrutura de um EPUB (2 ou 3):
 *   META-INF/container.xml → pacote OPF → metadados, manifest, spine,
 *   sumário (nav do EPUB 3 ou NCX do EPUB 2) e capa.
 */
import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import JSZip from "jszip";
import posix from "node:path/posix";
import type { TocEntry } from "@/types/book";
import { decodeXmlBytes, normalizeHtmlEntities } from "@/utils/xml";
import { collapseWhitespace } from "@/utils/text";
import { localName, resolvePath } from "./segmenter";

export class EpubError extends Error {}

export interface ManifestItem {
  id: string;
  href: string; // caminho completo no zip
  mediaType: string;
  properties: string[];
}

export interface EpubPackage {
  zip: JSZip;
  opfPath: string;
  opfDir: string;
  version: string;
  title: string;
  author?: string;
  language?: string;
  manifest: Map<string, ManifestItem>;
  spine: { item: ManifestItem; linear: boolean }[];
  navPath?: string;
  ncxPath?: string;
  coverPath?: string;
  toc: TocEntry[];
}

export const LIMITS = {
  maxEntries: 20_000,
  maxUncompressed: 600 * 1024 * 1024,
};

export async function openZip(data: Uint8Array): Promise<JSZip> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data, { checkCRC32: false });
  } catch {
    throw new EpubError("O arquivo não parece ser um EPUB válido (não foi possível abrir o pacote).");
  }
  // proteção contra “zip bombs”
  const files = Object.values(zip.files);
  if (files.length > LIMITS.maxEntries) throw new EpubError("O EPUB contém arquivos demais.");
  let total = 0;
  for (const f of files) {
    const size = (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    total += size;
  }
  if (total > LIMITS.maxUncompressed) throw new EpubError("O EPUB é grande demais depois de descompactado.");
  return zip;
}

/** Busca um arquivo no zip tolerando diferenças de maiúsculas e de URL-encoding. */
export function findZipFile(zip: JSZip, path: string): JSZip.JSZipObject | null {
  const direct = zip.file(path);
  if (direct) return direct;
  const lower = path.toLowerCase();
  let encoded = path;
  try {
    encoded = encodeURI(path);
  } catch {
    /* ignora */
  }
  for (const name of Object.keys(zip.files)) {
    if (name === encoded || name.toLowerCase() === lower) return zip.files[name];
    try {
      if (decodeURIComponent(name) === path) return zip.files[name];
    } catch {
      /* nome com % inválido */
    }
  }
  return null;
}

export async function readZipText(zip: JSZip, path: string): Promise<string | null> {
  const f = findZipFile(zip, path);
  if (!f || f.dir) return null;
  return decodeXmlBytes(await f.async("uint8array"));
}

function loadXml(source: string) {
  return cheerio.load(normalizeHtmlEntities(source), { xml: { xmlMode: true, decodeEntities: true } });
}

function byLocal($: cheerio.CheerioAPI, scope: cheerio.Cheerio<Element> | null, name: string): Element[] {
  const all = (scope ? scope.find("*") : $("*")).toArray() as Element[];
  return all.filter((el) => localName(el) === name);
}

export async function readPackage(zip: JSZip): Promise<EpubPackage> {
  const container = await readZipText(zip, "META-INF/container.xml");
  if (!container) throw new EpubError("EPUB inválido: falta META-INF/container.xml.");
  const $c = loadXml(container);
  const rootfile = byLocal($c, null, "rootfile")[0];
  const opfPath = rootfile?.attribs?.["full-path"];
  if (!opfPath) throw new EpubError("EPUB inválido: pacote OPF não encontrado.");

  const opfSource = await readZipText(zip, opfPath);
  if (!opfSource) throw new EpubError("EPUB inválido: o arquivo OPF não existe dentro do pacote.");
  const $ = loadXml(opfSource);
  const opfDir = posix.dirname(opfPath);
  const pkgEl = byLocal($, null, "package")[0];
  const version = pkgEl?.attribs?.version ?? "2.0";

  const metaText = (name: string) =>
    byLocal($, null, name)
      .map((el) => collapseWhitespace($(el).text()).trim())
      .filter(Boolean);

  const manifest = new Map<string, ManifestItem>();
  for (const el of byLocal($, null, "item")) {
    const id = el.attribs.id;
    const href = el.attribs.href;
    if (!id || !href) continue;
    manifest.set(id, {
      id,
      href: resolvePath(opfDir, href),
      mediaType: (el.attribs["media-type"] ?? "").toLowerCase(),
      properties: (el.attribs.properties ?? "").split(/\s+/).filter(Boolean),
    });
  }

  const spineEl = byLocal($, null, "spine")[0];
  const spine: EpubPackage["spine"] = [];
  for (const ref of byLocal($, null, "itemref")) {
    const item = manifest.get(ref.attribs.idref);
    if (item) spine.push({ item, linear: ref.attribs.linear !== "no" });
  }
  if (!spine.length) throw new EpubError("EPUB sem capítulos (spine vazio).");

  const items = [...manifest.values()];
  const navPath = items.find((i) => i.properties.includes("nav"))?.href;
  const ncxId = spineEl?.attribs?.toc;
  const ncxPath = (ncxId ? manifest.get(ncxId)?.href : undefined) ?? items.find((i) => i.mediaType === "application/x-dtbncx+xml")?.href;

  // capa
  let coverPath = items.find((i) => i.properties.includes("cover-image"))?.href;
  if (!coverPath) {
    const coverMeta = byLocal($, null, "meta").find((m) => m.attribs.name === "cover");
    const ci = coverMeta ? manifest.get(coverMeta.attribs.content) : undefined;
    if (ci?.mediaType.startsWith("image/")) coverPath = ci.href;
  }
  if (!coverPath) {
    coverPath = items.find((i) => i.mediaType.startsWith("image/") && /cover|capa/i.test(i.id + i.href))?.href;
  }

  const pkg: EpubPackage = {
    zip,
    opfPath,
    opfDir,
    version,
    title: metaText("title")[0] ?? "",
    author: metaText("creator").slice(0, 3).join(", ") || undefined,
    language: metaText("language")[0],
    manifest,
    spine,
    navPath,
    ncxPath,
    coverPath,
    toc: [],
  };
  pkg.toc = await readToc(pkg);
  return pkg;
}

async function readToc(pkg: EpubPackage): Promise<TocEntry[]> {
  if (pkg.navPath) {
    const src = await readZipText(pkg.zip, pkg.navPath);
    if (src) {
      const entries = parseNavToc(src, pkg.navPath);
      if (entries.length) return entries;
    }
  }
  if (pkg.ncxPath) {
    const src = await readZipText(pkg.zip, pkg.ncxPath);
    if (src) return parseNcxToc(src, pkg.ncxPath);
  }
  return [];
}

export function parseNavToc(source: string, navPath: string): TocEntry[] {
  const $ = loadXml(source);
  const navs = byLocal($, null, "nav");
  const toc = navs.find((n) => /\btoc\b/.test(n.attribs["epub:type"] ?? n.attribs.role ?? "")) ?? navs[0];
  if (!toc) return [];
  const dir = posix.dirname(navPath);
  const entries: TocEntry[] = [];
  const walkList = (list: Element, depth: number) => {
    for (const li of list.children.filter((c): c is Element => c.type === "tag" && localName(c) === "li")) {
      const label = li.children.find((c): c is Element => c.type === "tag" && (localName(c) === "a" || localName(c) === "span"));
      if (label) {
        const text = collapseWhitespace($(label).text()).trim();
        const href = label.attribs.href;
        if (text) entries.push({ label: text, href: href ? resolvePath(dir, href) : "", fragment: fragmentOf(href), depth });
      }
      for (const sub of li.children.filter((c): c is Element => c.type === "tag" && localName(c) === "ol")) walkList(sub, depth + 1);
    }
  };
  const root = $(toc)
    .children()
    .toArray()
    .find((c) => localName(c as Element) === "ol") as Element | undefined;
  if (root) walkList(root, 0);
  return entries;
}

export function parseNcxToc(source: string, ncxPath: string): TocEntry[] {
  const $ = loadXml(source);
  const dir = posix.dirname(ncxPath);
  const entries: TocEntry[] = [];
  const navMap = byLocal($, null, "navMap")[0] ?? byLocal($, null, "navmap")[0];
  if (!navMap) return [];
  const walk = (parent: Element, depth: number) => {
    for (const np of parent.children.filter((c): c is Element => c.type === "tag" && localName(c) === "navpoint")) {
      const labelEl = np.children.find((c): c is Element => c.type === "tag" && localName(c) === "navlabel");
      const contentEl = np.children.find((c): c is Element => c.type === "tag" && localName(c) === "content");
      const text = labelEl ? collapseWhitespace($(labelEl).text()).trim() : "";
      const src = contentEl?.attribs?.src;
      if (text) entries.push({ label: text, href: src ? resolvePath(dir, src) : "", fragment: fragmentOf(src), depth });
      walk(np, depth + 1);
    }
  };
  walk(navMap, 0);
  return entries;
}

function fragmentOf(href: string | undefined): string | undefined {
  if (!href || !href.includes("#")) return undefined;
  const f = href.slice(href.indexOf("#") + 1);
  try {
    return decodeURIComponent(f) || undefined;
  } catch {
    return f || undefined;
  }
}

export function isXhtml(item: ManifestItem): boolean {
  return item.mediaType === "application/xhtml+xml" || item.mediaType === "text/html" || /\.x?html?$/i.test(item.href);
}
