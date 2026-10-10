# Economia de tokens

O que o Verso faz para gastar menos sem traduzir pior, e de onde vieram as ideias.

## O que já está no código

| Medida | Onde | Efeito |
|---|---|---|
| Pedidos grandes no Gemini (~24 mil caracteres) | `services/translation/index.ts` | instruções repetidas poucas vezes por livro |
| Glossário só com os termos do trecho; 3 parágrafos anteriores; últimos 5 resumos | `chapter-processor.ts` | contexto pequeno e estável |
| Prompt de sistema fixo por livro (perfil + regras) no começo | `prompts.ts` | aproveita o cache automático do Gemini e da Anthropic |
| Nomes novos vêm junto da tradução (sem chamada extra) | `prompts.ts` | 0 pedidos extras por capítulo |
| Retomada: nada já traduzido é reenviado | `chapter-processor.ts` | sem tradução duplicada |
| **Resposta cortada:** trechos completos são aproveitados, só o resto volta | `chapter-processor.ts` | antes, o lote inteiro era pedido de novo em metades |
| **Erro temporário no meio do lote:** só o que falta é reenviado | `chapter-processor.ts` | antes, o lote inteiro voltava |
| **Trechos sem palavras** (`* * *`, números, marcas de nota) ficam como estão | `chapter-processor.ts` | nenhum token gasto com eles |
| **Trechos idênticos no mesmo lote** vão ao modelo uma vez | `chapter-processor.ts` | a mesma tradução para todos |
| **Raciocínio do Gemini ajustável** (`GEMINI_THINKING_LEVEL`, desligado por padrão) | `llm/gemini.ts` | o raciocínio é cobrado como saída; testar a qualidade antes de baixar |
| **Registro** de pedidos refeitos e trechos resolvidos sem chamada | `BookMeta.runs`, `npm run custos` | a economia passa a ser medida, não estimada |

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
