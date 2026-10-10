# Verso.

Traduza livros inteiros — capítulo por capítulo — preservando a estrutura, e baixe o resultado em **EPUB** (pronto para Kindle, Kobo, Apple Books) e **PDF** (com layout de livro).

Feito para uso pessoal, principalmente pelo celular. Sem contas, sem banco de dados: um servidor Node e uma pasta de arquivos.

---

## Começando

```bash
npm install
cp .env.example .env.local   # coloque sua ANTHROPIC_API_KEY
npm run dev                  # http://localhost:3000
```

Sem chave configurada, o app roda em **modo demonstração**: todo o fluxo funciona (envio, progresso, revisão, exportação), mas o texto é copiado sem tradução.

### Usar pelo celular

O servidor já escuta em todas as interfaces (`-H 0.0.0.0`). Na mesma rede Wi-Fi, abra `http://IP-DO-COMPUTADOR:3000` no celular. No Safari/Chrome, use **Adicionar à tela de início** — o Verso abre como um app.

Para usar fora de casa, rode em um servidor (VPS, Railway, Fly.io, Render…) com um volume persistente e **defina `APP_PASSWORD`**.

### Atualizar (GitHub Codespaces, pelo celular)

Uma vez só, no terminal:

```bash
git stash; git pull origin claude/book-translation-webapp-qahww8 && npm run atualizar
```

Depois, sempre que houver novidade: `npm run atualizar` (ou menu ☰ → Terminal → Run Task… → **Verso: 1. atualizar e abrir o site**). Ele guarda alterações locais, baixa a versão nova, instala o que faltar e reabre o site. Os livros (`data/`) e o `.env.local` nunca são tocados.

### Vender traduções (serviço comercial)

O cliente compra **a tradução de um livro**, não “IA”: ele nunca vê qual serviço de IA traduz, tokens ou custos.

**Página inicial** (botão _Traduzir meu livro_) → **Confirmar** (idioma, tipo de tradução, preço e o que está incluído) → **Pagar e traduzir** → “Pagamento confirmado.” → **Acompanhamento** (Livro → Processando → Traduzindo → Revisando → Pronto) → **Baixar** EPUB e PDF.

- **Preços** (`/precos`): Padrão R$ 8,90 + R$ 0,10 por mil palavras (livro de 210 mil palavras = R$ 29,90); Literária R$ 1,90 + R$ 1,49 por mil palavras; mínimo R$ 9,90. Conta em `lib/billing/pricing.ts`; um teste impede preços abaixo da margem mínima.
- **Painel** (`/admin`): no primeiro acesso, ele pede para criar a senha (guardada só como hash; ou use `ADMIN_PASSWORD`). Mostra pedidos, status do pagamento, serviço e modelo, tokens, custo estimado e real, preço, lucro e margem e erros técnicos. Ali você também escolhe a ordem dos serviços de IA, as chaves, como o cliente paga e seus dados de contato.
- **Pagamentos:** nenhum meio de pagamento real está ligado. No painel → Vendas: **Beta** (grátis para o cliente, o padrão) ou **Teste de pagamento** (página de pagamento simulada, sem dinheiro, que só você aprova). Veja `docs/monetizacao.md`.
- **Privacidade entre clientes:** não há contas; cada navegador recebe um identificador aleatório e só vê os livros que enviou. O painel vê todos.
- **Termos de uso** (`/termos`) e **Política de privacidade** (`/privacidade`), com o nome e o e-mail informados no painel. Peça para um advogado revisar antes de cobrar.

### Produção

```bash
npm run build
npm start                    # ou: node .next/standalone/server.js
```

Docker:

```bash
docker build -t verso .
docker run -p 3000:3000 -v verso-data:/data --env-file .env.local verso
```

> Plataformas serverless (Vercel, Netlify) não são adequadas: a tradução de um livro roda por dezenas de minutos em segundo plano e os arquivos ficam em disco.

### Testes

```bash
npm test          # segmentação, marcação, pipeline completo, exportações
npm run typecheck
```

---

## Como funciona

### 1. Arquitetura e pastas

