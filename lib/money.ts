/** Formatação de dinheiro e números para as telas de planos e créditos. */
export function brl(v: number): string {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2 });
}

export function credits(n: number): string {
  return `${n.toLocaleString("pt-BR")} ${n === 1 ? "crédito" : "créditos"}`;
}
