import { fail, json, loadBook, viewOf } from "@/lib/api";
import { confirmOrder, OrderError } from "@/services/commerce/orders";
import { publicOrigin } from "@/lib/origin";
import { jobRunner } from "@/services/processing/job-runner";

/**
 * Confirma o pedido. Grátis: a tradução começa na hora, sem pagamento. Literária: no beta
 * começa a tradução; com pagamentos, devolve o endereço do pagamento.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const meta = await loadBook((await params).id);
  if (!meta) return fail("Livro não encontrado.", 404);
  if (jobRunner.isPreviewing(meta.id)) return fail("Aguarde a amostra terminar.", 409);
  try {
    const result = await confirmOrder(meta, publicOrigin(request));
    return json({ ...result, book: viewOf((await loadBook(meta.id))!) });
  } catch (err) {
    if (err instanceof OrderError) return fail(err.message, err.status);
    throw err;
  }
}
