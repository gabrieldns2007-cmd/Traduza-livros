/**
 * Versão pública: toda rota de app/api precisa ter um equivalente no
 * “servidor” do navegador (lib/browser/backend.ts) — senão a tela recebe 404.
 * Ficam de fora só as rotas que existem apenas no servidor de verdade.
 */
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { localRoutePaths } from "@/lib/browser/backend";

// só existem no servidor próprio: senha do site, repasse, painel administrativo e avisos de pagamento
const SERVER_ONLY = [
  "/api/auth",
  "/api/relay/[service]/[...path]",
  "/api/admin/auth",
  "/api/admin/overview",
  "/api/admin/settings",
  "/api/payments/webhook/[provider]",
];

function apiRoutes(dir = path.join(process.cwd(), "app", "api"), prefix = "/api"): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...apiRoutes(path.join(dir, entry.name), `${prefix}/${entry.name}`));
    else if (entry.name === "route.ts") out.push(prefix);
  }
  return out;
}

it("toda rota da API também responde no navegador", () => {
  const local = new Set(localRoutePaths());
  const missing = apiRoutes().filter((r) => !SERVER_ONLY.includes(r) && !local.has(r));
  expect(missing).toEqual([]);
});
