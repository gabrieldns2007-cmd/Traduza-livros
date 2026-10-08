/**
 * Repasse SEM ESTADO para o GitHub Models, que não aceita chamadas diretas do
 * navegador (versão pública). A chave vem da própria pessoa, a cada pedido,
 * e não é guardada nem registrada aqui. Só um destino e dois caminhos são aceitos.
 */
const TARGETS: Record<string, string> = {
  github: "https://models.github.ai/inference",
};
const PATHS = new Set(["chat/completions", "models"]);
const PASS_HEADERS = ["content-type", "retry-after", "x-ratelimit-limit-requests", "x-ratelimit-remaining-requests", "x-ratelimit-reset-requests"];

export const maxDuration = 300;

type Ctx = { params: Promise<{ service: string; path: string[] }> };

async function relay(request: Request, { params }: Ctx) {
  const { service, path } = await params;
  const base = TARGETS[service];
  const sub = path.join("/");
  if (!base || !PATHS.has(sub)) return Response.json({ error: "Destino não permitido." }, { status: 404 });
  const auth = request.headers.get("authorization");
  if (!auth) return Response.json({ error: "Falta a chave." }, { status: 401 });
  const upstream = await fetch(`${base}/${sub}`, {
    method: request.method,
    headers: {
      authorization: auth,
      "content-type": request.headers.get("content-type") ?? "application/json",
      ...(service === "github" ? { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } : {}),
    },
    body: request.method === "POST" ? await request.text() : undefined,
    signal: request.signal,
  });
  const headers = new Headers({ "cache-control": "no-store" });
  for (const h of PASS_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

export const GET = relay;
export const POST = relay;
