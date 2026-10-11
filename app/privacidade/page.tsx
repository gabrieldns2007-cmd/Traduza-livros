import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { Metadata } from "next";
import { PUBLIC_MODE } from "@/lib/mode";
import { readSettings } from "@/lib/storage";
import { adsDisclosure } from "@/lib/ads";
import { Contact, LegalPage, legalUpdated, sellerOf } from "@/components/legal/legal-page";

export const metadata: Metadata = { title: "Política de privacidade" };

export default async function PrivacyPage() {
  if (PUBLIC_MODE) notFound();
  await connection();
  const settings = await readSettings();
  const seller = sellerOf(settings.business);
  // publicidade (painel → Anúncios): o aviso só aparece com os anúncios ligados
  const ads = adsDisclosure(settings.ads);
  return (
    <LegalPage
      title="Política de privacidade"
      updated={legalUpdated(settings.ads?.updatedAt)}
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
          {ads?.adsense && <li>Nas páginas com publicidade: dados técnicos do navegador (como endereço IP e cookies), coletados pelo Google.</li>}
        </ul>
        <p className="mt-3">
          Não pedimos nome, e-mail ou documento para traduzir. Os dados de pagamento ficam com o meio de pagamento: não vemos nem guardamos o número
          do cartão.
        </p>
      </section>
      <section>
        <h2>3. Para que usamos</h2>
        <p>
          Para fazer a tradução, mostrar o andamento, permitir a revisão e o download, e responder quando você nos procurar.{" "}
          {ads
            ? "Não vendemos seus dados. Algumas páginas mostram anúncios, sempre identificados como “Publicidade”."
            : "Não vendemos seus dados nem os usamos para publicidade."}
        </p>
      </section>
      <section>
        <h2>4. Com quem compartilhamos</h2>
        <p>
          Para traduzir, o texto do livro é enviado a provedores de inteligência artificial que contratamos. Alguns desses provedores, em seus planos
          gratuitos, podem usar o conteúdo recebido para melhorar os próprios serviços, conforme os termos deles. Quando os pagamentos estiverem
          ativos, o meio de pagamento recebe os dados necessários para processar a compra.
          {ads?.adsense && (
            <>
              {" "}
              Os anúncios são fornecidos pelo Google (AdSense), que pode receber dados técnicos do seu navegador (como endereço IP e cookies) para
              mostrar e medir anúncios, conforme{" "}
              <a href="https://policies.google.com/technologies/partner-sites" target="_blank" rel="noreferrer" className="link text-ink">
                como o Google usa dados de sites parceiros
              </a>
              .
            </>
          )}
          {ads?.house &&
            " Se um anúncio de patrocinador tiver imagem, ela é carregada do endereço do patrocinador, que recebe dados técnicos do seu navegador (como o endereço IP)."}
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
          {ads?.adsense ? "Os cookies do próprio site são só os necessários" : "Usamos apenas cookies necessários para o site funcionar"}: o
          identificador dos seus livros e, quando houver, o de acesso protegido por senha.
          {ads?.adsense
            ? " Nas páginas com publicidade, o Google também usa cookies (abaixo)."
            : " Não usamos cookies de publicidade nem de análise."}
        </p>
        {ads?.house && (
          <p className="mt-3">
            Os anúncios de patrocinadores não usam cookies do site. A imagem do anúncio, se houver, vem do endereço do patrocinador, e ao tocar num
            anúncio você vai para o site do anunciante: os dois têm a própria política.
          </p>
        )}
        {ads?.adsense && (
          <p className="mt-3">
            Nas páginas com publicidade, empresas de anúncios, incluindo o Google, usam cookies para mostrar anúncios. Pedimos ao Google só anúncios
            não personalizados: eles não se baseiam nas suas visitas anteriores a este ou a outros sites, mas os cookies ainda servem para limitar
            quantas vezes um anúncio aparece, medir resultados e combater fraudes. Você pode controlar os anúncios do Google em{" "}
            <a href="https://myadcenter.google.com" target="_blank" rel="noreferrer" className="link text-ink">
              myadcenter.google.com
            </a>
            , recusar cookies de outras empresas de anúncios em{" "}
            <a href="https://www.aboutads.info/choices/" target="_blank" rel="noreferrer" className="link text-ink">
              aboutads.info
            </a>{" "}
            e bloquear cookies de terceiros no seu navegador. Os anúncios nunca aparecem no pagamento, na leitura do seu livro nem nesta página.
          </p>
        )}
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
