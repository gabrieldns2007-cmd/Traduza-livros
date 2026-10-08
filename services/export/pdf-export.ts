/**
 * Exportação PDF com layout de livro.
 *
 * Formato 5,5 × 8,5 pol (digest), Newsreader embutida, texto justificado com
 * hifenização do idioma de destino, recuo de primeira linha, aberturas de
 * capítulo arejadas, cabeçalhos correntes, numeração de páginas e sumário
 * com números de página. Usa o mesmo conteúdo da exportação EPUB.
 */
import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import * as fontkit from "fontkit";
import type { BookMeta, DocContent, InlineTag, Segment } from "@/types/book";
import { store } from "@/lib/storage";
import { tokenize, toPlainText } from "@/lib/markup";
import { languageLabel } from "@/lib/languages";
import { chapterBlocks } from "@/services/parsing/chapters";
import { findZipFile, openZip } from "@/services/parsing/epub-package";
import { decodeBasicEntities } from "@/utils/xml";
import { getHyphenator } from "./hyphenation";
import { Typesetter } from "./typesetter";

export class PdfExportError extends Error {}

/* ---------- medidas ---------- */
const PAGE: [number, number] = [396, 612];
const M = { top: 66, bottom: 70, left: 54, right: 54 };
const BODY_SIZE = 10.6;
const LINE_GAP = 3.6;
const INDENT = 14;
const INK = "#1d1c1a";
const MUTED = "#8a857c";

/* ---------- fontes ---------- */
interface FontSet {
  name: string;
  regular: string;
  italic: string;
  bold: string;
  boldItalic: string;
  medium: string;
}

function fontsDir() {
  return path.join(process.cwd(), "assets", "fonts");
}

function candidateFontSets(): FontSet[] {
  const d = fontsDir();
  const sets: FontSet[] = [];
  if (process.env.PDF_FONT_REGULAR) {
    const r = process.env.PDF_FONT_REGULAR;
    sets.push({
      name: "custom",
      regular: r,
      italic: process.env.PDF_FONT_ITALIC || r,
      bold: process.env.PDF_FONT_BOLD || r,
      boldItalic: process.env.PDF_FONT_BOLDITALIC || process.env.PDF_FONT_BOLD || r,
      medium: process.env.PDF_FONT_BOLD || r,
    });
  }
  sets.push({
    name: "Newsreader",
    regular: path.join(d, "Newsreader-400-normal.ttf"),
    italic: path.join(d, "Newsreader-400-italic.ttf"),
    bold: path.join(d, "Newsreader-600-normal.ttf"),
    boldItalic: path.join(d, "Newsreader-600-italic.ttf"),
    medium: path.join(d, "Newsreader-500-normal.ttf"),
  });
  const dv = "/usr/share/fonts/truetype/dejavu";
  sets.push({
    name: "DejaVu Serif",
    regular: `${dv}/DejaVuSerif.ttf`,
    italic: fs.existsSync(`${dv}/DejaVuSerif-Italic.ttf`) ? `${dv}/DejaVuSerif-Italic.ttf` : `${dv}/DejaVuSerif.ttf`,
    bold: `${dv}/DejaVuSerif-Bold.ttf`,
    boldItalic: fs.existsSync(`${dv}/DejaVuSerif-BoldItalic.ttf`) ? `${dv}/DejaVuSerif-BoldItalic.ttf` : `${dv}/DejaVuSerif-Bold.ttf`,
    medium: `${dv}/DejaVuSerif-Bold.ttf`,
  });
  return sets.filter((s) => [s.regular, s.italic, s.bold, s.boldItalic, s.medium].every((p) => fs.existsSync(p)));
}

