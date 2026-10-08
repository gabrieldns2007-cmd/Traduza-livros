/**
 * Verso (versão pública): todo pedido para /api/… é respondido pela própria
 * página aberta, que guarda os livros no aparelho (IndexedDB) e faz a tradução
 * com a chave gratuita da pessoa. Nada disso passa por um servidor.
 *
 * Exceções que vão para a internet normalmente: /api/relay/… (repasse sem
 * estado para serviços que não aceitam chamadas diretas do navegador).
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith("/api/") || url.pathname.startsWith("/api/relay/")) return;
  event.respondWith(forward(event));
});

async function pickClient(event) {
  // a aba “líder” (a que guarda os livros e roda a tradução) responde por todas
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const leader = await new Promise((resolve) => {
    if (!all.length) return resolve(null);
    let answered = false;
    let pending = all.length;
    for (const c of all) {
      const ch = new MessageChannel();
      ch.port1.onmessage = (m) => {
        pending--;
        if (m.data && m.data.leader && !answered) {
          answered = true;
          resolve(c);
        } else if (!pending && !answered) resolve(null);
      };
      c.postMessage({ type: "verso-who-leads" }, [ch.port2]);
    }
    setTimeout(() => !answered && resolve(null), 1500);
  });
  if (leader) return leader;
  return (event.clientId && (await self.clients.get(event.clientId))) || all[0] || null;
}

async function forward(event) {
  const req = event.request;
  const client = await pickClient(event);
  if (!client) {
    return new Response(JSON.stringify({ error: "Abra o Verso para continuar." }), { status: 503, headers: { "content-type": "application/json" } });
  }
  const body = req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer();
  const ch = new MessageChannel();
  const reply = new Promise((resolve) => {
    ch.port1.onmessage = (m) => resolve(m.data);
  });
  client.postMessage({ type: "verso-api", url: req.url, method: req.method, headers: [...req.headers], body }, body ? [ch.port2, body] : [ch.port2]);
  const r = await reply;
  return new Response(r.body, { status: r.status, headers: r.headers });
}
