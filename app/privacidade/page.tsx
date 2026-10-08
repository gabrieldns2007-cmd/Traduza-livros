import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { Metadata } from "next";
import { PUBLIC_MODE } from "@/lib/mode";
import { readSettings } from "@/lib/storage";
import { Contact, LegalPage, sellerOf } from "@/components/legal/legal-page";

export const metadata: Metadata = { title: "Política de privacidade" };

export default async function PrivacyPage() {
  if (PUBLIC_MODE) notFound();
  await connection();
  const seller = sellerOf((await readSettings()).business);
  return (
    <LegalPage
      title="Política de privacidade"
      intro={<p>Esta política explica quais dados tratamos e por quê, conforme a Lei Geral de Proteção de Dados (Lei nº 13.709/2018).</p>}
    >
      <section>
        <h2>1. Quem é o responsável</h2>
        <p>
          {seller.name}. Contato: <Contact email={seller.email} />.
        </p>
      </section>
      <section>
        <h2>2. Quais dados tratamos</h2>
        <ul>
          <li>O arquivo do livro que você envia e a tradução gerada.</li>
          <li>Suas preferências de tradução (idioma, estilo dos diálogos, pedidos ao tradutor).</li>
          <li>Um identificador aleatório, guardado num cookie, que liga os livros a este navegador.</li>
          <li>Quando os pagamentos estiverem ativos: os dados do pedido (valor, data e situação).</li>
        </ul>
        <p className="mt-3">
          Não pedimos nome, e-mail ou documento para traduzir. Os dados de pagamento ficam com o meio de pagamento: não vemos nem guardamos o número
          do cartão.
        </p>
      </section>
      <section>
        <h2>3. Para que usamos</h2>
        <p>
          Para fazer a tradução, mostrar o andamento, permitir a revisão e o download, e responder quando você nos procurar. Não vendemos seus dados
          nem os usamos para publicidade.
        </p>
      </section>
      <section>
        <h2>4. Com quem compartilhamos</h2>
        <p>
          Para traduzir, o texto do livro é enviado a provedores de inteligência artificial que contratamos. Alguns desses provedores, em seus planos
          gratuitos, podem usar o conteúdo recebido para melhorar os próprios serviços, conforme os termos deles. Quando os pagamentos estiverem
          ativos, o meio de pagamento recebe os dados necessários para processar a compra.
        </p>
      </section>
      <section>
        <h2>5. Por quanto tempo guardamos</h2>
        <p>
          O livro e a tradução ficam guardados até você excluí-los, na página do livro. Registros de pedidos podem ser mantidos pelo prazo exigido em
          lei (por exemplo, para fins fiscais).
        </p>
      </section>
      <section>
        <h2>6. Cookies</h2>
        <p>
          Usamos apenas cookies necessários para o site funcionar: o identificador dos seus livros e, quando houver, o de acesso protegido por senha.
          Não usamos cookies de publicidade nem de análise.
        </p>
      </section>
      <section>
        <h2>7. Seus direitos</h2>
        <p>
          Você pode pedir acesso, correção ou exclusão dos seus dados, e tirar dúvidas, pelo e-mail <Contact email={seller.email} />. Também pode
          excluir seus livros a qualquer momento, na página de cada um.
        </p>
      </section>
      <section>
        <h2>8. Segurança</h2>
        <p>Os arquivos ficam num servidor de acesso restrito, e cada navegador só abre os próprios livros.</p>
      </section>
      <section>
        <h2>9. Mudanças nesta política</h2>
        <p>Se esta política mudar, a nova versão aparece nesta página, com a data da última atualização.</p>
      </section>
    </LegalPage>
  );
}
