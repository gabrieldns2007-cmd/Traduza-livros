/**
 * Anúncios: desligados por padrão, configurados só pelo painel (o cliente não
 * consegue mudar nem ver a configuração), com validação estrita, ads.txt
 * aberto mesmo com a senha do site, nunca para o dono logado (AdSense) e
 * nunca fora dos cinco lugares permitidos.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { DEFAULT_SETTINGS, readSettings, writeSettings } from "@/lib/storage";
import {
  AD_PLACEMENTS,
  adsDisclosure,
  adsProblem,
  adsTxt,
  bookAdPlacement,
  normalizeAds,
  pickPublisherId,
  pickSlotId,
  resolveAd,
  type AdsSettings,
} from "@/lib/ads";
import { adminSessionToken, setAdminPassword } from "@/services/admin/access";
import { adFor, adsFor } from "@/services/ads";
import { proxy } from "@/proxy";
import { GET as customerGet, PUT as customerPut } from "@/app/api/settings/route";
import { PUT as adminPut } from "@/app/api/admin/settings/route";
import { GET as adsTxtGet } from "@/app/ads.txt/route";
import { AdSlot, adsenseBlocked, googleScript } from "@/components/ads/ad-slot";
import { legalUpdated, LEGAL_UPDATED } from "@/components/legal/legal-page";

// o cookie do painel “desta requisição” (adFor lê pelo cookies() do Next)
const jar = vi.hoisted(() => ({ admin: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "verso_admin" && jar.admin ? { name, value: jar.admin } : undefined) }),
}));

afterEach(async () => {
  await fsp.rm(path.join(config.dataDir, "admin.json"), { force: true });
  delete process.env.APP_PASSWORD;
  jar.admin = undefined;
  await writeSettings({ ...DEFAULT_SETTINGS });
});

const PUB = "1234567890123456";
const put = (body: unknown) =>
  new Request("http://x/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const errorOf = async (res: Response) => ((await res.json()) as { error?: string }).error;

const house: AdsSettings = {
  enabled: true,
  source: "house",
  house: { title: "Livraria Aurora", text: "Clássicos com desconto.", url: "https://aurora.example.com/", cta: "Ver ofertas", sponsor: "Aurora" },
};
const adsense: AdsSettings = { enabled: true, source: "adsense", adsense: { publisherId: `ca-pub-${PUB}`, slotId: "1111111111" } };

describe("configuração pelo painel", () => {
  it("o painel salva e arruma; o cliente não muda nem vê", async () => {
    expect((await readSettings()).ads).toBeUndefined();
    const body = {
      ads: {
        enabled: true,
        source: "adsense",
        // o dono colou o código inteiro do AdSense: o Verso encontra os números
        adsense: {
          publisherId: ` <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=pub-${PUB}"></script> `,
          slotId: '<ins class="adsbygoogle" data-ad-slot="9876543210"></ins>',
          slots: { pronto: " 5555555555 ", livros: "" },
        },
        house: { title: "  ", url: "" },
        placements: { traduzindo: false },
      },
    };
    // sem a senha do painel, qualquer pessoa poderia publicar um anúncio: ligar é recusado
    const open = await adminPut(put(body));
    expect(open.status).toBe(400);
    expect(await errorOf(open)).toMatch(/senha do painel/);
    expect((await readSettings()).ads).toBeUndefined();
    await setAdminPassword("senha-forte-1");
    const res = await adminPut(put(body));
    expect(res.status).toBe(200);
    const ads = (await readSettings()).ads!;
    expect(ads.adsense).toEqual({ publisherId: `ca-pub-${PUB}`, slotId: "9876543210", slots: { pronto: "5555555555" } });
    expect(ads.house?.title).toBeUndefined();
    expect(ads.placements).toEqual({ traduzindo: false });
    expect(ads.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT/);

    // salvar outra parte do painel mantém os anúncios
    await adminPut(put({ business: { name: "Verso" } }));
    expect((await readSettings()).ads?.adsense?.slotId).toBe("9876543210");

    // o cliente não muda nada e nem recebe a configuração
    expect((await customerPut(put({ ads: { enabled: false } }))).status).toBe(200);
    expect((await readSettings()).ads?.enabled).toBe(true);
    const customer = (await (await customerGet()).json()) as { settings: Record<string, unknown> };
    expect(customer.settings).not.toHaveProperty("ads");

    // desligar continua livre (mesmo sem a senha)
    await fsp.rm(path.join(config.dataDir, "admin.json"), { force: true });
    expect((await adminPut(put({ ads: { enabled: false } }))).status).toBe(200);
    expect((await readSettings()).ads?.enabled).toBe(false);
  });

  it("recusa valores errados com mensagens simples", async () => {
    const bad = async (ads: unknown) => {
      const res = await adminPut(put({ ads }));
      expect(res.status).toBe(400);
      return errorOf(res);
    };
    expect(await bad({ adsense: { publisherId: "123" } })).toMatch(/código do editor/);
    expect(await bad({ adsense: { slotId: "abc" } })).toMatch(/bloco de anúncio/);
    expect(await bad({ house: { imageUrl: "http://aurora.example.com/a.png" } })).toMatch(/https:\/\//);
    expect(await bad({ house: { url: "javascript:alert(1)" } })).toMatch(/link do anúncio/);
    expect(await bad({ house: { title: "x".repeat(81) } })).toMatch(/80 caracteres/);
    // ligar sem o necessário
    expect(await bad({ enabled: true, source: "adsense", adsense: { publisherId: `pub-${PUB}` } })).toMatch(/número do bloco/);
    expect(await bad({ enabled: true, source: "house", house: { title: "Oi" } })).toMatch(/título e o link/);
    expect(await bad({ ...adsense, placements: Object.fromEntries(AD_PLACEMENTS.map((p) => [p, false])) })).toMatch(/pelo menos um lugar/);
    expect((await readSettings()).ads).toBeUndefined();
  });

  it("a data do aviso muda só quando o aviso muda", () => {
    const t1 = new Date("2026-11-01T12:00:00Z");
    const on = normalizeAds(undefined, adsense, t1);
    expect(on.updatedAt).toBe(t1.toISOString());
    expect(normalizeAds(on, { adsense: { slotId: "2222222222" } }, new Date("2026-11-02T12:00:00Z")).updatedAt).toBe(t1.toISOString());
    expect(normalizeAds(on, { source: "house", house: house.house }, new Date("2026-11-03T12:00:00Z")).updatedAt).toBe("2026-11-03T12:00:00.000Z");
    expect(normalizeAds(on, { enabled: false }, new Date("2026-11-04T12:00:00Z")).updatedAt).toBe("2026-11-04T12:00:00.000Z");
    // rascunho com tudo desligado: sem data
    expect(normalizeAds(undefined, { adsense: { publisherId: `ca-pub-${PUB}` } }).updatedAt).toBeUndefined();
    expect(legalUpdated(undefined)).toBe(LEGAL_UPDATED);
    expect(LEGAL_UPDATED).toBe("8 de outubro de 2026");
    expect(legalUpdated("2026-11-04T12:00:00.000Z")).toBe("4 de novembro de 2026");
  });

  it("entende o que o dono cola", () => {
    expect(pickPublisherId(`pub-${PUB}`)).toBe(`ca-pub-${PUB}`);
    expect(pickPublisherId(`google.com, pub-${PUB}, DIRECT, f08c47fec0942fa0`)).toBe(`ca-pub-${PUB}`);
    expect(pickPublisherId("")).toBe("");
    expect(pickPublisherId("ca-pub-12")).toBeNull();
    // 16 algarismos, nem mais nem menos (um a mais é erro de digitação, não outro código)
    expect(pickPublisherId(`ca-pub-${PUB}7`)).toBeNull();
    expect(pickPublisherId("ca-pub-123456789012")).toBeNull();
    expect(pickPublisherId(`data-ad-client="ca-pub-${PUB}"`)).toBe(`ca-pub-${PUB}`);
    expect(pickSlotId("1234567890")).toBe("1234567890");
    expect(pickSlotId("12a")).toBeNull();
    expect(adsProblem({ enabled: false })).toBeNull();
    expect(adsDisclosure({ enabled: false, source: "adsense" })).toBeNull();
    expect(adsDisclosure(adsense)).toEqual({ adsense: true, house: false });
    expect(adsDisclosure(house)).toEqual({ adsense: false, house: true });
  });
});

describe("ads.txt", () => {
  it("existe assim que o código do editor é salvo (mesmo desligado); sem código, 404", async () => {
    expect((await adsTxtGet()).status).toBe(404);
    await writeSettings({ ...DEFAULT_SETTINGS, ads: { enabled: false, adsense: { publisherId: `ca-pub-${PUB}` } } });
    const res = await adsTxtGet();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await res.text()).toBe(`google.com, pub-${PUB}, DIRECT, f08c47fec0942fa0\n`);
    expect(adsTxt({ adsense: { publisherId: "lixo" } })).toBeNull();
  });

  it("o proxy deixa o Google ler o /ads.txt mesmo com a senha do site", async () => {
    process.env.APP_PASSWORD = "senha-do-site";
    const res = await proxy(new NextRequest("http://localhost/ads.txt"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
    // o resto do site continua fechado
    expect((await proxy(new NextRequest("http://localhost/"))).headers.get("location")).toMatch(/\/entrar$/);
    expect((await proxy(new NextRequest("http://localhost/ads.txt/x"))).headers.get("location")).toMatch(/\/entrar/);
  });

  it("o matcher do proxy também deixa o /ads.txt de fora", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "proxy.ts"), "utf8");
    expect(src).toMatch(/matcher:.*ads\\\\\.txt\$/);
  });
});

describe("qual anúncio cada página recebe", () => {
  it("desligado, lugar desligado ou incompleto: nada", async () => {
    expect(await adFor("home")).toBeNull();
    await writeSettings({ ...DEFAULT_SETTINGS, ads: { ...adsense, enabled: false } });
    expect(await adFor("home")).toBeNull();
    await writeSettings({ ...DEFAULT_SETTINGS, ads: adsense });
    expect(await adFor("precos")).toBeNull(); // desligado de início
    expect(await adFor("traduzindo")).toBeNull(); // tela de espera: desligado de início
    expect(await adFor("home")).toEqual({ kind: "adsense", client: `ca-pub-${PUB}`, slot: "1111111111" });
    await writeSettings({ ...DEFAULT_SETTINGS, ads: { ...adsense, adsense: { publisherId: `ca-pub-${PUB}` } } });
    expect(await adFor("home")).toBeNull(); // sem bloco: nunca anúncios automáticos
    await writeSettings({
      ...DEFAULT_SETTINGS,
      ads: { ...adsense, adsense: { ...adsense.adsense, slots: { pronto: "3333333333" } }, placements: { traduzindo: true } },
    });
    expect(await adsFor(["traduzindo", "pronto"])).toEqual({
      traduzindo: { kind: "adsense", client: `ca-pub-${PUB}`, slot: "1111111111" },
      pronto: { kind: "adsense", client: `ca-pub-${PUB}`, slot: "3333333333" },
    });
  });

  it("o dono logado no painel não vê o AdSense (só com senha do painel)", async () => {
    await writeSettings({ ...DEFAULT_SETTINGS, ads: adsense });
    // sem senha do painel não dá para saber quem é o dono: todos veem
    expect(await adFor("livros")).not.toBeNull();
    await setAdminPassword("senha-forte-1");
    expect(await adFor("livros")).not.toBeNull();
    jar.admin = await adminSessionToken();
    expect(await adFor("livros")).toBeNull();
    jar.admin = "cookie-velho";
    expect(await adFor("livros")).not.toBeNull();
    // o anúncio do patrocinador continua aparecendo para o dono (não há clique proibido)
    jar.admin = await adminSessionToken();
    await writeSettings({ ...DEFAULT_SETTINGS, ads: house });
    expect(await adFor("livros")).toMatchObject({ kind: "house", title: "Livraria Aurora", url: "https://aurora.example.com/" });
  });

  it("patrocinador: só links e imagens seguros", () => {
    const evil: AdsSettings = { ...house, house: { ...house.house, url: "javascript:alert(1)" } };
    expect(resolveAd(evil, "home")).toBeNull();
    const img = resolveAd({ ...house, house: { ...house.house, imageUrl: "http://aurora.example.com/a.png" } }, "home");
    expect(img && img.kind === "house" && img.imageUrl).toBeFalsy();
  });

  it("a versão pública não tem anúncios nem ads.txt", async () => {
    await writeSettings({ ...DEFAULT_SETTINGS, ads: adsense });
    process.env.NEXT_PUBLIC_VERSO_MODE = "public";
    vi.resetModules();
    try {
      const ads = await import("@/services/ads");
      const route = await import("@/app/ads.txt/route");
      expect(await ads.adFor("home")).toBeNull();
      expect((await route.GET()).status).toBe(404);
    } finally {
      delete process.env.NEXT_PUBLIC_VERSO_MODE;
      vi.resetModules();
    }
  });
});

describe("onde nunca aparece", () => {
  it("só os cinco lugares; nenhum é pagamento, leitura, painel ou texto legal", () => {
    expect([...AD_PLACEMENTS]).toEqual(["home", "precos", "livros", "traduzindo", "pronto"]);
    for (const p of AD_PLACEMENTS) expect(p).not.toMatch(/pag|checkout|revis|admin|entrar|termo|privac|config|conta/);
  });

  it("na página do livro: nunca no pedido nem com erro", () => {
    expect(bookAdPlacement("ready")).toBeNull();
    expect(bookAdPlacement("error")).toBeNull();
    // pausado: a pessoa precisa tocar em “Continuar tradução” — o anúncio não fica colado no botão
    expect(bookAdPlacement("paused")).toBeNull();
    for (const s of ["queued", "analyzing", "translating"]) expect(bookAdPlacement(s)).toBe("traduzindo");
    expect(bookAdPlacement("done")).toBe("pronto");
  });

  it("só estas páginas usam um espaço de publicidade", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(e.name)) files.push(full);
      }
    };
    walk(path.join(process.cwd(), "app"));
    walk(path.join(process.cwd(), "components"));
    const users = files
      .filter((f) => /<AdSlot\b|\badsFor\(|\badFor\(/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(process.cwd(), f).split(path.sep).join("/"))
      .sort();
    expect(users).toEqual(
      [
        "app/livros/[id]/page.tsx",
        "app/livros/page.tsx",
        "app/page.tsx",
        "app/precos/page.tsx",
        "components/book/book-screen.tsx",
        "components/home/landing.tsx",
        "components/library/library-page-view.tsx",
      ].sort(),
    );
  });

  it("o anúncio é sempre identificado e não imita os botões do Verso", () => {
    const html = renderToStaticMarkup(
      createElement(AdSlot, {
        ad: resolveAd({ ...house, house: { ...house.house, imageUrl: "https://aurora.example.com/a.png" } }, "home"),
        placement: "home",
      }),
    );
    expect(html).toContain("Publicidade");
    expect(html).toContain('rel="sponsored noopener noreferrer"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('loading="lazy"');
    expect(html).not.toMatch(/accent|bg-ink|<svg/);
    expect(renderToStaticMarkup(createElement(AdSlot, { ad: null, placement: "home" }))).toBe("");
    const google = renderToStaticMarkup(createElement(AdSlot, { ad: resolveAd(adsense, "home"), placement: "home" }));
    expect(google).toContain("Publicidade");
    expect(google).toContain(`data-ad-client="ca-pub-${PUB}"`);
    expect(google).toContain('data-ad-slot="1111111111"');
    // no celular: o anúncio fica dentro da moldura (sem “largura total”) e sem margem dos lados (cabe 300 ou 320 px)
    expect(google).toContain('data-full-width-responsive="false"');
    expect(google).not.toMatch(/class="[^"]*(?<![:\w-])px-5/);
  });

  it("bloqueador de anúncios: o espaço do Google some, também nas páginas abertas depois", () => {
    try {
      // o next/script avisa o erro uma vez só (e, para o espaço seguinte, diz que “carregou”):
      // a situação fica guardada para a aba inteira
      googleScript.set("failed");
      googleScript.set("loaded");
      const seen: string[] = [];
      googleScript.watch(() => seen.push(googleScript.state))();
      expect(seen).toEqual(["failed"]);
      // carregou, mas o bloco ficou escondido ou nunca foi processado (script trocado por um vazio)
      expect(adsenseBlocked({ offsetHeight: 0, getAttribute: () => "done" })).toBe(true);
      expect(adsenseBlocked({ offsetHeight: 250, getAttribute: () => null })).toBe(true);
      expect(adsenseBlocked({ offsetHeight: 250, getAttribute: () => "done" })).toBe(false);
    } finally {
      googleScript.state = "pending";
    }
  });
});