/** Escolhe a primeira família que cobre as letras do livro. */
function chooseFonts(sampleText: string): FontSet {
  const letters = new Set<number>();
  for (const ch of sampleText) if (/\p{L}/u.test(ch)) letters.add(ch.codePointAt(0)!);
  let best: { set: FontSet; missing: number } | null = null;
  for (const set of candidateFontSets()) {
    let missing = 0;
    try {
      const font = fontkit.openSync(set.regular) as unknown as { hasGlyphForCodePoint(cp: number): boolean };
      for (const cp of letters) if (!font.hasGlyphForCodePoint(cp)) missing++;
    } catch {
      continue;
    }
    if (missing === 0) return set;
    if (!best || missing < best.missing) best = { set, missing };
  }
  if (best && best.missing / Math.max(1, letters.size) < 0.02) return best.set;
  throw new PdfExportError(
    "Ainda não temos uma fonte para gerar o PDF neste alfabeto. O EPUB funciona normalmente; para o PDF, defina PDF_FONT_REGULAR com uma fonte que cubra o idioma.",
  );
}

/* ---------- texto com estilos ---------- */
interface Run {
  text: string;
  italic: boolean;
  bold: boolean;
}

function styleOf(tag: InlineTag): { italic?: boolean; bold?: boolean } {
  const n = tag.n.toLowerCase().replace(/^.*:/, "");
  if (["em", "i", "cite", "dfn", "var"].includes(n)) return { italic: true };
  if (["strong", "b"].includes(n)) return { bold: true };
  if (n === "span" || n === "a") {
    const cls = tag.o.match(/class="([^"]*)"/)?.[1] ?? "";
    return { italic: /ital|\bem\b|\bi\b/i.test(cls), bold: /bold|strong/i.test(cls) };
  }
  return {};
}

function markupRuns(markup: string, tags: Record<string, InlineTag>): Run[] {
  const runs: Run[] = [];
  const stack: { italic: boolean; bold: boolean }[] = [{ italic: false, bold: false }];
  const opened: number[] = [];
  for (const t of tokenize(markup)) {
    const top = stack[stack.length - 1];
    if (t.type === "text") {
      const text = decodeBasicEntities(t.text);
      if (text) runs.push({ text, ...top });
    } else if (t.type === "void") {
      if (tags[String(t.k)]?.n === "br") runs.push({ text: "\n", ...top });
    } else if (t.type === "open") {
      const tag = tags[String(t.k)];
      const s = tag ? styleOf(tag) : {};
      stack.push({ italic: top.italic || !!s.italic, bold: top.bold || !!s.bold });
      opened.push(t.k);
    } else if (t.type === "close") {
      const pos = opened.lastIndexOf(t.k);
      if (pos >= 0) {
        opened.splice(pos);
        stack.splice(pos + 1);
      }
    }
  }
  // junta vizinhos com o mesmo estilo e normaliza espaços
  const merged: Run[] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && last.italic === r.italic && last.bold === r.bold) last.text += r.text;
    else merged.push({ ...r });
  }
  for (const r of merged) r.text = r.text.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n");
  if (merged.length) {
    merged[0].text = merged[0].text.replace(/^\s+/, "");
    merged[merged.length - 1].text = merged[merged.length - 1].text.replace(/\s+$/, "");
  }
  return merged.filter((r) => r.text.length);
}

/* ---------- geração ---------- */

interface ChapterRender {
  title: string;
  startPage: number;
}

