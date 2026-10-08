# Verso — produto e monetização

Este documento explica como o Verso ganha dinheiro sem estragar a experiência e sem
deixar ninguém gerar prejuízo. A arquitetura descrita aqui **já está no código**; os
pagamentos ainda **não** estão ligados, e nada é cobrado hoje.

> Os números de custo vêm da tabela de preços dos modelos (`lib/billing/prices.ts`)
> e de um modelo de consumo por palavra (`lib/billing/cost-model.ts`). São
> estimativas iniciais: a partir de agora, cada tradução grava o custo real
> (`BookMeta.runs`), e `npm run custos` mostra a margem verdadeira para recalibrar.

---

## 0. O que o cliente compra: a tradução de um livro

> Atualização: no servidor próprio (serviço comercial), o Verso vende **a tradução de
> um livro, com preço em reais**. Créditos e planos (seções 1 a 3) continuam no código
> como base interna e para a versão pública, mas não aparecem para o cliente.

**O cliente não compra IA.** Ele nunca vê qual serviço ou modelo traduziu, tokens,
custo do serviço, nem mensagens técnicas de erro — isso fica no painel
administrativo (`/admin`). A API também não envia esses dados ao navegador.

**Fluxo (sem tutorial, poucas etapas):**

1. **Página inicial** = página de venda: “Traduza seus livros.” / “Envie. Escolha o
   idioma. Receba seu livro traduzido.” e um único botão, **Traduzir meu livro**,
   que já abre o seletor de arquivo. Depois: como funciona, formatos, idiomas,
   estrutura preservada, EPUB/PDF, preço (com exemplos) e perguntas frequentes.
2. **Confirmar**: “Seu livro está pronto para tradução.” — título, idiomas (com
   “Alterar”), palavras e capítulos, o tipo de tradução com o preço, **Tradução
   completa: R$ X**, a lista **Incluído** (tradução, capítulos organizados,
   formatação preservada, EPUB, PDF, revisão, download) e o botão **Pagar e
   traduzir**. Amostra grátis e preferências são opcionais, abaixo do botão.
3. **Pagamento**: a página do meio de pagamento. Na volta, “Confirmando seu
   pagamento…” até o aviso do meio de pagamento chegar, e então **“Pagamento
   confirmado.” / “Estamos preparando sua tradução.”**
4. **Acompanhamento**: Livro → Processando → Traduzindo → Revisando → Pronto, com
   “Seu livro está sendo traduzido.”, o percentual, “Capítulo X de Y” e a barra. A
   pessoa pode fechar a página e voltar depois.
5. **Pronto**: “Seu livro está pronto.” com **Baixar EPUB** e **Baixar PDF**, e a
   revisão online.

A etapa **Revisando** é real (`markForReview` no job runner): ao fim da tradução de
um pedido, os trechos que falharam e os que voltaram iguais ao original são
traduzidos de novo, uma vez. Trechos editados à mão nunca são tocados.

**Venda sem pressão (sem dark patterns):** o preço aparece antes de qualquer
pagamento, o botão diz exatamente o que faz, não há contagem regressiva, urgência,
assinatura escondida nem taxa extra. Abaixo do botão: “Pagamento único, sem
assinatura e sem cobrança automática.” No beta, o botão é **Traduzir grátis** —
nunca “Pagar” quando nada é cobrado.

**Preço** (`lib/billing/pricing.ts`):

    preço = palavras ÷ 1000 × preço por mil  +  R$ 1,90 por pedido
            arredondado para cima em ,90 e nunca abaixo de R$ 9,90

| Tipo | Por mil palavras | Livro de 44.152 palavras |
| --- | --- | --- |
| Padrão — fluente e fiel | R$ 0,39 | R$ 19,90 |
| Literária — voz do autor, ritmo, imagens | R$ 1,49 | R$ 67,90 |

O R$ 1,90 por pedido cobre custos operacionais (tarifa fixa do pagamento,
armazenamento, suporte). `assertPricingProtectsMargin` (rodado nos testes) garante
que, para livros de 300 a 1 milhão de palavras, o preço líquido (sem taxa de
pagamento e impostos) cobre o **pior** custo de processamento daquele tipo de
tradução + o custo fixo, com a margem mínima.

