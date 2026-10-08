/**
 * Gerador de EPUB 3 mínimo e válido (com NCX para leitores EPUB 2).
 * Usado quando o livro de origem é um PDF: o texto extraído vira um EPUB
 * simples, que depois segue exatamente o mesmo fluxo de um EPUB enviado.
 */
import JSZip from "jszip";
import { randomId as randomUUID } from "@/utils/id";
import { escapeXmlAttr, escapeXmlText } from "@/utils/xml";

export interface WriterChapter {
  title: string;
  /** conteúdo do <body>, em XHTML bem-formado */
  body: string;
}

export interface WriterBook {
  title: string;
  author?: string;
  language: string;
  chapters: WriterChapter[];
  identifier?: string;
}

export const BOOK_CSS = `
html { font-size: 100%; }
body { margin: 0 5%; line-height: 1.55; font-family: serif; text-align: justify; hyphens: auto; -webkit-hyphens: auto; }
h1, h2, h3 { font-weight: normal; text-align: center; line-height: 1.25; hyphens: none; -webkit-hyphens: none; page-break-after: avoid; break-after: avoid; }
h1 { font-size: 1.6em; margin: 3em 0 1.5em; }
h2 { font-size: 1.3em; margin: 2em 0 1em; }
h3 { font-size: 1.1em; margin: 1.5em 0 0.75em; font-style: italic; }
p { margin: 0; text-indent: 1.4em; }
h1 + p, h2 + p, h3 + p, hr + p, p.first { text-indent: 0; }
hr { border: 0; text-align: center; margin: 1.5em 0; }
hr::after { content: "⁂"; }
.title-page { text-align: center; margin-top: 30%; }
.title-page h1 { margin: 0 0 1em; }
.title-page p { text-indent: 0; text-align: center; }
`;

export function xhtmlDocument(title: string, lang: string, body: string, cssHref = "../style.css"): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXmlAttr(lang)}" lang="${escapeXmlAttr(lang)}">
<head>
<meta charset="utf-8"/>
<title>${escapeXmlText(title)}</title>
<link rel="stylesheet" type="text/css" href="${escapeXmlAttr(cssHref)}"/>
</head>
<body>
${body}
</body>
</html>
`;
}

export async function writeEpub(book: WriterBook): Promise<Uint8Array> {
  const zip = new JSZip();
  const id = book.identifier ?? `urn:uuid:${randomUUID()}`;
  const lang = book.language || "und";
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`,
  );
  zip.file("OEBPS/style.css", BOOK_CSS.trim() + "\n");

  const chapterFiles = book.chapters.map((c, i) => ({
    ...c,
    file: `text/ch${String(i + 1).padStart(3, "0")}.xhtml`,
    itemId: `ch${String(i + 1).padStart(3, "0")}`,
  }));

  for (const c of chapterFiles) {
    zip.file(`OEBPS/${c.file}`, xhtmlDocument(c.title, lang, c.body));
  }

  const navItems = chapterFiles.map((c) => `      <li><a href="${escapeXmlAttr(c.file)}">${escapeXmlText(c.title)}</a></li>`).join("\n");
  zip.file(
    "OEBPS/nav.xhtml",
    xhtmlDocument(
      book.title,
      lang,
      `<nav epub:type="toc" id="toc">
  <h1>${escapeXmlText(book.title)}</h1>
  <ol>
${navItems}
  </ol>
</nav>`,
      "style.css",
    ),
  );

  const navPoints = chapterFiles
    .map(
      (c, i) => `    <navPoint id="np${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${escapeXmlText(c.title)}</text></navLabel>
      <content src="${escapeXmlAttr(c.file)}"/>
    </navPoint>`,
    )
    .join("\n");
  zip.file(
    "OEBPS/toc.ncx",
    `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${escapeXmlAttr(lang)}">
  <head>
    <meta name="dtb:uid" content="${escapeXmlAttr(id)}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escapeXmlText(book.title)}</text></docTitle>
  <navMap>
${navPoints}
  </navMap>
</ncx>
`,
  );

  const manifest = [
    `    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
    `    <item id="css" href="style.css" media-type="text/css"/>`,
    ...chapterFiles.map((c) => `    <item id="${c.itemId}" href="${escapeXmlAttr(c.file)}" media-type="application/xhtml+xml"/>`),
  ].join("\n");
  const spine = chapterFiles.map((c) => `    <itemref idref="${c.itemId}"/>`).join("\n");

  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${escapeXmlAttr(lang)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${escapeXmlText(id)}</dc:identifier>
    <dc:title>${escapeXmlText(book.title)}</dc:title>
${book.author ? `    <dc:creator>${escapeXmlText(book.author)}</dc:creator>\n` : ""}    <dc:language>${escapeXmlText(lang)}</dc:language>
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
${manifest}
  </manifest>
  <spine toc="ncx">
${spine}
  </spine>
</package>
`,
  );

  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 9 }, mimeType: "application/epub+zip" });
}
