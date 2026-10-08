import { redirect } from "next/navigation";

/** Os preços agora são por livro (em reais): a página antiga de planos leva para Preços. */
export default function PlansPage() {
  redirect("/precos");
}
