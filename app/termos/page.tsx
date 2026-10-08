import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { Metadata } from "next";
import { PUBLIC_MODE } from "@/lib/mode";
import { readSettings } from "@/lib/storage";
import { Contact, LegalPage, sellerOf } from "@/components/legal/legal-page";

export const metadata: Metadata = { title: "Termos de uso" };

export default async function TermsPage() {
  if (PUBLIC_MODE) notFound();
  await connection();
  const seller = sellerOf((await readSettings()).business);
  return (
    <LegalPage
      title="Termos de uso"
      intro={
        <p>
          Estes termos explicam como funciona a tradução de livros oferecida por {seller.name}. Ao enviar um livro e confirmar um pedido, você
          concorda com eles. Escrevemos de forma simples, sem letras miúdas.
        </p>
      }
    >
      <section>
        <h2>1. O que oferecemos</h2>
        <p>
          A tradução automática de livros digitais (EPUB ou PDF), feita com ajuda de inteligência artificial, com uma revisão automática ao final e
          entrega em EPUB e PDF. Antes de baixar, você pode revisar e editar o texto online. Como toda tradução automática, ela pode conter
          imprecisões: revise os trechos importantes.
        </p>
      </section>
      <section>
        <h2>2. Preço e pagamento</h2>
        <p>
          O preço depende do tamanho do livro e do tipo de tradução e aparece antes de qualquer pagamento. É um pagamento único, por livro: não há
          assinatura nem cobrança automática. Durante o beta, as traduções são gratuitas. Quando os pagamentos estiverem ativos, eles serão
          processados por um meio de pagamento parceiro; não guardamos dados de cartão.
        </p>
      </section>
      <section>
        <h2>3. Prazo</h2>
        <p>
          A tradução começa assim que o pedido é confirmado e costuma levar de alguns minutos a algumas horas, conforme o tamanho do livro. Em
          momentos de muita procura, ela pode entrar em fila e continuar sozinha depois. Tudo o que já foi traduzido fica salvo.
        </p>
      </section>
      <section>
        <h2>4. Seus direitos sobre o livro</h2>
        <p>
          Você declara ter o direito de usar o arquivo enviado e de traduzi-lo para o seu uso. A tradução é para uso pessoal: para publicar,
          distribuir ou vender a tradução, é preciso a autorização de quem detém os direitos da obra (exceto obras em domínio público). Não envie
          arquivos com proteção contra cópia (DRM) nem conteúdo ilegal.
        </p>
      </section>
      <section>
        <h2>5. Desistência e reembolso</h2>
        <p>
          Você pode desistir da compra em até 7 dias, conforme o Código de Defesa do Consumidor (art. 49), e receber o valor de volta. Se não
          conseguirmos concluir a tradução por um problema nosso, devolvemos o valor integral. Para pedir, escreva para{" "}
          <Contact email={seller.email} />.
        </p>
      </section>
      <section>
        <h2>6. Seus arquivos</h2>
        <p>
          Guardamos o livro e a tradução para você acompanhar, revisar e baixar, e você pode excluí-los quando quiser, na página do livro. Como não é
          preciso criar conta, os livros ficam ligados ao navegador em que foram enviados.
        </p>
      </section>
      <section>
        <h2>7. Mudanças nestes termos</h2>
        <p>
          Podemos atualizar estes termos. A versão em vigor fica sempre nesta página, com a data da última atualização. Pedidos já confirmados seguem
          os termos da data da compra.
        </p>
      </section>
      <section>
        <h2>8. Contato</h2>
        <p>
          {seller.name} · <Contact email={seller.email} />
        </p>
      </section>
    </LegalPage>
  );
}
