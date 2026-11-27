/** Freio contra abuso: ninguém lota a fila ou o disco enviando livros sem parar. */
import { afterEach, describe, expect, it } from "vitest";
import { checkUpload, recordUpload, resetLimits } from "@/services/abuse/limits";
import { POST as upload } from "@/app/api/books/route";
import { fixtureEpub } from "./helpers";

afterEach(() => {
  resetLimits();
  delete process.env.UPLOAD_LIMIT_PER_HOUR;
});

const owner = "c".repeat(24);

describe("limites de envio", () => {
  it("10 envios por hora por navegador; depois de uma hora libera", () => {
    const t0 = Date.parse("2026-11-27T10:00:00Z");
    for (let i = 0; i < 10; i++) {
      expect(checkUpload(owner, "1.1.1.1", 0, t0 + i)).toBeNull();
      recordUpload(owner, "1.1.1.1", t0 + i);
    }
    expect(checkUpload(owner, "1.1.1.1", 0, t0 + 20)).toMatch(/Muitos envios.*60 min/);
    // outro navegador em outra rede não é afetado
    expect(checkUpload("d".repeat(24), "2.2.2.2", 0, t0 + 20)).toBeNull();
    expect(checkUpload(owner, "1.1.1.1", 0, t0 + 60 * 60_000 + 10)).toBeNull();
  });

  it("muitos livros parados sem pedido: pede para usar ou apagar antes", () => {
    expect(checkUpload(owner, "1.1.1.1", 15)).toMatch(/15 livros enviados sem pedido/);
    expect(checkUpload(owner, "1.1.1.1", 14)).toBeNull();
  });

  it("a rota recusa com 429 e mensagem em português", async () => {
    process.env.UPLOAD_LIMIT_PER_HOUR = "1";
    const send = async () => {
      const form = new FormData();
      form.set("file", new File([await fixtureEpub()], "livro.epub", { type: "application/epub+zip" }));
      return upload(new Request("http://x/api/books", { method: "POST", body: form, headers: { cookie: `verso_owner=${"e".repeat(24)}`, "x-forwarded-for": "9.9.9.9" } }));
    };
    expect((await send()).status).toBe(201);
    const res = await send();
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toMatch(/Muitos envios/);
  });
});
