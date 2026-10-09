/**
 * “Meus livros”: a cara de cada livro na estante (ordem, tecidos, espessura,
 * etiquetas e ações) — funções puras, iguais no servidor e no navegador.
 */
import { describe, expect, it } from "vitest";
import type { BookStatus, BookSummary } from "@/types/book";
import {
  assignBindings,
  bookAria,
  coverTitle,
  edgeTone,
  primaryAction,
  shelfStatus,
  sortBooks,
  summaryOf,
  thicknessOf,
  titleFit,
} from "@/components/library/book-look";

let n = 0;
function book(status: BookStatus, extra: Partial<BookSummary> = {}): BookSummary {
  n++;
  return {
    id: `livro-${n}`,
    title: `Livro ${n}`,
    sourceLanguage: null,
    detectedLanguage: "en",
    targetLanguage: "pt-BR",
    status,
    percent: 0,
    chapters: 10,
    words: 40_000,
    originalFormat: "epub",
    hasCover: false,
    createdAt: new Date(Date.UTC(2026, 0, n)).toISOString(),
    updatedAt: new Date().toISOString(),
    ...extra,
  };
}

describe("ordem da estante", () => {
  it("quem pede atenção fica no alto; dentro da situação, o mais recente primeiro", () => {
    const old = book("done", { createdAt: "2026-01-01T00:00:00Z" });
    const recent = book("done", { createdAt: "2026-05-01T00:00:00Z" });
    const list = [old, book("ready"), recent, book("error"), book("queued"), book("translating"), book("analyzing"), book("paused")];
    expect(sortBooks(list).map((b) => b.status)).toEqual(["translating", "analyzing", "queued", "paused", "error", "ready", "done", "done"]);
    expect(sortBooks(list).slice(-2)).toEqual([recent, old]);
  });

  it("não muda quando só a data de atualização muda (atualização ao vivo)", () => {
    const a = book("translating", { createdAt: "2026-02-01T00:00:00Z" });
    const b = book("queued", { createdAt: "2026-03-01T00:00:00Z" });
    const first = sortBooks([a, b]).map((x) => x.id);
    const later = sortBooks([
      { ...b, updatedAt: "2030-01-01T00:00:00Z" },
      { ...a, updatedAt: "2020-01-01T00:00:00Z" },
    ]).map((x) => x.id);
    expect(later).toEqual(first);
  });
});

describe("tecidos e formato", () => {
  it("vizinhos com capa tipográfica nunca têm a mesma família de cor", () => {
    const list = Array.from({ length: 60 }, () => book("done"));
    const map = assignBindings(list);
    for (let i = 1; i < list.length; i++) expect(map.get(list[i].id)!.family).not.toBe(map.get(list[i - 1].id)!.family);
  });

  it("o mesmo livro tem sempre o mesmo tecido na mesma posição", () => {
    const list = [book("done"), book("ready"), book("paused")];
    expect([...assignBindings(list).values()]).toEqual([...assignBindings(list).values()]);
  });

  it("espessura segue o número de palavras, com mínimo e máximo", () => {
    expect(thicknessOf(0)).toBe(thicknessOf(3_696));
    expect(thicknessOf(3_696)).toBeLessThan(thicknessOf(51_624));
    expect(thicknessOf(51_624)).toBeLessThan(thicknessOf(200_000));
    expect(thicknessOf(5_000_000)).toBe(thicknessOf(200_000));
    expect(thicknessOf(3_696)).toBeGreaterThanOrEqual(0.09);
    expect(thicknessOf(5_000_000)).toBeLessThanOrEqual(0.26);
  });

  it("títulos longos ficam menores e terminam numa palavra inteira", () => {
    expect(titleFit("Emma")).toBe("normal");
    expect(titleFit("Donaudampfschifffahrtsgesellschaftskapitän")).toBe("xlong");
    const long = "The Extraordinary and Remarkably Long-Winded Adventures of Sir Bartholomew Fitzwilliam Montgomery-Smythe III";
    const cut = coverTitle(long);
    expect(cut.length).toBeLessThanOrEqual(79);
    expect(cut.endsWith("…")).toBe(true);
    expect(long.startsWith(cut.slice(0, -1))).toBe(true);
    expect(coverTitle("Emma")).toBe("Emma");
  });

  it("cor da lombada tirada da capa: capa clara continua clara, escura fica sóbria", () => {
    const alice = edgeTone(188, 169, 154); // faixa esquerda bege
    expect(alice.light).toBe(true);
    expect(alice.spine).toMatch(/^hsl\(\d+ \d+% (7\d|8[0-4])%\)$/);
    const neon = edgeTone(255, 0, 80);
    expect(neon.light).toBe(false);
    const [, s, l] = neon.spine.match(/hsl\(\d+ (\d+)% (\d+)%\)/)!.map(Number);
    expect(s).toBeLessThanOrEqual(40);
    expect(l).toBeLessThanOrEqual(38);
  });
});

describe("etiquetas e ações", () => {
  it("na fila e preparando não pulsam nem mostram barra a 0%", () => {
    expect(shelfStatus(book("queued"))).toMatchObject({ text: "Na fila", pulse: false, meter: false });
    expect(shelfStatus(book("analyzing"))).toMatchObject({ text: "Preparando", pulse: false, meter: false });
    expect(shelfStatus(book("translating", { percent: 21.7 }))).toMatchObject({ text: "Traduzindo", pulse: true, meter: true, percent: 21 });
    expect(shelfStatus(book("done"))).toMatchObject({ text: "Pronto", tone: "done", meter: false });
  });

  it("os textos da etiqueta são curtos (cabem num lugar de ~100 px)", () => {
    for (const s of ["ready", "queued", "analyzing", "translating", "paused", "done", "error"] as BookStatus[])
      expect(shelfStatus(book(s, { percent: 87 })).text.length).toBeLessThanOrEqual(12);
  });

  it("ação principal de cada situação", () => {
    expect(primaryAction(book("done", { id: "x" }))).toEqual({ label: "Ler e revisar", href: "/livros/x/revisar/1" });
    expect(primaryAction(book("ready", { id: "x" }))).toEqual({ label: "Começar tradução", href: "/livros/x" });
    expect(primaryAction(book("translating")).label).toBe("Acompanhar");
    expect(primaryAction(book("queued")).label).toBe("Acompanhar");
    expect(primaryAction(book("analyzing")).label).toBe("Acompanhar");
    expect(primaryAction(book("paused")).label).toBe("Continuar");
    expect(primaryAction(book("error")).label).toBe("Continuar");
  });

  it("nome acessível diz o que é, como está, os idiomas e o que o toque faz", () => {
    const b = book("paused", { title: "Alice", author: "Lewis Carroll", percent: 53.4 });
    expect(bookAria(b)).toBe("Alice, de Lewis Carroll. Pausado, 53%. Inglês para Português (Brasil). Ver detalhes e ações.");
  });

  it("linha de resumo do cabeçalho", () => {
    const parts = summaryOf([book("translating"), book("paused"), book("done"), book("done"), book("ready")]);
    expect(parts.map((p) => p.text)).toEqual(["1 traduzindo agora", "1 pausado", "2 prontos para ler"]);
    expect(parts[0].live).toBe(true);
  });
});