```
app/                    páginas (App Router) e rotas da API
  page.tsx              “Traduza seu livro.” — envio e idiomas
  livros/               Meus livros · progresso · pronto · revisão
  configuracoes/        provedor, padrões, privacidade
  api/books/…           envio, tradução, capítulos, glossário, exportação
components/             interface (home, book, review, library, ui)
lib/                    configuração, armazenamento, marcação, idiomas, auth
services/
  parsing/              leitura do EPUB, segmentação, capítulos, PDF → EPUB
  translation/          TranslationProvider + provedores + prompts
  glossary/             memória de nomes e termos
  processing/           tradução por capítulo + fila em segundo plano
  reconstruction/       devolve a tradução ao XHTML original
  export/               EPUB, PDF (compositor tipográfico próprio), hifenização
types/                  modelo de dados
utils/                  XML, texto, concorrência
tests/                  testes (Vitest)
```

O servidor Next.js faz tudo: interface, API e a fila de tradução (que roda no próprio processo Node). Chaves de API ficam só no servidor (`.env.local`).

### 2. Leitura do EPUB

`META-INF/container.xml` → pacote OPF → metadados, manifest, **spine** (ordem de leitura), sumário (**nav** do EPUB 3 ou **NCX** do EPUB 2) e capa. Usa **JSZip** para o pacote e **cheerio** (modo XML) para o XHTML, com tolerância a arquivos imperfeitos (entidades HTML, `&` soltos, encodings antigos, HTML não-XHTML). Há proteção contra “zip bombs”.

Cada arquivo XHTML é **segmentado**: parágrafos, títulos, itens de lista, citações e células viram *segmentos*. No XHTML, o conteúdo de cada segmento é trocado por um marcador `<!--tl:N-->` — esse é o **esqueleto** do capítulo. Tudo que não é texto (CSS, ids, links, imagens, classes) fica intacto no esqueleto.

Dentro de cada segmento, as tags inline viram marcadores numerados:

```
Ele disse <em_3>baixinho</em_3>:<br_4/> — Venha.
```

O número aponta para a tag original (com todos os atributos). O modelo vê pouco ruído, e a reconstrução devolve exatamente a formatação original.

**Capítulos** são definidos pelo sumário. Se várias entradas apontam para âncoras dentro do mesmo arquivo (comum em livros do Projeto Gutenberg), o arquivo é dividido nesses pontos — assim “Capítulo 5” é mesmo o capítulo 5.

### 3. PDF de entrada

PDFs não têm parágrafos, só texto posicionado. Com o **pdf.js** (via `unpdf`) o Verso reconstrói a estrutura: agrupa em linhas, remove cabeçalhos/rodapés repetidos e números de página, mede corpo de texto, margem e entrelinha, junta linhas em parágrafos (recuo, espaço extra, linha curta), desfaz hifenização de fim de linha, detecta títulos (tamanho maior ou “Capítulo X”) e recupera **itálico/negrito** pelo nome das fontes. O resultado vira um EPUB simples que segue exatamente o mesmo fluxo. PDFs digitalizados (só imagem) são recusados com uma mensagem clara.

### 4. Como a tradução é dividida

```
livro → análise do livro (perfil, glossário inicial, título e sumário traduzidos)
      → capítulos (2 em paralelo, configurável)
          → análise do capítulo (resumo + novos nomes/termos)
          → lotes de ~5.000 caracteres, sem cortar parágrafos
          → tradução → validação das tags → gravação imediata
      → reconstrução → EPUB / PDF
```

Validação: cada lote volta como `<seg id="N">…</seg>`. Segmentos faltando ou com tags perdidas são refeitos numa segunda tentativa mais estrita; respostas cortadas ou recusadas fazem o lote ser dividido ao meio. Trechos que mesmo assim falham ficam no original e podem ser refeitos depois (“Tentar novamente”). Erros de rede/limite de uso são repetidos com espera; chave inválida ou falta de créditos param a tradução com uma mensagem clara.

### 5. Contexto entre capítulos

Cada pedido de tradução recebe:

