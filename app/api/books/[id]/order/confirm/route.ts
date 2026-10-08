import { fail, json, loadBook, viewOf } from "@/lib/api";
import { confirmOrder, OrderError } from "@/services/commerce/orders";

/** Confirma o pedido: no beta começa a tradução; com pagamentos, devolve o endereço do pagamento. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const meta = await loadBook((await params).id);
  if (!meta) return fail("Livro não encontrado.", 404);
  try {
    const result = await confirmOrder(meta, new URL(request.url).origin);
    return json({ ...result, book: viewOf((await loadBook(meta.id))!) });
  } catch (err) {
    if (err instanceof OrderError) return fail(err.message, err.status);
    throw err;
  }
}
