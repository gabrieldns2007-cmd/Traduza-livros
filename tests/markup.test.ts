import { describe, expect, it } from "vitest";
import { repairMarkup, renderXhtml, renderSafeHtml, tagKeys, toPlainText, markupFromEdit } from "@/lib/markup";
import type { InlineTag } from "@/types/book";

const tags: Record<string, InlineTag> = {
  "1": { n: "em", o: '<em class="x">' },
  "2": { n: "br", o: "<br/>", v: 1 },
  "3": { n: "a", o: '<a href="#n1" id="r1">' },
};

describe("markup", () => {
  it("renderiza XHTML com as tags originais e escapa o texto", () => {
    const xhtml = renderXhtml("Tom &amp; <em_1>Daisy</em_1> &lt;3<br_2/>fim", tags);
    expect(xhtml).toBe('Tom &amp; <em class="x">Daisy</em> &lt;3<br/>fim');
  });

  it("conserta aninhamento quebrado e descarta tags desconhecidas", () => {
    const r = repairMarkup("<em_1>abc <a_3>def</em_1> ghi</a_3> <x_9>!</x_9>", tags, new Set([1, 3]));
    expect(r.markup).toBe("<em_1>abc <a_3>def</a_3></em_1> ghi !");
    expect(r.missing).toEqual([]);
    expect(r.issues).toBeGreaterThan(0);
  });

  it("aponta tags perdidas pela tradução", () => {
    const r = repairMarkup("sem tags", tags, tagKeys("<em_1>a</em_1><br_2/>"));
    expect(r.missing.sort()).toEqual([1, 2]);
  });

  it("gera HTML seguro sem atributos do livro", () => {
    const html = renderSafeHtml("<em_1>oi</em_1> <a_3>link</a_3> <script>", tags);
    expect(html).toBe('<em data-k="1">oi</em> <span data-k="3">link</span> &lt;script&gt;');
    expect(toPlainText("<em_1>a</em_1> &lt;b&gt;")).toBe("a <b>");
  });

  it("converte edições do editor de volta, criando novas tags de ênfase", () => {
    const t = { ...tags };
    const m = markupFromEdit([{ x: "Olá " }, { k: 1, c: [{ x: "mundo" }] }, { f: "strong", c: [{ x: "!" }] }], t);
    expect(m).toMatch(/^Olá <em_1>mundo<\/em_1><strong_(\d+)>!<\/strong_\1>$/);
    expect(renderXhtml(m, t)).toBe('Olá <em class="x">mundo</em><strong>!</strong>');
  });
});
