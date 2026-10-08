/** Perguntas frequentes — as mesmas na página inicial e em Preços. */
export const FAQ: [string, string][] = [
  [
    "Como o preço é calculado?",
    "Pelo tamanho do livro (número de palavras) e pelo tipo de tradução. Você vê o valor exato antes de pagar — sem taxas escondidas.",
  ],
  ["Vou ser cobrado de novo depois?", "Não. O pagamento é único, por livro. Não existe assinatura nem cobrança automática."],
  ["Posso ver a tradução antes de pagar?", "Sim. Depois de enviar o livro, peça uma amostra grátis: um trecho do começo, com o original ao lado."],
  [
    "Quanto tempo demora?",
    "De alguns minutos a algumas horas, conforme o tamanho do livro. Você pode fechar a página: a tradução continua e você acompanha quando voltar.",
  ],
  [
    "E se a tradução parar no meio?",
    "Tudo o que já foi traduzido fica salvo, e ela continua do mesmo ponto — nada é traduzido (nem cobrado) duas vezes.",
  ],
  ["Posso corrigir alguma coisa?", "Pode. Na revisão, cada parágrafo traduzido aparece ao lado do original e pode ser editado antes de baixar."],
  [
    "Quais arquivos posso enviar?",
    "EPUB (o melhor ponto de partida) ou PDF com texto selecionável. Livros com proteção contra cópia (DRM) não podem ser lidos.",
  ],
  [
    "Posso publicar a tradução?",
    "A tradução é para o seu uso. Para publicar ou vender, você precisa da autorização de quem tem os direitos do livro (exceto obras em domínio público).",
  ],
  [
    "O que acontece com o meu arquivo?",
    "Ele é usado para fazer a sua tradução e fica guardado para você revisar e baixar. Não é publicado nem vendido, e você pode excluí-lo quando quiser.",
  ],
];

export function Faq({ items = FAQ }: { items?: [string, string][] }) {
  return (
    <div className="divide-y divide-rule border-y border-rule">
      {items.map(([q, a]) => (
        <details key={q} className="group py-4">
          <summary className="flex min-h-8 cursor-pointer list-none items-baseline justify-between gap-4 text-[1rem] text-ink [&::-webkit-details-marker]:hidden">
            {q}
            <span className="shrink-0 text-[1.25rem] leading-none text-muted transition-transform duration-300 group-open:rotate-45">+</span>
          </summary>
          <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink-2">{a}</p>
        </details>
      ))}
    </div>
  );
}
