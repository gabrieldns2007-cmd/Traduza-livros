/**
 * Importação de um livro enviado: valida o arquivo, converte PDF → EPUB se
 * necessário, lê a estrutura, segmenta cada capítulo e grava tudo no disco.
 */
import { franc } from "franc-min";
import type { BookMeta, SourceFormat } from "@/types/book";
import { store } from "@/lib/storage";
import { fromIso3, findLanguage, DEFAULT_TARGET } from "@/lib/languages";
import { toPlainText } from "@/lib/markup";
import { EpubError, isXhtml, openZip, readPackage, readZipText } from "./epub-package";
import { segmentDocument } from "./segmenter";
import { pdfToEpub } from "./pdf-import";
import { buildChapters, type ParsedDoc } from "./chapters";

export class ImportError extends Error {}

export function detectFormat(bytes: Uint8Array): SourceFormat | null {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  if (head.includes("%PDF-")) return "pdf";
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return "epub";
  return null;
}

export interface ImportOptions {
  fileName: string;
  targetLanguage?: string;
  sourceLanguage?: string | null;
}

export async function importBook(bytes: Uint8Array, opts: ImportOptions): Promise<BookMeta> {
  const format = detectFormat(bytes);
  if (!format) throw new ImportError("Formato não reconhecido. Envie um arquivo .epub ou .pdf.");

  const id = store.newId();
  try {
    let epubBytes: Uint8Array = bytes;
    let pdfTitle: string | undefined;
    if (format === "pdf") {
      await store.writeFile(id, "original.pdf", bytes);
      const converted = await pdfToEpub(bytes, { fileName: opts.fileName });
      epubBytes = converted.epub;
      pdfTitle = converted.title;
    }
    await store.writeFile(id, "source.epub", epubBytes);

    const zip = await openZip(epubBytes);
    const pkg = await readPackage(zip);

    const docs: ParsedDoc[] = [];
    for (let index = 0; index < pkg.spine.length; index++) {
      const { item } = pkg.spine[index];
      if (!isXhtml(item) || item.href === pkg.navPath) continue;
      const source = await readZipText(zip, item.href);
      if (source == null) continue;

      const docId = `d${String(docs.length + 1).padStart(3, "0")}`;
      let seg;
      try {
        seg = segmentDocument(source, item.href);
      } catch (err) {
        console.warn(`[import] falha ao segmentar ${item.href}:`, err);
        continue;
      }
      await store.writeSkeleton(id, docId, seg.skeleton);
      await store.writeDoc(id, docId, seg.content);
      docs.push({
        meta: { id: docId, index, href: item.href, segmentCount: seg.content.segments.length },
        content: seg.content,
        anchors: seg.anchors,
        title: seg.title,
      });
    }

    const chapters = buildChapters(docs, pkg.toc);
    const sample = languageSample(docs);

    if (!chapters.length) {
      throw new ImportError(
        format === "pdf" ? "Não encontramos texto neste PDF. Ele pode ser digitalizado (só imagens)." : "Não encontramos texto neste EPUB.",
      );
    }

    const detected = detectLanguage(sample, pkg.language);
    const now = new Date().toISOString();
    const meta: BookMeta = {
      id,
      createdAt: now,
      updatedAt: now,
      originalFileName: opts.fileName,
      originalFormat: format,
      fileSize: bytes.byteLength,
      title: pkg.title || pdfTitle || prettifyFileName(opts.fileName),
      author: pkg.author,
      sourceLanguage: opts.sourceLanguage || null,
      detectedLanguage: detected,
      targetLanguage: findLanguage(opts.targetLanguage)?.code ?? DEFAULT_TARGET,
      status: "ready",
      activeChapterIds: [],
      docs: docs.map((d) => d.meta),
      chapters,
      toc: pkg.toc,
      totals: {
        words: chapters.reduce((s, c) => s + c.wordCount, 0),
        segments: chapters.reduce((s, c) => s + c.segmentCount, 0),
        chapters: chapters.length,
      },
      progress: { translatedWords: 0, translatedSegments: 0, activeMs: 0, measuredWords: 0 },
      options: { dialogueStyle: "target", deepContext: true },
      usage: { inputTokens: 0, outputTokens: 0 },
      cover: pkg.coverPath,
      contentVersion: 0,
    };
    await store.create(meta);
    return meta;
  } catch (err) {
    await store.remove(id).catch(() => undefined);
    if (err instanceof EpubError) throw new ImportError(err.message);
    throw err;
  }
}

function languageSample(docs: ParsedDoc[]): string {
  const parts: string[] = [];
  let len = 0;
  for (const d of docs) {
    for (const s of d.content.segments) {
      if (s.role !== "paragraph" || s.words < 8) continue;
      const t = toPlainText(s.src);
      parts.push(t);
      len += t.length;
      if (len >= 8000) return parts.join("\n");
    }
  }
  return parts.join("\n");
}

function detectLanguage(sample: string, declared?: string): string | null {
  if (sample.length >= 200) {
    const iso3 = franc(sample, { minLength: 100 });
    const lang = iso3 !== "und" ? fromIso3(iso3) : undefined;
    if (lang) {
      // franc não distingue pt-BR de pt-PT: respeita o que o EPUB declarar
      if (lang.code === "pt-BR" && declared && findLanguage(declared)?.code === "pt-PT") return "pt-PT";
      return lang.code;
    }
  }
  return findLanguage(declared)?.code ?? null;
}

export function prettifyFileName(name: string): string {
  return (
    name
      .replace(/\.(epub|pdf)$/i, "")
      .replace(/[._]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "Livro sem título"
  );
}
