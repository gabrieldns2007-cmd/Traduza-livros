/**
 * Repasse SEM ESTADO que existia para o GitHub Models (versão pública: ele não
 * aceitava chamadas diretas do navegador). O GitHub encerrou o serviço em
 * 30/07/2026: o repasse não chama mais ninguém e só responde que acabou.
 * Nenhum outro destino é aceito.
 */
import { GITHUB_RETIRED_MESSAGE } from "@/lib/config";

export const maxDuration = 300;

type Ctx = { params: Promise<{ service: string; path: string[] }> };

async function relay(_request: Request, { params }: Ctx) {
  const { service } = await params;
  if (service === "github") return Response.json({ error: GITHUB_RETIRED_MESSAGE }, { status: 410, headers: { "cache-control": "no-store" } });
  return Response.json({ error: "Destino não permitido." }, { status: 404 });
}

export const GET = relay;
export const POST = relay;