**Pedido e pagamento** (`services/commerce/orders.ts`, `services/billing/payments.ts`):
ao tocar em “Pagar e traduzir”, o preço fica travado no pedido (`BookMeta.order`) e:

- `CHECKOUT_MODE=beta` (padrão): o pedido é confirmado como “beta” e a tradução
  começa — nada é cobrado;
- `CHECKOUT_MODE=live` + `PAYMENT_PROVIDER`: a pessoa vai para a página do meio de
  pagamento; a tradução só começa quando ele avisa o servidor
  (`POST /api/payments/webhook/<meio>` → `applyPaymentEvent`, produto
  `order:<livro>:<pedido>`). O retorno do navegador nunca vale como prova de
  pagamento; avisos repetidos são ignorados; aviso com valor menor que o preço não
  libera a tradução; reembolso fica registrado no pedido;
- `PAYMENT_PROVIDER=simulado`: um meio de pagamento **de teste**, dentro do próprio
  site, para ver a experiência completa sem dinheiro. Só o administrador aprova o
  pagamento simulado (quando `ADMIN_PASSWORD` está definida). Nunca deixe ligado
  com clientes de verdade;
- sem meio de pagamento implementado, a confirmação mostra “Pagamentos em breve”.

**Quem traduz** (`services/commerce/routing.ts`, editável no painel):

- Padrão: Gemini → GitHub Models → Groq (todos gratuitos). Se a cota de um acaba, a
  tradução passa sozinha para o próximo; se todos acabam, espera a cota voltar e
  continua sozinha (“Sua tradução está na fila”).
- A Padrão **nunca** usa um serviço pago, mesmo que ele seja colocado na lista.
- Literária: Anthropic. Só é vendida quando o administrador liga “Vender a tradução
  Literária” no painel — antes disso aparece como “Em breve”.

**Painel administrativo** (`/admin`, senha `ADMIN_PASSWORD`): pedidos, valor dos
pedidos (beta) ou receita, custo real (só serviços pagos) e quanto custaria pela
tabela, margem por livro, erros técnicos, histórico de execuções, ordem dos serviços
por tipo, tabela de preços com margem e as chaves dos serviços.

---

## 1. Estratégia recomendada: créditos + assinatura (híbrido)

| Modelo | A favor | Contra | Para o Verso |
| --- | --- | --- | --- |
| Anúncios | Grátis para quem lê | Destrói a sensação premium; receita baixíssima por usuário | Não |
| Só grátis com limite | Ótimo para atrair | Não paga a conta | Só como porta de entrada |
| Pagamento por livro | Simples de entender | Preço muda muito com o tamanho do livro | Sim, como **créditos avulsos** |
| Assinatura mensal | Receita previsível | Quem lê 1 livro a cada 3 meses não assina | Sim, para quem traduz sempre |
| Créditos | O preço acompanha o custo real (palavras × modelo) | Precisa explicar o que é um crédito | **Base de tudo** |
| Grátis + premium | Bom para recursos | O custo aqui é processamento, não recurso | Complementar |

**Escolha:** tudo é medido em **créditos** (1 crédito = 1.000 palavras na qualidade
Padrão). A pessoa pode **comprar créditos avulsos** (pagar por livro) ou **assinar**
um plano que dá créditos todo mês, mais baratos. Há um **plano Grátis** pequeno para
experimentar.

Por que funciona: o custo do Verso é proporcional a palavras traduzidas × preço do
modelo, e o crédito é exatamente essa unidade. O leitor ocasional paga por livro; o
frequente assina e paga menos por crédito. Ninguém vê anúncio.

## 2. Estrutura de planos

Definida em `lib/billing/catalog.ts` (planos, pacotes, qualidades e economia em um só lugar).

| | **Grátis** | **Plus** | **Pro** |
| --- | --- | --- | --- |
| Preço | R$ 0 | R$ 24,90/mês | R$ 59,90/mês |
| Créditos | 15 de boas-vindas + 5/mês | 100/mês (≈ 1 romance) | 300/mês (≈ 3 romances) |
| Preço por crédito | — | R$ 0,249 | R$ 0,200 |
| Qualidades | Padrão | Padrão, Refinada, Literária | Todas, inclusive Premium |
| Créditos acumulam | não | +1 mês | +2 meses |
| Prévias grátis/dia | 2 | 20 | 50 |
| Livros ao mesmo tempo | 1 | 1 | 3 |
| Fila | normal | normal | prioritária |

