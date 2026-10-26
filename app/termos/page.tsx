import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { Metadata } from "next";
import { PUBLIC_MODE } from "@/lib/mode";
import { readSettings } from "@/lib/storage";
import { adsDisclosure } from "@/lib/ads";
import { Contact, LegalPage, legalUpdated, sellerOf } from "@/components/legal/legal-page";

export const metadata: Metadata = { title: "Termos de uso" };

export default async function TermsPage() {
  if (PUBLIC_MODE) notFound();
  await connection();
  const settings = await readSettings();
  const seller = sellerOf(settings.business);
  // publicidade (painel → Anúncios): a cláusula só aparece com os anúncios ligados
  const ads = adsDisclosure(settings.ads);
  const n = ads ? 1 : 0;
  return (
    <LegalPage
      title="Termos de uso"
      updated={legalUpdated(settings.ads?.updatedAt)}
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
          entrega em EPUB e PDF, em dois tipos: a <strong className="font-medium text-ink">tradução Grátis</strong>, sem custo, e a{" "}
          <strong className="font-medium text-ink">tradução Literária</strong>, paga. Antes de baixar, você pode revisar e editar o texto online. Como
          toda tradução automática, ela pode conter imprecisões: revise os trechos importantes.
        </p>
        <p className="mt-3">É preciso ter 18 anos ou mais para usar o Verso.</p>
      </section>
      <section>
        <h2>2. Preço e pagamento</h2>
        <p>
          A tradução Grátis não custa nada, em qualquer tamanho de livro, e não pede pagamento nem cartão. A Literária tem um preço que depende do
          tamanho do livro e aparece antes de qualquer pagamento. É um pagamento único, por livro: não há assinatura nem cobrança automática. Durante
          o beta, a Literária também sai sem custo. Quando os pagamentos estiverem ativos, eles serão processados por um meio de pagamento parceiro;
          não guardamos dados de cartão.
        </p>
      </section>
      <section>
        <h2>3. A tradução grátis</h2>
        <ul>
          <li>
            É feita por serviços de inteligência artificial gratuitos de terceiros, escolhidos automaticamente conforme a disponibilidade de cada um:
            o serviço gratuito de IA do Google (Gemini), o Groq, a Cloudflare (Workers AI) e o modo gratuito da Mistral. A amostra grátis também é
            feita por eles. Esses serviços podem guardar o texto, usá-lo para treinar IA e permitir que pessoas o leiam, conforme os termos de cada
            um: o Google usa o texto enviado e as respostas para melhorar os próprios produtos, com leitura por revisores humanos; a Mistral, no modo
            gratuito, usa o texto para treinar os modelos dela, a menos que essa opção esteja desligada na conta. Por isso, não use a tradução grátis
            para textos confidenciais ou com dados pessoais de outras pessoas.
          </li>
          <li>
            A tradução grátis não é oferecida a quem está no Espaço Econômico Europeu, na Suíça ou no Reino Unido: os termos do serviço gratuito de IA
            do Google (Gemini) não permitem usá-lo para atender pessoas nesses lugares. Quem está lá pode usar a Literária, quando ela estiver
            disponível.
          </li>
          <li>
            Não há prazo garantido. Esses serviços têm limites de uso: quando nenhum está disponível, a tradução pausa e continua sozinha depois, do
            mesmo ponto, o que pode levar horas ou dias. Tudo o que já foi traduzido fica salvo.
          </li>
          <li>
            Se a Literária estiver disponível, você pode trocar para ela no meio do livro e pagar só pelas palavras que faltam. A troca só acontece se
            você escolher e confirmar; nada muda sozinho. A Literária usa um serviço de IA pago, cujos termos comerciais não permitem usar o seu texto
            para treinar modelos de IA.
          </li>
        </ul>
      </section>
      <section>
        <h2>4. Prazo</h2>
        <p>
          A tradução começa assim que o pedido é confirmado. Na Literária, costuma levar de alguns minutos a algumas horas, conforme o tamanho do
          livro; em momentos de muita procura, ela pode entrar em fila e continuar sozinha depois. Na Grátis, não há prazo garantido (veja o item 3).
          Tudo o que já foi traduzido fica salvo.
        </p>
      </section>
      <section>
        <h2>5. Seus direitos sobre o livro</h2>
        <p>
          Você declara ter o direito de usar o arquivo enviado e de traduzi-lo para o seu uso. A tradução é para uso pessoal: para publicar,
          distribuir ou vender a tradução, é preciso a autorização de quem detém os direitos da obra (exceto obras em domínio público). Não envie
          arquivos com proteção contra cópia (DRM) nem conteúdo ilegal.
        </p>
      </section>
      <section>
        <h2>6. Desistência e reembolso</h2>
        <p>
          Na Literária, você pode desistir da compra em até 7 dias, conforme o Código de Defesa do Consumidor (art. 49), e receber o valor de volta.
          Se não conseguirmos concluir a tradução paga por um problema nosso, devolvemos o valor integral. Para pedir, escreva para{" "}
          <Contact email={seller.email} />. A tradução Grátis não tem nada a reembolsar: nada é cobrado.
        </p>
      </section>
      <section>
        <h2>7. Seus arquivos</h2>
        <p>
          Guardamos o livro e a tradução para você acompanhar, revisar e baixar, e você pode excluí-los quando quiser, na página do livro. Como não é
          preciso criar conta, os livros ficam ligados ao navegador em que foram enviados.
        </p>
      </section>
      {ads && (
        <section>
          <h2>8. Publicidade</h2>
          <p>
            Algumas páginas do site mostram anúncios, identificados como “Publicidade”. Eles não interferem na tradução, nunca aparecem no pagamento
            nem na leitura do seu livro, e não somos responsáveis pelo conteúdo dos sites dos anunciantes.
          </p>
        </section>
      )}
      <section>
        <h2>{8 + n}. Mudanças nestes termos</h2>
        <p>
          Podemos atualizar estes termos. A versão em vigor fica sempre nesta página, com a data da última atualização. Pedidos já confirmados seguem
          os termos da data da compra.
        </p>
      </section>
      <section>
        <h2>{9 + n}. Contato</h2>
        <p>
          {seller.name} · <Contact email={seller.email} />
        </p>
      </section>
    </LegalPage>
  );
}
