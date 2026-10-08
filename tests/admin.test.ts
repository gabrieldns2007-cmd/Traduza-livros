/**
 * Painel administrativo: a senha é criada pelo próprio painel (sem editar
 * arquivos), guardada só como hash, e protege /admin e /api/admin/*. O
 * cliente não consegue mudar como paga nem as chaves.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { DEFAULT_SETTINGS, readSettings, writeSettings } from "@/lib/storage";
import { adminProtected, adminSessionToken, isAdminToken, setAdminPassword, verifyAdminPassword } from "@/services/admin/access";
import { checkoutConfig } from "@/services/commerce/orders";
import { proxy } from "@/proxy";
import { PUT as customerPut } from "@/app/api/settings/route";
import { PUT as adminPut } from "@/app/api/admin/settings/route";
import { GET as listBooks } from "@/app/api/books/route";
import { importBook } from "@/services/parsing/import-book";
import { store } from "@/lib/storage";
import { fixtureEpub } from "./helpers";

afterEach(async () => {
  await fs.rm(path.join(config.dataDir, "admin.json"), { force: true });
  delete process.env.ADMIN_PASSWORD;
  await writeSettings({ ...DEFAULT_SETTINGS });
});

const put = (body: unknown) =>
  new Request("http://x/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("senha do painel", () => {
  it("é criada no painel, guardada como hash e troca derruba a sessão antiga", async () => {
    expect(await adminProtected()).toBe(false);
    expect(await isAdminToken(undefined)).toBe(true); // sem senha: painel aberto (com aviso)
    await expect(setAdminPassword("curta")).rejects.toThrow(/8 caracteres/);

    await setAdminPassword("senha-forte-1");
    const raw = await fs.readFile(path.join(config.dataDir, "admin.json"), "utf8");
    expect(raw).not.toContain("senha-forte-1");
    expect(await adminProtected()).toBe(true);
    expect(await verifyAdminPassword("senha-forte-1")).toBe(true);
    expect(await verifyAdminPassword("errada")).toBe(false);

    const token = await adminSessionToken();
    expect(await isAdminToken(token)).toBe(true);
    expect(await isAdminToken(undefined)).toBe(false);
    await setAdminPassword("outra-senha-2");
    expect(await isAdminToken(token)).toBe(false);
  });

  it("o proxy fecha /admin e /api/admin quando há senha", async () => {
    await setAdminPassword("senha-forte-1");
    const page = await proxy(new NextRequest("http://localhost/admin"));
    expect(page.headers.get("location")).toMatch(/\/admin\/entrar$/);
    const apiRes = await proxy(new NextRequest("http://localhost/api/admin/overview"));
    expect(apiRes.status).toBe(401);
    const ok = await proxy(new NextRequest("http://localhost/admin", { headers: { cookie: `verso_admin=${await adminSessionToken()}` } }));
    expect(ok.headers.get("location")).toBeNull();
    // a página de entrada e os avisos de pagamento continuam abertos
    expect((await proxy(new NextRequest("http://localhost/admin/entrar"))).headers.get("location")).toBeNull();
  });
});

describe("vendas pelo painel", () => {
  it("o painel escolhe o pagamento simulado; o cliente não consegue mudar", async () => {
    expect((await checkoutConfig()).mode).toBe("beta");
    await customerPut(put({ checkout: { mode: "live", provider: "simulado" }, business: { name: "X" } }));
    expect((await checkoutConfig()).mode).toBe("beta");
    expect((await readSettings()).business).toBeUndefined();

    const res = await adminPut(
      put({ checkout: { mode: "live", provider: "simulado" }, business: { name: " Verso Traduções ", email: "contato@verso.com" } }),
    );
    expect(res.status).toBe(200);
    expect(await checkoutConfig()).toEqual({ mode: "live", provider: "simulado", fromEnv: false });
    expect((await readSettings()).business).toEqual({ name: "Verso Traduções", email: "contato@verso.com" });
    expect((await adminPut(put({ business: { email: "não-é-email" } }))).status).toBe(400);
  });
});

describe("cada cliente vê só os próprios livros", () => {
  it("livro de outro navegador: 404; o painel vê todos; livro antigo sem dono só o painel", async () => {
    await setAdminPassword("senha-forte-1");
    const mk = async (owner?: string) => {
      const meta = await importBook(await fixtureEpub(), { fileName: "a.epub", targetLanguage: "pt-BR" });
      await store.update(meta.id, (m) => {
        if (owner) m.ownerId = owner;
      });
      return meta.id;
    };
    const ana = "a".repeat(24);
    const bia = "b".repeat(24);
    const livroAna = await mk(ana);
    const livroBia = await mk(bia);
    const antigo = await mk();
    const req = (url: string, cookie: string) => new NextRequest(`http://localhost${url}`, { headers: { cookie } });
    const blocked = (r: Response) => r.status === 404 || Boolean(r.headers.get("location"));

    expect(blocked(await proxy(req(`/api/books/${livroAna}`, `verso_owner=${ana}`)))).toBe(false);
    expect(blocked(await proxy(req(`/livros/${livroAna}`, `verso_owner=${ana}`)))).toBe(false);
    expect(blocked(await proxy(req(`/api/books/${livroBia}/export/epub`, `verso_owner=${ana}`)))).toBe(true);
    expect(blocked(await proxy(req(`/livros/${livroBia}`, `verso_owner=${ana}`)))).toBe(true);
    expect(blocked(await proxy(req(`/api/books/${antigo}`, `verso_owner=${ana}`)))).toBe(true);
    const admin = `verso_admin=${await adminSessionToken()}`;
    expect(blocked(await proxy(req(`/api/books/${antigo}`, admin)))).toBe(false);
    expect(blocked(await proxy(req(`/api/books/${livroBia}`, admin)))).toBe(false);

    const list = async (cookie: string) =>
      ((await (await listBooks(new Request("http://x/api/books", { headers: { cookie } }))).json()) as { books: { id: string }[] }).books.map(
        (b) => b.id,
      );
    expect(await list(`verso_owner=${ana}`)).toEqual([livroAna]);
    expect(await list("")).toEqual([]);
    expect((await list(admin)).sort()).toEqual([livroAna, livroBia, antigo].sort());

    // primeira visita: o navegador ganha um identificador
    const first = await proxy(new NextRequest("http://localhost/"));
    expect(first.headers.get("set-cookie")).toMatch(/verso_owner=[a-f0-9]{24}/);
  });
});
