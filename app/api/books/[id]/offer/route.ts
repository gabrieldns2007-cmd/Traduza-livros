import { fail, json, loadBook } from "@/lib/api";
import { offerFor } from "@/services/commerce/orders";

/** O que o cliente vê antes de pagar: palavras e o preço de cada tipo de tradução. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const meta = await loadBook((await params).id);
  if (!meta) return fail("Livro não encontrado.", 404);
  return json({ offer: await offerFor(meta) });
}
