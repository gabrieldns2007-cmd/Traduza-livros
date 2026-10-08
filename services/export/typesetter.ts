/**
 * Compositor de parágrafos para o PDF.
 *
 * O pdfkit justifica mal linhas que misturam fontes (itálico no meio da
 * frase). Aqui fazemos a quebra de linhas nós mesmos: medimos cada palavra
 * na fonte certa, quebramos de forma gulosa usando os hifens condicionais
 * (U+00AD) como pontos de hifenização, e distribuímos o espaço que sobra
 * entre as palavras. Também evitamos deixar uma linha órfã no pé da página.
 */
import type PDFKit from "pdfkit";

export interface StyledRun {
  text: string;
  font: string;
}

interface Frag {
  text: string;
  font: string;
  width: number;
}

interface Word {
  frags: Frag[];
  width: number;
}

interface Line {
  words: Word[];
  width: number;
  last: boolean;
  first: boolean;
}

export interface ParagraphOptions {
  x: number;
  width: number;
  size: number;
  lineHeight: number;
  indent: number;
  align: "justify" | "left" | "center";
  color: string;
  top: number;
  bottom: number;
  spaceFont: string;
}

const SHY = "­";

export class Typesetter {
  private cache = new Map<string, number>();
  constructor(private readonly pdf: PDFKit.PDFDocument) {}

  width(font: string, size: number, text: string): number {
    const key = `${font}|${size}|${text}`;
    let w = this.cache.get(key);
    if (w === undefined) {
      w = this.pdf.font(font).fontSize(size).widthOfString(text);
      this.cache.set(key, w);
    }
    return w;
  }

  private words(runs: StyledRun[], size: number): (Word | "BR")[] {
    const out: (Word | "BR")[] = [];
    let current: Word | null = null;
    const finish = () => {
      if (current && current.frags.length) out.push(current);
      current = null;
    };
    for (const run of runs) {
      for (const piece of run.text.split(/(\n| +)/)) {
        if (!piece) continue;
        if (piece === "\n") {
          finish();
          out.push("BR");
        } else if (/^ +$/.test(piece)) {
          finish();
        } else {
          current ??= { frags: [], width: 0 };
          const w = this.width(run.font, size, piece.replaceAll(SHY, ""));
          current.frags.push({ text: piece, font: run.font, width: w });
          current.width += w;
        }
      }
    }
    finish();
    return out;
  }

  /** Tenta dividir a palavra num hífen condicional para caber em `room`. */
  private split(word: Word, room: number, size: number): [Word, Word] | null {
    if (word.frags.length !== 1 || !word.frags[0].text.includes(SHY)) return null;
    const f = word.frags[0];
    const parts = f.text.split(SHY);
    for (let i = parts.length - 1; i >= 1; i--) {
      const left = parts.slice(0, i).join("") + "-";
      const lw = this.width(f.font, size, left);
      if (lw <= room) {
        const right = parts.slice(i).join(SHY);
        const rw = this.width(f.font, size, right.replaceAll(SHY, ""));
        return [
          { frags: [{ text: left, font: f.font, width: lw }], width: lw },
          { frags: [{ text: right, font: f.font, width: rw }], width: rw },
        ];
      }
    }
    return null;
  }

  private layout(runs: StyledRun[], o: ParagraphOptions): { lines: Line[]; space: number } {
    const space = this.width(o.spaceFont, o.size, " ");
    const lines: Line[] = [];
    let line: Line = { words: [], width: 0, last: false, first: true };
    const avail = () => o.width - (line.first ? o.indent : 0);
    const push = (last: boolean) => {
      line.last = last;
      lines.push(line);
      line = { words: [], width: 0, last: false, first: false };
    };
    const queue = this.words(runs, o.size);
    while (queue.length) {
      const tok = queue.shift()!;
      if (tok === "BR") {
        push(true);
        continue;
      }
      const gap = line.words.length ? space : 0;
      if (line.width + gap + tok.width <= avail()) {
        line.words.push(tok);
        line.width += gap + tok.width;
        continue;
      }
      const parts = this.split(tok, avail() - line.width - gap, o.size);
      if (parts) {
        line.words.push(parts[0]);
        line.width += gap + parts[0].width;
        push(false);
        queue.unshift(parts[1]);
        continue;
      }
      if (!line.words.length) {
        line.words.push(tok);
        line.width = tok.width;
        push(false);
        continue;
      }
      push(false);
      queue.unshift(tok);
    }
    if (line.words.length) push(true);
    else if (lines.length) lines[lines.length - 1].last = true;
    return { lines, space };
  }

  /** Compõe e desenha o parágrafo a partir de `pdf.y`. Retorna o novo y. */
  paragraph(runs: StyledRun[], o: ParagraphOptions): number {
    const { lines, space } = this.layout(runs, o);
    const pdf = this.pdf;
    let y = pdf.y;
    // evita linha órfã: se só a primeira linha cabe nesta página, começa na próxima
    if (lines.length >= 2 && y + o.lineHeight * 2 > o.bottom && y + o.lineHeight <= o.bottom) {
      pdf.addPage();
      y = o.top;
    }
    pdf.fillColor(o.color);
    lines.forEach((line, idx) => {
      if (y + o.lineHeight > o.bottom + 0.5) {
        // evita deixar a última linha sozinha no topo da página seguinte
        pdf.addPage();
        y = o.top;
      }
      const indent = line.first ? o.indent : 0;
      const avail = o.width - indent;
      let x = o.x + indent;
      let gap = space;
      const natural = line.width;
      if (o.align === "center") x += Math.max(0, (avail - natural) / 2);
      else if (o.align === "justify" && !line.last && line.words.length > 1) {
        const extra = (avail - natural) / (line.words.length - 1);
        if (extra < space * 3) gap = space + extra;
      }
      for (const w of line.words) {
        for (const f of w.frags) {
          pdf.font(f.font).fontSize(o.size).text(f.text.replaceAll(SHY, ""), x, y, { lineBreak: false });
          x += f.width;
        }
        x += gap;
      }
      y += o.lineHeight;
      void idx;
    });
    pdf.x = o.x;
    pdf.y = y;
    return y;
  }
}
