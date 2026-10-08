/**
 * PDF → EPUB.
 *
 * PDFs não têm estrutura de parágrafos: só “pedaços de texto em posições”.
 * Reconstruímos a estrutura com heurísticas tipográficas:
 *   1. agrupa os pedaços em linhas (mesma altura na página);
 *   2. remove cabeçalhos/rodapés repetidos e números de página;
 *   3. descobre o tamanho do corpo de texto, a margem e o entrelinha;
 *   4. junta linhas em parágrafos (recuo, espaço extra, linha curta…),
 *      desfazendo hifenização de fim de linha;
 *   5. linhas maiores que o corpo (ou “Capítulo X”) viram títulos;
 *   6. divide em capítulos pelos títulos (ou a cada ~3.500 palavras);
 *   7. preserva itálico e negrito pelos nomes das fontes.
 * O EPUB resultante segue o mesmo fluxo de um EPUB enviado.
 */
import { getDocumentProxy } from "unpdf";
import { escapeXmlText } from "@/utils/xml";
import { countWords } from "@/utils/text";
import { writeEpub, type WriterChapter } from "@/services/export/epub-writer";

interface Run {
  text: string;
  italic: boolean;
  bold: boolean;
}

interface Line {
  page: number;
  runs: Run[];
  text: string;
  x0: number;
  x1: number;
  y: number;
  size: number;
  bold: boolean;
}

type Block =
  | { kind: "p"; runs: Run[]; page: number }
  | { kind: "h"; text: string; size: number; pattern: boolean; page: number; level?: number }
  | { kind: "hr"; page: number };

const LIGATURES: Record<string, string> = { ﬀ: "ff", ﬁ: "fi", ﬂ: "fl", ﬃ: "ffi", ﬄ: "ffl", ﬅ: "st", ﬆ: "st" };
const CHAPTER_RE =
  /^(chapter|cap[ií]tulo|part|parte|book|livro|prologue|pr[óo]logo|epilogue|ep[íi]logo|introduction|introdu[çc][ãa]o|preface|pref[áa]cio|kapitel|chapitre|cap[ií]tulo)\b/i;
const MAX_PAGES = 3000;

function cleanText(s: string): string {
  return s
    .replace(/[ﬀﬁﬂﬃﬄﬅﬆ]/g, (c) => LIGATURES[c] ?? c)
    .replace(/­/g, "")
    .replace(/\s+/g, " ");
}

