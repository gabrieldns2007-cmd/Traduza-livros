/**
 * “Servidor” do Verso dentro do navegador (versão pública).
 *
 * Executa exatamente as mesmas rotas de app/api, com o armazenamento trocado
 * por IndexedDB (ver lib/browser/fs.ts e o resolveAlias em next.config.ts).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- cada rota tipa os próprios parâmetros
type Handler = (req: Request, ctx: { params: Promise<any> }) => Promise<Response> | Response;
type RouteModule = Partial<Record<"GET" | "POST" | "PUT" | "PATCH" | "DELETE", Handler>>;

interface Route {
  path: string;
  pattern: RegExp;
  names: string[];
  load: () => Promise<RouteModule>;
}

function route(path: string, load: () => Promise<RouteModule>): Route {
  const names: string[] = [];
  const re = path
    .split("/")
    .map((seg) => {
      const catchAll = /^\[\.\.\.(\w+)\]$/.exec(seg);
      if (catchAll) {
        names.push(`...${catchAll[1]}`);
        return "(.+)";
      }
      const param = /^\[(\w+)\]$/.exec(seg);
      if (param) {
        names.push(param[1]);
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { path, pattern: new RegExp(`^${re}/?$`), names, load };
}

const ROUTES: Route[] = [
  route("/api/settings", () => import("@/app/api/settings/route")),
  route("/api/billing", () => import("@/app/api/billing/route")),
  route("/api/books", () => import("@/app/api/books/route")),
  route("/api/books/[id]", () => import("@/app/api/books/[id]/route")),
  route("/api/books/[id]/translate", () => import("@/app/api/books/[id]/translate/route")),
  route("/api/books/[id]/providers", () => import("@/app/api/books/[id]/providers/route")),
  route("/api/books/[id]/preview", () => import("@/app/api/books/[id]/preview/route")),
  route("/api/books/[id]/offer", () => import("@/app/api/books/[id]/offer/route")),
  route("/api/books/[id]/order", () => import("@/app/api/books/[id]/order/route")),
  route("/api/books/[id]/order/confirm", () => import("@/app/api/books/[id]/order/confirm/route")),
  route("/api/books/[id]/glossary", () => import("@/app/api/books/[id]/glossary/route")),
  route("/api/books/[id]/cover", () => import("@/app/api/books/[id]/cover/route")),
  route("/api/books/[id]/export/[format]", () => import("@/app/api/books/[id]/export/[format]/route")),
  route("/api/books/[id]/chapters/[chapterId]", () => import("@/app/api/books/[id]/chapters/[chapterId]/route")),
  route("/api/books/[id]/assets/[...path]", () => import("@/app/api/books/[id]/assets/[...path]/route")),
];

/** Rotas respondidas no navegador (um teste confere que nenhuma rota de app/api ficou de fora). */
export function localRoutePaths(): string[] {
  return ROUTES.map((r) => r.path);
}

export async function handle(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  for (const r of ROUTES) {
    const m = r.pattern.exec(pathname);
    if (!m) continue;
    const params: Record<string, string | string[]> = {};
    r.names.forEach((name, i) => {
      const raw = m[i + 1];
      if (name.startsWith("...")) params[name.slice(3)] = raw.split("/").map(decodeURIComponent);
      else params[name] = decodeURIComponent(raw);
    });
    const mod = await r.load();
    const fn = mod[req.method as keyof RouteModule];
    if (!fn) return Response.json({ error: "Método não permitido." }, { status: 405 });
    try {
      return await fn(req, { params: Promise.resolve(params) });
    } catch (err) {
      console.error("[verso] erro na rota local", pathname, err);
      return Response.json({ error: "Algo deu errado. Tente novamente." }, { status: 500 });
    }
  }
  return Response.json({ error: "Não encontrado." }, { status: 404 });
}