- **perfil do livro** (gênero, tom, narrador, estilo) no prompt de sistema — estável durante o livro todo (aproveita cache);
- **resumos dos capítulos anteriores** (“a história até aqui”);
- **resumo do capítulo atual**;
- **os últimos parágrafos já traduzidos**, para continuidade de voz e de tratamento (você/tu, formal/informal);
- **glossário relevante** para aquele trecho.

### 6. Glossário

Começa com os nomes da análise inicial e cresce a cada capítulo analisado. Em cada lote vão só as entradas que aparecem no trecho (pelo nome completo ou por um sobrenome, por exemplo). Você pode corrigir qualquer termo na página do livro — vale para os próximos trechos — e entradas editadas por você nunca são sobrescritas.

### 7. TranslationProvider

```ts
interface TranslationProvider {
  analyzeBook(input): Promise<BookAnalysis>;
  analyzeChapter(input): Promise<ChapterAnalysis>;
  translateBatch(input): Promise<BatchOutput>;
}
```

Implementações: **Claude** (SDK oficial da Anthropic, com streaming, cache de prompt e *fallback* automático no servidor quando um classificador recusa um trecho de ficção), **OpenAI ou compatível** (OpenRouter, DeepSeek, Groq, Ollama, LM Studio…) e **demonstração**. Trocar de provedor ou modelo é só mudar o `.env.local`; um serviço que não é LLM (ex.: DeepL) pode implementar a mesma interface.

### 8. Reconstrução do EPUB

Parte do EPUB de origem e troca apenas o que mudou: o texto (marcadores do esqueleto → tradução com as tags originais), os rótulos do sumário (nav e NCX), idioma (`dc:language`, `xml:lang`), título e `dcterms:modified`. O pacote é remontado com `mimetype` como primeira entrada, sem compressão. Os EPUBs gerados nos testes passam no **EPUBCheck** (validador oficial do W3C) sem erros nem avisos.

### 9. Geração do PDF

**pdfkit** com a fonte **Newsreader** embutida, formato 5,5 × 8,5 pol. O pdfkit justifica mal linhas que misturam itálico e romano, então o Verso tem um **compositor próprio**: mede cada palavra na fonte certa, quebra linhas usando hifenização do idioma de destino (padrões TeX via `hyphen`), distribui o espaço e evita linhas órfãs. Inclui capa, folha de rosto, sumário com números de página, aberturas de capítulo, cabeçalhos correntes e numeração. Para alfabetos que a Newsreader não cobre, usa DejaVu ou a fonte definida em `PDF_FONT_REGULAR`.

### 10. Progresso

A fila grava o progresso em disco a cada lote. A página do livro consulta a API a cada 1,5 s: porcentagem por palavras, tempo restante estimado pelo ritmo medido, capítulo em andamento, lista de capítulos (✓ ● ○) e o glossário crescendo ao vivo. Pode fechar o navegador — a tradução continua no servidor, e se o servidor reiniciar, ela retoma de onde parou. Dá para pausar e continuar.

---

## Tradução gratuita com Gemini

O provedor padrão é o **Gemini Free** (Google AI Studio), sem cartão e sem billing:

