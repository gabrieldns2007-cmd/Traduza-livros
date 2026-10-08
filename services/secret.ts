/**
 * Segredo do servidor para assinar dados (sessão do painel, sessões do
 * pagamento simulado). Usa PAYMENT_SECRET, se definido; senão, cria um
 * aleatório na primeira vez e guarda na pasta de dados (nunca vai para o Git).
 */
import path from "node:path";
import { config } from "@/lib/config";
import { readJson, writeAtomic } from "@/lib/storage";

let cached: string | null = null;

export async function serverSecret(): Promise<string> {
  if (process.env.PAYMENT_SECRET) return process.env.PAYMENT_SECRET;
  if (cached) return cached;
  const file = path.join(config.dataDir, "secret.json");
  const saved = await readJson<{ secret: string }>(file);
  if (saved?.secret) return (cached = saved.secret);
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const secret = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  await writeAtomic(file, JSON.stringify({ secret }));
  return (cached = secret);
}