**Créditos avulsos** (sem assinatura, valem 12 meses): 50 por R$ 14,90 · 120 por
R$ 29,90 · 300 por R$ 64,90.

Para comparar: um romance de 80 mil palavras na qualidade Padrão usa 80 créditos,
cerca de R$ 20 avulso ou R$ 16 no Pro. O O.Translator cobra algo na mesma faixa
(US$ 0,13 por crédito, 1 crédito a cada 3.000 tokens).

## 3. Sistema de créditos

- **Unidade:** 1 crédito = 1.000 palavras de origem na qualidade Padrão. Internamente,
  os créditos são guardados em milésimos para cobrar **por palavra**, sem arredondar a
  cada lote.
- **Qualidades** (créditos por mil palavras): Padrão 1 (Gemini Flash-Lite, Claude Haiku
  5.5, modelos abertos), Refinada 2 (Gemini 3.8 Flash), Literária 6 (Claude Sonnet 5.5),
  Premium 12 (Claude Opus 5.5).
- **Antes de começar**, a tela mostra o livro, as palavras que faltam, os créditos
  estimados, a qualidade, o plano e o saldo. Se faltar saldo, aparece *“Você precisa de
  X créditos para traduzir este livro”*, com a opção **traduzir só o que os créditos
  cobrem** (continua depois do mesmo ponto) e **Comprar créditos**.
- **Carteira** (`services/billing/wallet.ts`): créditos ficam em lotes com validade
  (boas-vindas, mensais, pacotes) e o consumo usa primeiro o que vence antes. Toda
  tradução segue três passos:
  1. **reserva** dos créditos estimados antes de começar (ou só do saldo, no modo parcial);
  2. **captura** a cada lote traduzido, pelas palavras realmente salvas;
  3. **liberação** do que sobrou, quando termina ou pausa.
  Um lote só é enviado se a reserva cobre as palavras dele. Assim é impossível gastar
  além do que foi reservado.
- **O que nunca consome créditos:** traduzir com a **própria chave gratuita** (Gemini,
  Groq, GitHub). Nesse caso o custo é zero para o Verso. Também não consome a **prévia
  grátis**, que é limitada por dia.

## 4. Cálculo de custo e preço

**Custo estimado de uma tradução** (`lib/billing/cost-model.ts`):

```
entrada = palavras × 1,35 tokens  +  pedidos × (instruções + glossário + contexto)
saída   = palavras × 1,6 tokens × (1 + raciocínio do modelo)
custo   = (entrada × preço_entrada + saída × preço_saída) × (1 + refações)
```

São duas versões: o custo **esperado** e o **pior caso** (≈ percentil 90: muito
raciocínio e muitas refações). Por mil palavras:

| Modelo | Esperado | Pior caso |
| --- | --- | --- |
| Gemini 3.5 Flash-Lite | US$ 0,0071 | US$ 0,0122 |
| Gemini 3.8 Flash | US$ 0,0116 | US$ 0,0195 |
| GPT-OSS 120B (Groq) | US$ 0,0020 | US$ 0,0031 |
| Claude Haiku 5.5 | US$ 0,0020 | US$ 0,0037 |
| Claude Sonnet 5.5 | US$ 0,0401 | US$ 0,0732 |
| Claude Opus 5.5 | US$ 0,0801 | US$ 0,1464 |

**Preço = custo + margem.** O menor preço que um crédito pode ter:

```
preço × (1 − taxa do pagamento − impostos) × (1 − margem mínima)  ≥  pior custo do crédito
```

Hoje o cálculo usa: câmbio R$ 5,60 com folga de 10%, taxa de pagamento de 5%, impostos
de 10% e margem mínima de 50% **no pior caso**. O pior custo de um crédito é cerca de
R$ 0,075. O resultado é um piso de **R$ 0,177 por crédito**, e todos os planos e pacotes
ficam acima dele. Um teste automático (`tests/billing.test.ts`) **falha** se alguém
baixar um preço ou trocar um modelo e a margem deixar de existir.

Exemplo, *Devotions* (44.152 palavras):

