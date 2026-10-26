import { z } from "zod";
import { fail, json, loadBook } from "@/lib/api";
import { offerFor, OrderError, placeOrder } from "@/services/commerce/orders";
import { jobRunner } from "@/services/processing/job-runner";

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

/**
 * Cria o pedido (preço travado). Grátis: confirmado em seguida, sem pagamento; Literária: o
 * pagamento vem em seguida. Num livro começado na Grátis, é a troca para a Literária (só o que falta).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const meta = await loadBook((await params).id);
  if (!meta) return fail("Livro não encontrado.", 404);
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("Pedido inválido.");
  // a amostra ainda está sendo feita: o pedido espera (os mesmos trechos não são traduzidos duas vezes)
  if (jobRunner.isPreviewing(meta.id)) return fail("Aguarde a amostra terminar.", 409);
  try {
    const { level, ...setup } = parsed.data;
    const order = await placeOrder(meta, level, setup);
    return json({ order, offer: await offerFor((await loadBook(meta.id))!) });
  } catch (err) {
    if (err instanceof OrderError) return fail(err.message, err.status);
    throw err;
  }
}
