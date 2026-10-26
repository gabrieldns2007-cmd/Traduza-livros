import Link from "next/link";
import type { ReactNode } from "react";
import { FaqAccordion } from "./faq-accordion";

/**
 * Perguntas frequentes — as mesmas na página inicial e em Preços.
 * Ficam aqui (fora do "use client") para que qualquer Server Component possa
 * ler os textos; a parte interativa mora em faq-accordion.tsx.
 */
export const FAQ: [string, string][] = [
  [
    "A tradução grátis é grátis mesmo?",
    "É. A tradução Grátis não custa nada, em qualquer tamanho de livro, e não pede cartão. Ela é feita por serviços de IA gratuitos, então pode levar mais tempo: não há prazo garantido.",
  ],
  [
    "Qual a diferença entre a Grátis e a Literária?",
    "A Grátis traduz o livro inteiro sem custo, conforme os serviços gratuitos ficam disponíveis. A Literária é paga: tem mais cuidado com a voz do autor, o ritmo e as imagens, e usa um serviço de IA pago, que não usa o seu texto para treinar IA. Ela aparece com o valor quando estiver disponível.",
  ],
  [
    "Como é feito o orçamento da Literária?",
    "Pelo tamanho do livro (número de palavras). Você verá o valor exato antes de continuar — sem taxas escondidas.",
  ],
  ["Preciso assinar alguma coisa?", "Não. Sem assinatura: a Grátis não cobra nada, e a Literária tem um valor único por livro, uma vez só."],
  [
    "Posso ver uma amostra antes de decidir?",
    "Sim, e é grátis. Depois de enviar o livro, peça uma amostra: um trecho do começo, com o original ao lado. A amostra é feita pela tradução grátis.",
  ],
  [
    "Quanto tempo demora?",
    "Na Literária, de alguns minutos a algumas horas, conforme o tamanho do livro. Na Grátis, não há prazo garantido: ela avança conforme os serviços gratuitos ficam disponíveis e pode levar bem mais tempo, principalmente em livros longos. Você pode fechar a página: a tradução continua e você acompanha quando voltar.",
  ],
  [
    "E se a tradução parar no meio?",
    "Tudo o que já foi traduzido fica salvo, e ela continua do mesmo ponto — na Grátis, sozinha, quando os serviços gratuitos voltam. Nada é traduzido duas vezes, nem entra de novo no orçamento.",
  ],
  [
    "Posso trocar a Grátis pela Literária no meio?",
    "Pode, se a Literária estiver disponível: enquanto a Grátis espera, você pode traduzir o restante na Literária, pagando só pelas palavras que faltam. A troca só acontece se você escolher e confirmar.",
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
    "Consigo ver meus livros em outro aparelho?",
    "Por enquanto não é preciso criar conta: os livros ficam ligados ao navegador em que foram enviados. Se trocar de aparelho, fale com a gente pelo e-mail de contato.",
  ],
  [
    "O que acontece com o meu arquivo?",
    "Ele é usado para fazer a sua tradução e fica guardado para você revisar e baixar. Não é publicado nem vendido, e pode ser excluído quando você quiser. Na tradução grátis (e na amostra grátis), o texto passa por serviços de IA gratuitos de terceiros, que podem guardar o texto, usá-lo para treinar IA e permitir que pessoas o leiam. Não use para textos confidenciais. Detalhes na Política de privacidade.",
  ],
];

const PRIVACY = "Política de privacidade";

/** Transforma a menção à Política de privacidade num link de texto. */
function answerNode(text: string): ReactNode {
  const at = text.indexOf(PRIVACY);
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <Link href="/privacidade" className="link text-ink">
        {PRIVACY}
      </Link>
      {text.slice(at + PRIVACY.length)}
    </>
  );
}

export function Faq({ items = FAQ }: { items?: [string, string][] }) {
  return <FaqAccordion items={items.map(([question, answer]) => ({ question, answer: answerNode(answer) }))} />;
}
