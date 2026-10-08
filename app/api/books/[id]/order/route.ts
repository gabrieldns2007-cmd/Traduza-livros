import { z } from "zod";
import { fail, json, loadBook } from "@/lib/api";
import { offerFor, OrderError, placeOrder } from "@/services/commerce/orders";

const Body = z.object({
  level: z.enum(["padrao", "literaria"]),
  targetLanguage: z.string().max(20).optional(),
  sourceLanguage: z.string().max(20).nullable().optional(),
  options: z
    .object({
      instructions: z.string().max(4000).optional(),
      dialogueStyle: z.enum(["target", "source"]).optional(),
    })
    .optional(),
});

/** Cria o pedido (preço travado). O pagamento vem em seguida, na tela de pagamento. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const meta = await loadBook((await params).id);
  if (!meta) return fail("Livro não encontrado.", 404);
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("Pedido inválido.");
  try {
    const { level, ...setup } = parsed.data;
    const order = await placeOrder(meta, level, setup);
    return json({ order, offer: await offerFor((await loadBook(meta.id))!) });
  } catch (err) {
    if (err instanceof OrderError) return fail(err.message, err.status);
    throw err;
  }
}