export async function buildTranslatedPdf(meta: BookMeta): Promise<Uint8Array> {
  const docs = new Map<string, DocContent>();
  for (const d of meta.docs) docs.set(d.id, await store.readDoc(meta.id, d.id));

  const title = meta.translatedTitle || meta.title;
  const chapterTitle = (c: BookMeta["chapters"][number]) => c.translatedTitle || c.title;

  // amostra de texto para escolher a fonte
  const sample: string[] = [title, meta.author ?? ""];
  for (const c of meta.chapters) {
    sample.push(chapterTitle(c));
    const segs = docs.get(c.docId)!.segments.slice(c.start, c.end);
    for (const s of segs.slice(0, 400)) sample.push(toPlainText(s.out ?? s.src));
  }
  const fonts = chooseFonts(sample.join(" "));
  const hyphenate = await getHyphenator(meta.targetLanguage);

  const pdf = new PDFDocument({
    size: PAGE,
    margins: M,
    bufferPages: true,
    autoFirstPage: false,
    compress: true,
    lang: meta.targetLanguage,
    displayTitle: true,
    info: {
      Title: title,
      Author: meta.author ?? "",
      Creator: "Verso",
      Producer: "Verso",
      Subject: `Tradução para ${languageLabel(meta.targetLanguage)}`,
    },
  });
  pdf.registerFont("serif", fonts.regular);
  pdf.registerFont("serif-italic", fonts.italic);
  pdf.registerFont("serif-bold", fonts.bold);
  pdf.registerFont("serif-bolditalic", fonts.boldItalic);
  pdf.registerFont("serif-medium", fonts.medium);
  const sansPath = path.join(fontsDir(), "InstrumentSans-500.ttf");
  pdf.registerFont("sans", fs.existsSync(sansPath) ? sansPath : fonts.regular);

  const typesetter = new Typesetter(pdf);
  const chunks: Buffer[] = [];
  pdf.on("data", (c: Buffer) => chunks.push(c));
  const finished = new Promise<void>((resolve, reject) => {
    pdf.on("end", () => resolve());
    pdf.on("error", reject);
  });

  const contentWidth = PAGE[0] - M.left - M.right;
  const fontFor = (r: { italic: boolean; bold: boolean }) =>
    r.bold && r.italic ? "serif-bolditalic" : r.bold ? "serif-bold" : r.italic ? "serif-italic" : "serif";
  const resetX = () => {
    pdf.x = M.left;
  };
  const bottomLimit = () => PAGE[1] - M.bottom;
  const ensureSpace = (h: number) => {
    if (pdf.y + h > bottomLimit()) pdf.addPage();
  };

  /* capa */
  let zip: Awaited<ReturnType<typeof openZip>> | null = null;
  try {
    zip = await openZip(new Uint8Array(await store.readFile(meta.id, "source.epub")));
  } catch {
    zip = null;
  }
  const readImage = async (p: string): Promise<Buffer | null> => {
    if (!zip) return null;
    const f = findZipFile(zip, p);
    if (!f) return null;
    const buf = Buffer.from(await f.async("uint8array"));
    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
    const isPng = buf[0] === 0x89 && buf[1] === 0x50;
    return isJpeg || isPng ? buf : null;
  };

  let frontPages = 0;
  if (meta.cover) {
    const img = await readImage(meta.cover);
    if (img) {
      pdf.addPage({ size: PAGE, margin: 0 });
      try {
        pdf.image(img, 0, 0, { fit: PAGE, align: "center", valign: "center" });
        frontPages++;
      } catch {
        /* imagem inválida: segue sem capa */
      }
    }
  }

  /* folha de rosto */
  pdf.addPage();
  frontPages++;
  pdf.font("serif-medium").fontSize(24).fillColor(INK);
  const titleHeight = pdf.heightOfString(title, { width: contentWidth, align: "center", lineGap: 2 });
  pdf.text(title, M.left, PAGE[1] * 0.3, { width: contentWidth, align: "center", lineGap: 2 });
  if (meta.author) {
    pdf.moveDown(0.8);
    pdf.font("serif-italic").fontSize(13).fillColor(INK).text(meta.author, { width: contentWidth, align: "center" });
  }
  const ruleY = PAGE[1] * 0.3 + titleHeight + (meta.author ? 56 : 28);
  pdf
    .moveTo(PAGE[0] / 2 - 14, ruleY)
    .lineTo(PAGE[0] / 2 + 14, ruleY)
    .lineWidth(0.6)
    .strokeColor(MUTED)
    .stroke();
  pdf
    .font("sans")
    .fontSize(7.5)
    .fillColor(MUTED)
    .text(`TRADUÇÃO · ${languageLabel(meta.targetLanguage).toUpperCase()}`, M.left, PAGE[1] - M.bottom - 30, {
      width: contentWidth,
      align: "center",
      characterSpacing: 1.6,
    });

  /* sumário: reserva páginas e preenche no fim */
  const tocEntries = meta.chapters.map((c) => chapterTitle(c));
  const estLines = tocEntries.reduce((s, t) => s + (t.length > 46 ? 2 : 1), 0);
  const perPage = Math.floor((PAGE[1] - M.top - M.bottom - 70) / 19);
  const tocPages = Math.max(1, Math.ceil(estLines / perPage));
  const tocStart = pdf.bufferedPageRange().count;
  for (let i = 0; i < tocPages; i++) pdf.addPage();

  /* capítulos */
  const rendered: ChapterRender[] = [];
  const runningHeads = new Map<number, string>();

  for (const chapter of meta.chapters) {
    const content = docs.get(chapter.docId)!;
    const isLastInDoc = !meta.chapters.some((c) => c.docId === chapter.docId && c.start >= chapter.end);
    const blocks = chapterBlocks(content, chapter, isLastInDoc);
    const ctitle = chapterTitle(chapter);

    pdf.addPage();
    const startPage = pdf.bufferedPageRange().count - 1;
    rendered.push({ title: ctitle, startPage });

    // abertura do capítulo
    pdf.y = M.top + 96;
    resetX();
    pdf.font("serif-medium").fontSize(19).fillColor(INK).text(ctitle, { width: contentWidth, align: "center", lineGap: 3 });
    pdf.moveDown(0.4);
    const ry = pdf.y + 8;
    pdf
      .moveTo(PAGE[0] / 2 - 10, ry)
      .lineTo(PAGE[0] / 2 + 10, ry)
      .lineWidth(0.6)
      .strokeColor(MUTED)
      .stroke();
    pdf.y = ry + 34;
    resetX();

    let firstHeadingSkipped = false;
    let afterBreak = true; // primeiro parágrafo depois de título/quebra: sem recuo

    for (const b of blocks) {
      if (b.t === "hr" || b.t === "orn") {
        ensureSpace(30);
        pdf.y += 9;
        const cy = pdf.y + 4;
        for (const dx of [-12, 0, 12]) pdf.circle(PAGE[0] / 2 + dx, cy, 1.1).fill(MUTED);
        pdf.fillColor(INK);
        pdf.y = cy + 15;
        resetX();
        afterBreak = true;
        continue;
      }
      if (b.t === "img") {
        const img = await readImage(b.src);
        if (!img) continue;
        try {
          const maxH = (PAGE[1] - M.top - M.bottom) * 0.6;
          ensureSpace(Math.min(maxH, 120));
          pdf.image(img, M.left, pdf.y + 6, { fit: [contentWidth, Math.min(maxH, bottomLimit() - pdf.y - 12)], align: "center" });
          pdf.y += 12;
          resetX();
          afterBreak = true;
        } catch {
          /* imagem com problema: ignora */
        }
        continue;
      }

      const seg: Segment = content.segments[b.i];
      const markup = seg.out ?? seg.src;
      const plain = toPlainText(markup).trim();
      if (!plain) continue;

      if (seg.role === "heading") {
        // o título do capítulo já foi impresso na abertura
        if (!firstHeadingSkipped && (plain === ctitle || toPlainText(seg.src).trim() === chapter.title || blocks.indexOf(b) < 3)) {
          firstHeadingSkipped = true;
          continue;
        }
        const big = (seg.level ?? 2) <= 2;
        ensureSpace(60);
        pdf.y += big ? 16 : 10;
        resetX();
        pdf
          .font(big ? "serif-medium" : "serif-italic")
          .fontSize(big ? 13.5 : 11.5)
          .fillColor(INK)
          .text(plain, { width: contentWidth, align: big || seg.center ? "center" : "left", lineGap: 2 });
        pdf.y += big ? 12 : 6;
        resetX();
        afterBreak = true;
        continue;
      }

      const runs = markupRuns(markup, content.tags).map((r) => ({ ...r, text: hyphenate(r.text) }));
      if (!runs.length) continue;

      const isQuote = seg.role === "quote";
      const isList = seg.role === "list";
      const centered = !!seg.center && plain.length < 120;
      const x = M.left + (isQuote ? 16 : isList ? 12 : 0);
      const width = contentWidth - (isQuote ? 32 : isList ? 12 : 0);
      const size = isQuote ? BODY_SIZE - 0.6 : BODY_SIZE;
      if (isList) runs[0] = { ...runs[0], text: "• " + runs[0].text };
      if (isQuote && afterBreak) pdf.y += 4;

      typesetter.paragraph(
        runs.map((r) => ({ text: r.text, font: fontFor(r) })),
        {
          x,
          width,
          size,
          lineHeight: size + LINE_GAP + 1.6,
          indent: afterBreak || centered || isQuote || isList ? 0 : INDENT,
          align: centered ? "center" : "justify",
          color: INK,
          top: M.top,
          bottom: bottomLimit(),
          spaceFont: "serif",
        },
      );
      if (isQuote || isList) pdf.y += 3;
      resetX();
      afterBreak = isQuote;
      if (isQuote) pdf.y += 2;
    }
  }

  /* preenche o sumário */
  {
    let page = tocStart;
    pdf.switchToPage(page);
    pdf.y = M.top + 40;
    resetX();
    pdf.font("serif-medium").fontSize(17).fillColor(INK).text("Sumário", { width: contentWidth, align: "left" });
    pdf.y += 22;
    for (const r of rendered) {
      pdf.font("serif").fontSize(10.5);
      const h = pdf.heightOfString(r.title, { width: contentWidth - 40, lineGap: 1 });
      if (pdf.y + h > bottomLimit()) {
        page++;
        if (page >= tocStart + tocPages) break;
        pdf.switchToPage(page);
        pdf.y = M.top + 20;
      }
      const y = pdf.y;
      pdf.fillColor(INK).text(r.title, M.left, y, { width: contentWidth - 40, lineGap: 1 });
      const after = pdf.y;
      pdf
        .font("serif")
        .fontSize(10)
        .fillColor(MUTED)
        .text(String(r.startPage + 1), M.left + contentWidth - 36, y, { width: 36, align: "right" });
      pdf.y = after + 7;
      resetX();
    }
  }

  /* cabeçalhos correntes e números de página */
  const range = pdf.bufferedPageRange();
  const starts = new Set(rendered.map((r) => r.startPage));
  let currentTitle = "";
  for (let i = 0; i < range.count; i++) {
    const r = rendered.find((x) => x.startPage === i);
    if (r) currentTitle = r.title;
    if (i >= tocStart + tocPages) runningHeads.set(i, currentTitle);
  }
  for (let i = tocStart; i < range.count; i++) {
    pdf.switchToPage(i);
    const savedBottom = pdf.page.margins.bottom;
    pdf.page.margins.bottom = 0;
    pdf
      .font("serif")
      .fontSize(8.5)
      .fillColor(MUTED)
      .text(String(i + 1), M.left, PAGE[1] - M.bottom + 30, { width: contentWidth, align: "center", lineBreak: false });
    const head = runningHeads.get(i);
    if (head !== undefined && !starts.has(i)) {
      const label = (i % 2 === 1 ? title : head).toUpperCase();
      pdf
        .font("sans")
        .fontSize(6.6)
        .fillColor(MUTED)
        .text(truncateTo(label, 60), M.left, M.top - 34, { width: contentWidth, align: "center", characterSpacing: 1.2, lineBreak: false });
    }
    pdf.page.margins.bottom = savedBottom;
  }
  void frontPages;

  pdf.end();
  await finished;
  return new Uint8Array(Buffer.concat(chunks));
}

function truncateTo(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}