function mode(values: number[], weights?: number[]): number {
  const counts = new Map<number, number>();
  values.forEach((v, i) => counts.set(v, (counts.get(v) ?? 0) + (weights?.[i] ?? 1)));
  let best = values[0] ?? 0;
  let bestCount = -1;
  for (const [v, c] of counts) if (c > bestCount) [best, bestCount] = [v, c];
  return best;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

export async function pdfToEpub(data: Uint8Array, opts: { fileName: string }): Promise<{ epub: Uint8Array; title?: string }> {
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const pageCount = Math.min(pdf.numPages, MAX_PAGES);
  const fontStyles = new Map<string, { italic: boolean; bold: boolean }>();
  const pages: { lines: Line[]; height: number; width: number }[] = [];

  for (let p = 1; p <= pageCount; p++) {
    const page = await pdf.getPage(p);
    const [vx0, vy0, vx1, vy1] = page.view;
    const tc = await page.getTextContent();
    const items = (tc.items as Array<{ str: string; transform: number[]; width: number; height: number; fontName: string }>).filter(
      (it) => typeof it.str === "string" && it.str.length > 0,
    );

    // nomes reais das fontes (para itálico/negrito) — carregados sob demanda
    if (items.some((it) => !fontStyles.has(it.fontName))) {
      try {
        await page.getOperatorList();
      } catch {
        /* sem estilos para esta página */
      }
      for (const it of items) {
        if (fontStyles.has(it.fontName)) continue;
        let name = "";
        try {
          name = (page.commonObjs.get(it.fontName) as { name?: string } | undefined)?.name ?? "";
        } catch {
          name = "";
        }
        fontStyles.set(it.fontName, {
          italic: /italic|oblique|-it\b|[a-z]It$/i.test(name),
          bold: /bold|black|heavy|semibold|demi|-bd\b/i.test(name),
        });
      }
    }

    // agrupa em linhas
    const sorted = items
      .map((it) => {
        const size = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
        return { ...it, x: it.transform[4], y: it.transform[5], size };
      })
      .filter((it) => Math.abs(it.transform[1]) < 0.01) // ignora texto girado
      .sort((a, b) => b.y - a.y || a.x - b.x);

    const lines: Line[] = [];
    let current: (typeof sorted)[number][] = [];
    const flush = () => {
      if (!current.length) return;
      current.sort((a, b) => a.x - b.x);
      const runs: Run[] = [];
      let lastEnd = -Infinity;
      for (const it of current) {
        const style = fontStyles.get(it.fontName) ?? { italic: false, bold: false };
        let text = cleanText(it.str);
        const gap = it.x - lastEnd;
        const prev = runs[runs.length - 1];
        if (prev && gap > it.size * 0.15 && !/\s$/.test(prev.text) && !/^\s/.test(text)) text = " " + text;
        if (prev && prev.italic === style.italic && prev.bold === style.bold) prev.text += text;
        else runs.push({ text, ...style });
        lastEnd = it.x + it.width;
      }
      const text = runs
        .map((r) => r.text)
        .join("")
        .trim();
      if (text) {
        const letters = runs.reduce((s, r) => s + r.text.trim().length, 0) || 1;
        const boldLetters = runs.filter((r) => r.bold).reduce((s, r) => s + r.text.trim().length, 0);
        lines.push({
          page: p,
          runs,
          text,
          x0: current[0].x,
          x1: lastEnd,
          y: current[0].y,
          size: Math.round(Math.max(...current.map((c) => c.size)) * 2) / 2,
          bold: boldLetters / letters > 0.85,
        });
      }
      current = [];
    };
    for (const it of sorted) {
      if (current.length && Math.abs(current[0].y - it.y) > Math.max(2, it.size * 0.45)) flush();
      current.push(it);
    }
    flush();
    pages.push({ lines, height: vy1 - vy0, width: vx1 - vx0 });
    page.cleanup();
  }

  const allLines = pages.flatMap((p) => p.lines);
  if (allLines.length === 0) throw new Error("Não encontramos texto neste PDF. Ele pode ser digitalizado (só imagens).");

  /* ---- cabeçalhos, rodapés e números de página ---- */
  const norm = (s: string) => s.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  const edgeCounts = new Map<string, number>();
  for (const pg of pages) {
    const edges = [pg.lines[0], pg.lines[pg.lines.length - 1]].filter(Boolean);
    for (const l of new Set(edges)) edgeCounts.set(norm(l.text), (edgeCounts.get(norm(l.text)) ?? 0) + 1);
  }
  const repeatThreshold = Math.max(3, Math.floor(pages.length * 0.2));
  for (const pg of pages) {
    const isEdge = (l: Line, idx: number) => {
      const top = idx <= 1 && l.y > pg.height * 0.85;
      const bottom = idx >= pg.lines.length - 2 && l.y < pg.height * 0.15;
      if (!top && !bottom) return false;
      if (/^[\divxlcIVXLC\s.\-–—|]+$/.test(l.text) && l.text.length < 12) return true;
      return (edgeCounts.get(norm(l.text)) ?? 0) >= repeatThreshold;
    };
    pg.lines = pg.lines.filter((l, idx) => !isEdge(l, idx));
  }

  /* ---- métricas do corpo de texto ---- */
  const body = pages.flatMap((p) => p.lines);
  const bodySize = mode(
    body.map((l) => l.size),
    body.map((l) => l.text.length),
  );
  const gaps: number[] = [];
  for (const pg of pages) {
    const bl = pg.lines.filter((l) => Math.abs(l.size - bodySize) < 0.6);
    for (let i = 1; i < bl.length; i++) {
      const g = bl[i - 1].y - bl[i].y;
      if (g > 0 && g < bodySize * 3) gaps.push(g);
    }
  }
  const lineGap = median(gaps) || bodySize * 1.25;
  const pageMetrics = pages.map((pg) => {
    const bl = pg.lines.filter((l) => Math.abs(l.size - bodySize) < 0.6);
    const left = bl.length ? mode(bl.map((l) => Math.round(l.x0))) : 0;
    const right = bl.length
      ? percentile(
          bl.map((l) => l.x1),
          0.9,
        )
      : pg.width;
    return { left, right };
  });

  /* ---- blocos: títulos, parágrafos, quebras de cena ---- */
  const blocks: Block[] = [];
  let para: { runs: Run[]; page: number; last: Line } | null = null;
  const pushPara = () => {
    if (para) blocks.push({ kind: "p", runs: para.runs, page: para.page });
    para = null;
  };
  const appendLine = (line: Line) => {
    if (!para) {
      para = { runs: line.runs.map((r) => ({ ...r })), page: line.page, last: line };
      para.runs[0].text = para.runs[0].text.trimStart();
      return;
    }
    const lastRun = para.runs[para.runs.length - 1];
    const prevText = lastRun.text.trimEnd();
    const firstRun = { ...line.runs[0], text: line.runs[0].text.trimStart() };
    const rest = line.runs.slice(1).map((r) => ({ ...r }));
    // hifenização de fim de linha: “tradu-” + “ção” → “tradução”
    if (/[\p{L}]-$/u.test(prevText) && /^\p{Ll}/u.test(firstRun.text)) {
      lastRun.text = prevText.slice(0, -1);
    } else {
      lastRun.text = prevText + " ";
    }
    for (const r of [firstRun, ...rest]) {
      const tail = para.runs[para.runs.length - 1];
      if (tail.italic === r.italic && tail.bold === r.bold) tail.text += r.text;
      else para.runs.push(r);
    }
    para.last = line;
  };

  for (let pi = 0; pi < pages.length; pi++) {
    const pg = pages[pi];
    const { left, right } = pageMetrics[pi];
    const width = right - left || pg.width;
    for (let li = 0; li < pg.lines.length; li++) {
      const line = pg.lines[li];
      const prevLine = li > 0 ? pg.lines[li - 1] : null;
      const nextLine = pg.lines[li + 1];
      const text = line.text;

      const bigger = line.size >= bodySize * 1.18 && text.length <= 150;
      const centered = line.x0 > left + width * 0.12 && Math.abs(line.x0 - left - (right - line.x1)) < width * 0.12;
      const gapAbove = prevLine ? prevLine.y - line.y : Infinity;
      const gapBelow = nextLine ? line.y - nextLine.y : Infinity;
      const isolated = gapAbove > lineGap * 1.6 && gapBelow > lineGap * 1.4;
      const pattern = CHAPTER_RE.test(text) && text.length <= 60 && (isolated || centered || li === 0);
      const boldHeading = line.bold && text.length <= 80 && isolated && !/[.,;]$/.test(text);

      if (/^[*•·#~\s—–-]{1,15}$/.test(text) && /[*•·#~]/.test(text)) {
        pushPara();
        blocks.push({ kind: "hr", page: pg.lines[li].page });
        continue;
      }

      if (bigger || pattern || boldHeading) {
        pushPara();
        const last = blocks[blocks.length - 1];
        // títulos de várias linhas no mesmo tamanho viram um só
        if (last && last.kind === "h" && Math.abs(last.size - line.size) < 0.6 && last.page === line.page && gapAbove < lineGap * 2.2 && bigger) {
          last.text += " " + text;
        } else {
          blocks.push({ kind: "h", text, size: bigger ? line.size : bodySize, pattern: pattern && !bigger, page: line.page });
        }
        continue;
      }

      let newPara = !para;
      if (para && !newPara) {
        const p: { runs: Run[]; page: number; last: Line } = para;
        const prev = p.last;
        const samePage = prev.page === line.page;
        const prevText = p.runs[p.runs.length - 1].text.trimEnd();
        const endsSentence = /[.!?:;"”’»)\]…—]$/.test(prevText);
        const indent = line.x0 - left;
        if (samePage) {
          const gap = prev.y - line.y;
          if (gap > lineGap * 1.45) newPara = true;
          else if (indent > bodySize * 0.6 && indent < bodySize * 8) newPara = true;
          else if (prev.x1 < right - bodySize * 3.5 && endsSentence) newPara = true;
        } else {
          // virada de página: continua o parágrafo se a frase não terminou
          const startsLower = /^\p{Ll}/u.test(text);
          if (indent > bodySize * 0.6 && indent < bodySize * 8) newPara = true;
          else if (endsSentence && !startsLower) newPara = true;
        }
      }
      if (newPara) pushPara();
      appendLine(line);
    }
  }
  pushPara();

  /* ---- níveis de título ---- */
  const headingSizes = [
    ...new Set(blocks.filter((b): b is Extract<Block, { kind: "h" }> => b.kind === "h" && !b.pattern).map((b) => Math.round(b.size))),
  ].sort((a, b) => b - a);
  for (const b of blocks) {
    if (b.kind !== "h") continue;
    b.level = b.pattern ? Math.min(headingSizes.length + 1, 2) : Math.min(3, headingSizes.indexOf(Math.round(b.size)) + 1);
  }

  /* ---- título do livro ---- */
  const meta = await pdf.getMetadata().catch(() => null);
  const info = (meta?.info ?? {}) as Record<string, unknown>;
  const metaTitle = typeof info.Title === "string" ? info.Title.trim() : "";
  const firstHeading = blocks.find((b): b is Extract<Block, { kind: "h" }> => b.kind === "h" && b.page <= 3 && b.level === 1);
  const title =
    metaTitle && !/^(untitled|microsoft word|document|sem título)/i.test(metaTitle) && !/\.(docx?|pdf|indd)$/i.test(metaTitle)
      ? metaTitle
      : (firstHeading?.text ?? opts.fileName.replace(/\.pdf$/i, ""));
  const author = typeof info.Author === "string" && info.Author.trim() ? info.Author.trim() : undefined;

  /* ---- capítulos ---- */
  const chapterLevel = (() => {
    for (const lvl of [1, 2, 3]) {
      const n = blocks.filter((b) => b.kind === "h" && b.level === lvl).length;
      if (n >= 2 && n <= 400) return lvl;
    }
    return 0;
  })();

  const chapters: { title: string; blocks: Block[] }[] = [];
  let cur: { title: string; blocks: Block[] } | null = null;
  for (const b of blocks) {
    const isSplit = chapterLevel > 0 && b.kind === "h" && (b.level ?? 9) <= chapterLevel;
    if (isSplit) {
      if (cur && cur.blocks.length) chapters.push(cur);
      cur = { title: (b as Extract<Block, { kind: "h" }>).text, blocks: [b] };
    } else {
      if (!cur) cur = { title: "", blocks: [] };
      cur.blocks.push(b);
    }
  }
  if (cur && cur.blocks.length) chapters.push(cur);

  // sem títulos utilizáveis: divide por tamanho
  let finalChapters = chapters;
  if (chapterLevel === 0 || chapters.length > 400) {
    finalChapters = [];
    let acc: Block[] = [];
    let words = 0;
    for (const b of blocks) {
      acc.push(b);
      if (b.kind === "p") words += countWords(b.runs.map((r) => r.text).join(""));
      if (words >= 3500 && b.kind === "p") {
        finalChapters.push({ title: `Parte ${finalChapters.length + 1}`, blocks: acc });
        acc = [];
        words = 0;
      }
    }
    if (acc.length) finalChapters.push({ title: `Parte ${finalChapters.length + 1}`, blocks: acc });
  }

  const writerChapters: WriterChapter[] = finalChapters
    .filter((c) => c.blocks.some((b) => b.kind !== "hr"))
    .map((c, i) => ({
      title: c.title || (i === 0 ? "Início" : `Parte ${i + 1}`),
      body: renderBlocks(c.blocks),
    }));

  const epub = await writeEpub({ title, author, language: "und", chapters: writerChapters });
  return { epub, title };
}

function renderRuns(runs: Run[]): string {
  const merged: Run[] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && last.italic === r.italic && last.bold === r.bold) last.text += r.text;
    else merged.push({ ...r });
  }
  const allBold = merged.every((r) => r.bold || !r.text.trim());
  return merged
    .map((r) => {
      let t = escapeXmlText(r.text);
      if (!r.text.trim()) return t;
      // preserva espaços fora das tags de ênfase
      const lead = t.match(/^\s*/)![0];
      const trail = t.match(/\s*$/)![0];
      t = t.trim();
      if (r.italic) t = `<em>${t}</em>`;
      if (r.bold && !allBold) t = `<strong>${t}</strong>`;
      return lead + t + trail;
    })
    .join("")
    .trim();
}

function renderBlocks(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === "hr") out.push("<hr/>");
    else if (b.kind === "h") {
      const tag = b.level === 1 ? "h1" : b.level === 2 ? "h2" : "h3";
      out.push(`<${tag}>${escapeXmlText(b.text)}</${tag}>`);
    } else {
      const html = renderRuns(b.runs);
      if (html) out.push(`<p>${html}</p>`);
    }
  }
  return out.join("\n");
}
