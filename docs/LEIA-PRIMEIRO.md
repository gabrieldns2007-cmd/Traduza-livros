# Leia primeiro: o que foi feito e o que falta você fazer

Última atualização: 27/11/2026. Todo o trabalho está na branch `claude/book-translation-webapp-qahww8`.

Nada foi publicado, nenhuma cobrança foi ativada e nenhum serviço pago foi chamado.
Nenhum livro, tradução ou capítulo foi apagado. "Devotions" continua no seu Codespace, como estava.

## 1. O que mudou no site

| Mudança | Por quê |
|---|---|
| **Painel fechado até existir senha.** Sem senha criada, `/admin` mostra só "Crie a senha do painel". | Antes, qualquer visitante podia abrir o painel, ver os livros de todo mundo e aprovar pagamentos de teste. |
| **Dono do livro conferido também com ID "disfarçado"** (ex.: `%61` no lugar de `a`). | Antes, dava para abrir o livro de outra pessoa trocando uma letra do endereço pelo código dela. |
| **Cliente não muda mais os ajustes da loja.** A página "Configurações" saiu do menu no seu servidor. | Antes, qualquer visitante podia trocar o idioma padrão e as instruções do tradutor de todos os clientes. |
| **Next.js 16.4.6 e zod 4.6.7.** | Correções de segurança publicadas (uma delas, crítica). |
| **Mistral só é usada depois de você confirmar no painel que a conta não tem cartão.** | A API da Mistral passou a exigir cobrança ativa. Sem a confirmação, a chave salva fica parada. |
| Texto cinza mais escuro no modo claro. | O contraste estava abaixo do mínimo de leitura (3,5:1 contra o mínimo de 4,5:1). |
| **Limite de envios:** 10 livros por hora por navegador, 30 por rede, e no máximo 15 livros parados sem pedido. O painel não tem limite. | Antes, qualquer um podia lotar a fila e o disco enviando livros sem parar. |
| Mensagens de erro em português ("Sem conexão com o servidor"), aviso certo para EPUB danificado ou com DRM, links do rodapé fáceis de tocar, motivos de parada legíveis no painel. | Itens da auditoria de design. |

Os testes automáticos (344) passam, assim como a checagem de tipos e o build.

## 2. O que só você pode fazer

1. **Mistral:** abra o console da Mistral e veja se há cartão ou forma de pagamento cadastrada.
   - Se **não** houver, marque no painel do Verso → Mistral → "Confirmo que a minha conta… não tem cartão".
   - Se houver, deixe desmarcado ou remova a chave.
2. **Chave do Google:** a chave do Gemini que apareceu numa conversa antiga deve ser trocada. No aistudio.google.com/apikey, apague a antiga e cole a nova no painel.
3. **Teste de tradução grátis:** envie um livro curto pelo site e acompanhe se ele termina.

## 3. Decisões que estão esperando você

- **Gemini nos livros de clientes.** Os termos do Gemini grátis proíbem enviar conteúdo confidencial e permitem que revisores humanos leiam o texto.
  - Recomendação: para clientes, pôr Cloudflare e Groq na frente (os dois não guardam o texto nem treinam com ele) e deixar o Gemini para os seus testes.
- **Modelo da Cloudflare.** Trocar o Llama 3.3 70B pelo GLM-4.7-Flash ou pelo Gemma 4 rende cerca de 5 vezes mais livros com a mesma cota grátis.
  - Antes, é preciso comparar a qualidade num trecho curto que você autorizar.
- **Plano do site** (proposto antes):
  1. Tirar do código o modo público e o sistema de créditos antigo (cerca de 3 mil linhas sem uso).
  2. Focar só em português do Brasil.
  3. Manter a Literária desligada até existir pagamento real.

## 4. Claude Code com OmniRoute (kit pronto)

O kit está em [`ferramentas/claude-code-omniroute/`](../ferramentas/claude-code-omniroute/README.md).

- **O que ele faz:** liga o Claude Code ao OmniRoute em qualquer Codespace, de qualquer projeto. A troca automática segue esta ordem: Gemini 3.8 Flash → Z.AI GLM-4.7-Flash → Gemini 3.1 Flash-Lite → OpenRouter grátis.
- **O que foi testado:** o kit foi testado com o Claude Code de verdade e um provedor de mentira.
  - O OmniRoute liga sozinho e o combo troca de modelo quando a cota acaba.
  - Nada é duplicado.
  - `omniroute-desligar` volta o `settings.json` ao original, idêntico.

**Para usar em todos os Codespaces (pelo celular):**
1. Em github.com/new, crie um repositório chamado `dotfiles` (Private, vazio) e copie para ele o conteúdo de `ferramentas/claude-code-omniroute/`.
   - Eu não tive permissão para criar repositórios na sua conta.
2. Em **Settings → Codespaces → Codespaces secrets**, crie `GEMINI_API_KEY`. Se quiser mais opções no combo, crie também `ZAI_API_KEY` e `OPENROUTER_API_KEY`. Em "Repository access", marque os seus repositórios.
3. Ainda em **Settings → Codespaces → Dotfiles**, ligue "Automatically install dotfiles" e escolha `dotfiles`.

**Para usar só no Codespace do Verso, agora:** abra o terminal e rode `bash ferramentas/claude-code-omniroute/install.sh --dry-run`. Ele só mostra o que faria. Para aplicar de verdade, rode o mesmo comando sem `--dry-run`.

**Limites:**
- Os modelos grátis são bem mais fracos que o Claude. Para usar o Claude normal: `claude-original`.
- Cada Codespace conta as cotas separadamente.
- Não existe hospedagem grátis, sem cartão e ligada o tempo todo que aguente o OmniRoute: ele usa cerca de 600 MB de memória.

**Inventário dos provedores grátis:** os "1,62 bilhão de tokens por mês" do catálogo do OmniRoute estavam errados. O próprio projeto corrigiu para cerca de 90 milhões. Os que valem a pena, legítimos e oficiais:

| Provedor | Para os livros dos clientes | Para o Claude Code |
|---|---|---|
| Cloudflare | Melhor opção | Fica para o Verso |
| Groq | Bom | Limite curto demais |
| Z.AI (GLM-4.7-Flash) | Possível | Bom |
| Gemini | Evitar (termos) | Bom |
| OpenRouter grátis | Evitar | Reserva |

Revendas, logins de assinatura (Claude Pro, ChatGPT, Gemini CLI) e os 16 provedores que o próprio OmniRoute marca como "evitar" ficaram de fora: os termos proíbem ou não são seguros.
