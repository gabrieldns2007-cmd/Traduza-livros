# Economia de tokens

O que o Verso faz para gastar menos sem traduzir pior, e de onde vieram as ideias.

## O que já está no código

| Medida | Onde | Efeito |
|---|---|---|
| Pedidos grandes no Gemini (~24 mil caracteres, até 400 trechos) | `services/translation/index.ts` | instruções repetidas poucas vezes por livro; poesia (um verso por parágrafo) cabe em poucos pedidos |
| **Grupos de capítulos e lotes com a mesma conta** (texto + moldura `<seg id="N"></seg>` de ~21 caracteres por trecho, e o limite de trechos) | `job-runner.ts`, `chapter-processor.ts` | um grupo cabe num pedido só, sem um “pedacinho” que sobra para um pedido extra |
| Glossário só com os termos do trecho; 3 parágrafos anteriores; últimos 5 resumos | `chapter-processor.ts` | contexto pequeno e estável |
| Prompt de sistema fixo por livro (perfil + regras) no começo | `prompts.ts` | aproveita o cache automático do Gemini e da Anthropic |
| Nomes novos vêm junto da tradução (sem chamada extra) | `prompts.ts` | 0 pedidos extras por capítulo |
| Retomada: nada já traduzido é reenviado | `chapter-processor.ts` | sem tradução duplicada |
| **Resposta cortada:** trechos completos são aproveitados, só o resto volta | `chapter-processor.ts` | antes, o lote inteiro era pedido de novo em metades |
| **Erro temporário no meio do lote:** só o que falta é reenviado | `chapter-processor.ts` | antes, o lote inteiro voltava |
| **Resposta recusada** (filtro de citação ou de segurança do Gemini): o que veio completo fica; se ela parou antes do fim, o resto é dividido em dois no máximo 2 vezes (o capítulo do trecho em que ela parou vai separado dos seguintes); depois, uma nova tentativa e, se falhar, o trecho fica marcado | `chapter-processor.ts` | antes, tudo era jogado fora e dividido até 4 vezes |
| **Cota do dia acaba no meio do lote:** o que já voltou é gravado antes de parar, e os capítulos que ficaram completos são fechados | `chapter-processor.ts` | pedidos já gastos não se perdem; nada é traduzido duas vezes na retomada |
| **Quebras de verso:** se o modelo troca `<br_N/>` por quebras de linha e a contagem bate, elas voltam ao lugar, sem nova tentativa (também na nova tentativa, em vez de sumirem); uma regra no prompt pede para manter cada `<br_N/>` | `lib/markup.ts`, `prompts.ts` | menos pedidos e poemas com as quebras certas |
| **Leitura atenta** sem pedido extra para páginas curtas (menos de 300 palavras: dedicatória, epígrafe) e poemas com menos de 1.000 palavras; capítulos de prosa a partir de 300 palavras continuam com o resumo | `chapter-processor.ts` | um pedido a menos por poema ou página curta |
| **Análise do livro** que falha sem erro fatal: a próxima execução tenta de novo, uma vez só | `job-runner.ts` | o livro não fica para sempre sem perfil |
| **Trechos sem palavras** (`* * *`, números, marcas de nota) ficam como estão | `chapter-processor.ts` | nenhum token gasto com eles |
| **Trechos idênticos no mesmo lote** vão ao modelo uma vez | `chapter-processor.ts` | a mesma tradução para todos |
| **Raciocínio do Gemini ajustável** (`GEMINI_THINKING_LEVEL`, desligado por padrão) | `llm/gemini.ts` | o raciocínio é cobrado como saída; testar a qualidade antes de baixar |
| **Registro** de pedidos refeitos, pedidos recusados e trechos resolvidos sem chamada; o Gemini anota no log o motivo de uma recusa (só o código, ex.: `RECITATION`) | `BookMeta.runs`, `npm run custos`, `llm/gemini.ts` | a economia passa a ser medida, não estimada |

## Poesia na cota grátis (medido em teste)

Livro de teste como “Devotions”: 92 poemas, ~34 mil palavras, `tests/poetry-batching.test.ts`
(provedor falso, sem chamadas reais). Pedidos de tradução por livro inteiro:

| Caso | Antes | Agora |
|---|---|---|
| Um verso por parágrafo | 51 | 17 |
| Estrofes com `<br/>` | 17 | 13 |
| Recusa por citação em 1 poema a cada 12 (verso por parágrafo / estrofes) | 276 / 112 | 69 / 48 |
| Palavras salvas quando a cota acaba em 16 pedidos (verso por parágrafo) | 10.943 | 34.112 |
| Leitura atenta ligada (pedidos extras de análise) | 95 | 0 |

Custo da troca: com recusas num livro de um verso por parágrafo, mais versos do poema recusado
ficam marcados como falhos (312 contra 178 no teste), em vez de 4 vezes mais pedidos. Num pedido
de cliente, a revisão automática do fim pede esses trechos de novo.

O **GitHub Models** foi encerrado pelo GitHub em 30/07/2026: saiu da ordem padrão da tradução
Padrão e um token salvo nunca é usado. Os serviços gratuitos da tradução Grátis são o Gemini,
o Groq, a Cloudflare (Workers AI) e a Mistral (modo Free), em rodízio automático.

## Referências

- **BookTranslator.ai** (booktranslator.ai): EPUB → EPUB, cobra por 100 mil palavras
  (US$ 6,99 Basic / 9,99 Pro), preço exato antes de pagar, etapas
  Extrair → Analisar → Traduzir → Revisar → Remontar, perfil de tom e termos antes de traduzir.
  Não divulga modelos.
- **Translate A Book** (translateabook.com): orçamento exato no envio, prévia grátis, sem conta,
  “guia de tradução” editável (resumo, tom, personagens, termos), revisão automática e reenvio onde
  falhou; modos Standard / Pro / Author (este com análise do livro inteiro). Diz usar modelos do
  Google, OpenAI e DeepSeek por etapa e que nenhum provedor treina com o conteúdo.
- **Google, documentação oficial do Gemini:** raciocínio cobrado como saída; cache implícito para
  prefixos estáveis (mínimo de 4.096 tokens no 3.8 Flash); Batch API com 50% de desconto (só no pago).

## Próximas economias (dependem de decisão)

1. Medir os tokens reais (`npm run custos`) e o efeito de `GEMINI_THINKING_LEVEL=low` num trecho
   autorizado, no nível gratuito.
2. Comparar a qualidade do Gemini 3.5 Flash-Lite com o 3.8 Flash.
3. No nível pago: Batch API (metade do preço, entrega em até 24 h) para pedidos sem pressa.