- **Padrão:** 45 créditos. Custo esperado de US$ 0,31 (R$ 1,93), pior caso de US$ 0,54
  (R$ 3,32). No pacote de 120 créditos isso rende R$ 11,21 bruto (R$ 9,53 líquido), uma
  margem de 65% no pior caso e cerca de 80% no esperado.
- **Premium:** 530 créditos. Pior caso de US$ 6,46 (R$ 39,80) contra R$ 112 líquidos,
  uma margem de 64%.

> Os US$ 4 gastos nos primeiros 26% desse livro vieram da versão antiga, que fazia duas
> chamadas por capítulo, com capítulos minúsculos (poemas) e a leitura atenta ligada.
> A versão atual agrupa capítulos e não faz a chamada extra. Para os mesmos 11.549
> palavras, o modelo estima no máximo US$ 1,59 com o Opus 5.5. O registro por execução
> vai confirmar.

## 5. Arquitetura

```
lib/billing/prices.ts        preço de tabela de cada modelo (fonte e data)
lib/billing/cost-model.ts    tokens e custo estimados por palavra (esperado / pior caso)
lib/billing/catalog.ts       créditos, qualidades, planos, pacotes, economia e piso de preço
lib/billing/quote.ts         estimativa de um livro: palavras → créditos (+ custo)
lib/billing/mode.ts          BILLING_MODE = off | preview | enforce
services/billing/wallet.ts   carteira: lotes, reserva/captura/liberação, extrato, prévias
services/billing/run-ledger.ts  registro de cada execução + travas de créditos e de margem
services/billing/payments.ts interface PaymentProvider + aplicação idempotente de pagamentos
services/billing/account.ts  resumo da carteira para as telas
```

- **TranslationProvider** continua sendo a interface única para Gemini, Anthropic, Groq,
  GitHub, OpenAI-compatível e, no futuro, modelos locais. Cada serviço tem
  `billing: "byok" | "hosted" | "none"`, que diz **quem paga** o processamento.
- **Registro por execução** (`BookMeta.runs`), em todo início, continuação ou prévia:
  serviço, modelo, tokens de entrada e saída, custo estimado pela tabela, tempo de
  processamento, palavras, trechos, capítulos e créditos (valor, reservado, cobrado).
  O dono vê isso no fim da página do livro (“Custos desta tradução”) e em
  `npm run custos`, que também calcula a margem e quantos créditos por mil palavras
  cada modelo precisaria.
- **Modos** (`BILLING_MODE`):
  - `preview`, o **padrão**: mostra estimativas, planos e saldo, e registra o valor em
    créditos, mas **não desconta nem bloqueia nada**;
  - `enforce`: ativa a cobrança em créditos;
  - `off`: esconde tudo.

## 6. Como a margem é protegida

1. **Piso de preço verificado em teste:** nenhum plano ou pacote vende crédito abaixo do
   custo no pior caso com 50% de margem, já descontadas taxas e impostos.
2. **Reserva antes de começar:** sem créditos não começa. No modo parcial, traduz só
   até onde o saldo cobre.
3. **Conferência a cada lote:** o lote só sai se a reserva cobre as palavras dele.
4. **Cobrança por palavra salva:** nunca por tentativa. Refazer um lote não cobra duas
   vezes, e retomar não reenvia nada já traduzido.
5. **Trava de custo real:** se o custo medido de uma execução passar de 80% do valor
   líquido que ela cobrou, ou se o gasto disparar sem progresso, a tradução **pausa**.
6. **Qualidades por plano:** modelos caros só nos planos pagos. A regra é conferida na
   API e de novo no motor.
7. **Grátis controlado:** 15 créditos de boas-vindas (uma vez por conta) e 5 por mês,
   só na qualidade Padrão, e 2 prévias por dia. O pior custo por pessoa grátis é cerca
   de R$ 1,13 na entrada e R$ 0,38 por mês, mais até R$ 0,06 por dia de prévias
   (≈ R$ 1,90 por mês para quem usar todas, todos os dias).
8. **Serviços pagos com a chave do dono** (Anthropic) continuam exigindo confirmação
   explícita de custo e nunca recomeçam sozinhos.
9. **Chave própria** (byok) nunca passa pela carteira, porque o custo é zero para o Verso.

Contra abuso no plano Grátis: login com Google obrigatório na versão pública, boas-vindas
uma única vez por conta e limite diário de prévias. Quando houver servidor com banco de
dados, faltam limites por IP e por aparelho.