1. Crie uma chave em [aistudio.google.com/apikey](https://aistudio.google.com/apikey) → **Create API key**.
2. No Verso, abra **Ajustes**, cole a chave em “Chave da API” e toque em **Salvar e testar**. (Ou defina `GEMINI_API_KEY` no ambiente.)
3. Escolha o modelo: **Gemini 3.8 Flash** (melhor qualidade, poucos pedidos por dia) ou **Gemini 3.5 Flash-Lite** (mais pedidos por dia).

Para caber no limite diário gratuito, o Verso manda trechos grandes por pedido — vários capítulos pequenos vão juntos — e extrai os nomes do glossário na mesma resposta. Quando o limite gratuito acaba, a tradução **pausa** (“Limite gratuito atingido…”) e continua do mesmo ponto quando a cota volta. No nível gratuito, o Google pode usar o texto enviado para melhorar os produtos dele.

### Outros serviços gratuitos (sem cartão)

Cada serviço tem a própria cota diária. Quando a de um acaba, a tradução pausa e você pode continuar com outro — sempre por escolha sua; nunca há troca automática, e nunca para um serviço pago.

- **GitHub Models** — usa a sua conta do GitHub. Crie um token em [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new) com a permissão **Models: Read-only** e cole em Ajustes (ou `GITHUB_MODELS_TOKEN`). Modelos GPT-4.1 / GPT-4.1 mini; pedidos menores (limite de ~8 mil tokens por pedido no nível gratuito). O token automático do Codespaces não é usado.
- **Groq** — crie uma chave em [console.groq.com/keys](https://console.groq.com/keys) e cole em Ajustes (ou `GROQ_API_KEY`). Modelos Llama 3.3 70B / GPT-OSS 120B; o limite é de texto por dia.

Os **créditos grátis de hoje** (Ajustes e escolha do serviço no livro) mostram quantos pedidos já foram usados em cada serviço e, quando a cota acaba, a hora em que ela volta. Os limites oficiais mudam; quando o serviço não informa o restante, o número é uma estimativa.

### Prévia grátis

Antes de traduzir o livro todo, **Ver prévia grátis** traduz só um trecho do começo do primeiro capítulo de verdade (pulando capa, sumário e direitos autorais), num único pedido, e mostra original e tradução lado a lado. O trecho fica salvo e não é traduzido de novo depois.

**Regras de custo:** o Verso nunca liga billing, nunca troca de provedor sozinho e nunca usa um provedor pago sem você escolher e confirmar (“Esta tradução pode gerar custos”, com estimativa). Traduções com provedor pago não recomeçam sozinhas depois de reiniciar o servidor.

## Versão pública (qualquer pessoa, de graça)

Com `NEXT_PUBLIC_VERSO_MODE=public`, o Verso vira um site aberto: cada pessoa entra com o **Google**, cola a **própria chave gratuita** (Gemini, Groq ou GitHub Models) e os livros ficam **no navegador dela** (IndexedDB). O servidor só entrega as páginas — não guarda livros nem chaves e não gasta a cota de ninguém.

Como funciona por dentro:

- O mesmo código das rotas `app/api` roda no navegador. `public/verso-sw.js` (service worker) encaminha cada pedido `/api/…` para a aba aberta, que responde com `lib/browser/backend.ts`.
- `lib/browser/fs.ts` imita `node:fs` sobre o IndexedDB e `next.config.ts` (`turbopack.resolveAlias`, condição `browser`) troca os módulos do Node — por isso armazenamento, retomada, prévia, glossário e exportação EPUB/PDF são os mesmos do servidor.
- Só uma aba por vez traduz (Web Locks); as outras usam a dela. Se a página for fechada, a tradução continua de onde parou quando a pessoa volta.
- Gemini e Groq são chamados direto do navegador; o GitHub Models passa por `/api/relay/github`, um repasse sem estado (a chave vem a cada pedido e não é guardada).
- Login: botão “Continuar com o Google” (Google Identity Services). Só precisa do **Client ID** público; não há segredo no servidor. A conta separa os livros de cada pessoa no mesmo aparelho; “Minha conta” mostra os créditos grátis do dia, os livros e permite sair ou apagar os dados do aparelho.

### Publicar no Vercel (gratuito, sem cartão)

1. Entre em [vercel.com](https://vercel.com) com a conta do GitHub (plano **Hobby**, gratuito, uso não comercial).
2. **Add New → Project** → importe este repositório.
3. Em **Environment Variables**, adicione `NEXT_PUBLIC_VERSO_MODE` = `public` e toque em **Deploy**. Anote o endereço gerado (ex.: `https://verso-xxxx.vercel.app`).
4. No [Google Cloud Console](https://console.cloud.google.com/), crie um projeto (gratuito, sem cartão) → **Google Auth Platform**: preencha a marca (nome “Verso”, e-mail), público **Externo** e **publique o app**. Em **Clientes → Criar cliente**, escolha **Aplicativo da Web** e em **Origens JavaScript autorizadas** cole o endereço do passo 3. Copie o **Client ID**.
5. De volta ao Vercel: **Settings → Environment Variables** → `NEXT_PUBLIC_GOOGLE_CLIENT_ID` = Client ID → **Deployments → Redeploy**.

Para testar sem Google (só em desenvolvimento), `NEXT_PUBLIC_VERSO_TEST_LOGIN=1` mostra “Entrar como visitante (teste)” e o serviço de demonstração.

## Produto e monetização

Créditos (1 crédito = 1.000 palavras na qualidade Padrão), planos Grátis/Plus/Pro, créditos avulsos, custo real registrado por tradução e proteção de margem. Nada é cobrado enquanto `BILLING_MODE` não for `enforce`, e não há meio de pagamento ligado. Estratégia, números e próximos passos: [docs/monetizacao.md](docs/monetizacao.md). Página pública: `/planos`.

```bash
npm run custos                       # custo real e margem de cada tradução
npm run creditos                     # saldo da carteira (servidor próprio)
npm run creditos -- adicionar 100    # crédito manual (testes, enquanto não há pagamentos)
```

## Rodando no GitHub Codespaces

`npm run dev` compila cada página na primeira vez que ela é aberta, o que pode demorar. Para uso diário, rode `npm run app` (prepara uma versão rápida e inicia). Depois abra a aba **Ports** → porta **3000** → ícone de globo.

## Pausas, créditos e retomada

O progresso é gravado em disco a cada lote traduzido (e o capítulo é marcado como concluído assim que termina). Se a conta do provedor ficar sem créditos, a tradução **pausa** com uma mensagem clara — nada é apagado. Depois de adicionar créditos, toque em **Continuar tradução**: o Verso confere nos arquivos o que já está traduzido, pula os capítulos concluídos, continua o capítulo interrompido a partir do trecho onde parou e mantém glossário, perfil e resumos.

Para conferir, sem alterar nada, o que está salvo e de onde a tradução continua:

```bash
npm run status
```

## Armazenamento

```
data/
  settings.json
  books/<id>/
    book.json            metadados, capítulos, progresso
    source.epub          EPUB de origem (ou gerado do PDF)
    original.pdf         se o envio foi um PDF
    docs/<d>.json        segmentos: origem + tradução
    skeletons/<d>.xhtml  esqueletos
    glossary.json
    exports/             EPUB/PDF gerados (cache)
```

Backup = copiar a pasta. Apagar um livro = apagar a pasta dele (ou usar “Excluir livro”).

## Segurança e privacidade

- Chaves de API só no servidor (variáveis de ambiente); nada sensível vai para o navegador.
- `APP_PASSWORD` protege todas as páginas e rotas (cookie assinado com HMAC, limite de tentativas).
- A senha do painel (criada no próprio painel, ou `ADMIN_PASSWORD`) protege `/admin` e `/api/admin/*`. No servidor, o cliente não consegue escolher o serviço de IA nem começar uma tradução sem pedido (a API recusa).
- Envios validados por extensão, assinatura do arquivo e tamanho (`MAX_UPLOAD_MB`); pacotes com descompressão excessiva são recusados.
- Conteúdo do livro nunca é executado: a interface mostra o texto com HTML reconstruído só com tags seguras e sem atributos; imagens são servidas com `Content-Security-Policy: sandbox` e `nosniff`.
- O texto vai ao provedor de IA apenas para ser traduzido.

## Kindle

O EPUB exportado é compatível com o Kindle. Envie pelo app Kindle no celular (Compartilhar → Kindle), em [amazon.com/sendtokindle](https://www.amazon.com/sendtokindle) ou por e-mail para o endereço do seu Kindle. Não há envio automático.

## Custos

Com `claude-opus-5-5`, um romance de ~80 mil palavras custa na ordem de alguns dólares (texto do livro + contexto + análise). `claude-sonnet-5-5` reduz o custo pela metade; a “leitura atenta de cada capítulo” pode ser desligada para economizar. O consumo de tokens aparece no rodapé da página de cada livro.

## Limitações conhecidas

- PDFs com layout complexo (colunas, notas laterais, tabelas) podem ter parágrafos imperfeitos — EPUB é sempre o melhor ponto de partida.
- EPUBs com DRM não podem ser lidos.
- Texto dentro de imagens não é traduzido; textos alternativos (`alt`) também ficam no original.
- Idiomas escritos da direita para a esquerda ainda não estão na lista de destino.