## 7. O que é gratuito

- Prévia grátis de qualquer livro (limite diário).
- 15 mil palavras de boas-vindas e 5 mil por mês na qualidade Padrão.
- Revisão e edição da tradução, glossário, EPUB válido para Kindle e PDF.
- Tradução ilimitada com a **própria chave gratuita** (Gemini, Groq, GitHub). Custa zero
  para o Verso e é ótima para quem entende de tecnologia. Recomendo manter: atrai essas
  pessoas sem custo e não concorre com quem quer conveniência.

## 8. O que é premium

- Mais créditos por mês, mais baratos por crédito (Plus e Pro).
- Qualidades **Refinada** e **Literária** (Plus) e **Premium** (Pro).
- Créditos que acumulam de um mês para o outro.
- Mais prévias por dia, até 3 livros ao mesmo tempo e fila prioritária (Pro).
- No futuro, sem custo novo de processamento: memória de tradução entre livros,
  glossários compartilhados em séries, exportação personalizada (capa, fonte) e
  equipes (pequenas editoras).

## 9. Como ligar os pagamentos depois

Para a venda por livro (seção 0), tudo já está pronto menos o meio de pagamento:

1. Abrir a conta no meio de pagamento (Mercado Pago é o mais simples no Brasil, com
   Pix; Stripe também aceita Pix). **Isso exige sua autorização — nada foi criado.**
2. Criar `services/billing/providers/mercadopago.ts` (ou `stripe.ts`) implementando
   `PaymentProvider` (`services/billing/payment-types.ts`):
   - `createCheckout` recebe produto, valor (`amountBrl`), descrição e as URLs de
     volta, e devolve o endereço da página de pagamento;
   - `parseWebhook` confere a assinatura do aviso e devolve um `PaymentEvent`.
3. Registrar em `paymentProvider()` (`services/billing/payments.ts`).
4. No meio de pagamento, cadastrar o webhook
   `https://SEU-SITE/api/payments/webhook/mercadopago` (essa rota não pede a senha
   do site; a autenticidade vem da assinatura).
5. Definir `PAYMENT_PROVIDER=mercadopago`, `CHECKOUT_MODE=live` e `SITE_URL`.
6. Testar antes com `PAYMENT_PROVIDER=simulado`, que percorre o mesmo caminho.

**Assinatura (no futuro, se fizer sentido):** a arquitetura já prevê produtos
recorrentes (`plan-plus`, `plan-pro`, `kind: "subscription"` no checkout e os eventos
`subscription.started/renewed/canceled`). Se um dia houver assinatura, ela precisa
aparecer com o preço mensal, a renovação automática e o cancelamento explicados
antes do pagamento.

Para créditos e planos (versão pública):

1. Escolher o meio de pagamento (Mercado Pago ou Stripe; Pix reduz a taxa).
2. Implementar `PaymentProvider` (`services/billing/payments.ts`):
   - `createCheckout` → a tela **Comprar** leva a pessoa para a página de pagamento;
   - `parseWebhook` → valida a assinatura do aviso do meio de pagamento.
3. Criar a rota do webhook, que chama `applyPaymentEvent`. Ela é idempotente pelo id do
   pagamento, então um aviso repetido nunca credita duas vezes. **Créditos só entram pelo
   webhook**, nunca pelo retorno do navegador.
4. Trocar “Em breve” por **Comprar/Assinar** em `/planos`.
5. Na **versão pública**, a carteira e as chaves pagas precisam estar no **servidor**:
   - hoje a versão pública guarda tudo no navegador, o que é certo para a chave da
     própria pessoa, mas créditos no navegador poderiam ser alterados;
   - o caminho é um **repasse com medição**: o motor continua no navegador, os pedidos
     ao modelo passam por uma rota do servidor;
   - essa rota confere o login do Google, reserva e cobra créditos num banco
     (ex.: Supabase/Postgres) e chama o modelo com a chave do Verso;
   - a lógica da carteira não muda, só o lugar onde ela é guardada (`WalletStore`).
6. Ligar `BILLING_MODE=enforce`.
7. Antes de vender: conferir impostos com um contador, publicar termos de uso e
   política de reembolso, e rodar `npm run custos` com traduções reais para confirmar
   os créditos por mil palavras.
