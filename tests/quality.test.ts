/**
 * Qualidade quando o modelo muda no meio do livro.
 *
 * Cada trecho é conferido antes de ser gravado (lib/quality.ts): o que voltou sem
 * traduzir, em outro idioma, com pedaços do pedido ou com comentários vai numa
 * única nova tentativa com o motivo; o que é legítimo (versos curtos, títulos,
 * nomes, texto que já estava em português) passa sem custo extra. A resposta é
 * lida de forma tolerante (entrada repetida, </seg> esquecido, <think>), e cada
 * trecho guarda quem o traduziu.
 */
import { describe, expect, it } from "vitest";
import { writeEpub } from "@/services/export/epub-writer";
import { importBook } from "@/services/parsing/import-book";
import { store } from "@/lib/storage";
import { repairMarkup, restoreLineBreaks, tagKeys } from "@/lib/markup";
import { checkSegment, repeatedOutputs, stripStrayTags, type QualityContext } from "@/lib/quality";
import { mentions, relevantEntries } from "@/services/glossary/glossary";
import { BRIDGE_PARAGRAPHS, bridgeChars, processChapters, translateRange } from "@/services/processing/chapter-processor";
import { createProvider } from "@/services/translation";
import { LLMTranslationProvider, looksLikeRefusal } from "@/services/translation/llm-provider";
import {
  bookAnalysisPrompt,
  parseNewTerms,
  parseSegments,
  stripReasoning,
  translationSystemPrompt,
  translationUserPrompt,
} from "@/services/translation/prompts";
import { ProviderError, type LLMClient, type LLMRequest, type LLMResponse } from "@/services/translation/llm/types";
import type { BatchInput, BatchOutput, BookContext, TranslationProvider } from "@/services/translation/translation-provider";
import type { BookMeta, ChapterMeta, GlossaryEntry, InlineTag } from "@/types/book";

const EN_PT: QualityContext = { sourceLang: "en", targetLang: "pt-BR" };
const ok = (src: string, out: string, ctx = EN_PT) => checkSegment(src, out, ctx).hard;

/* ---------- conferência de um trecho ---------- */

describe("conferência de um trecho: o que é legítimo passa", () => {
  const cases: [string, string, string][] = [
    ["frase curta", "He nodded.", "Ele assentiu."],
    ["resposta de uma palavra", "Yes.", "Sim."],
    ["interjeição", "O!", "Ó!"],
    ["“Okay.”", "Okay.", "Ok."],
    ["detector confuso em texto curto", "Hmm, I see.", "Hum, entendo."],
    ["verso curto", "And the night fell on the sea", "e a noite caía sobre o mar"],
    ["verso com quebra", "The heron rises<br_3/>from the dark pond", "A garça se ergue<br_3/>do lago escuro"],
    ["título", "Chapter One", "Capítulo Um"],
    ["título em maiúsculas", "CHAPTER XII", "CAPÍTULO XII"],
    ["título que fica igual", "THE GREAT GATSBY", "THE GREAT GATSBY"],
    ["nomes e endereço iguais", "Sherlock Holmes, Baker Street, 221B, London.", "Sherlock Holmes, Baker Street, 221B, London."],
    ["número no título", "Chapter 3", "Capítulo 3"],
    ["tratamento", "Mr. Darcy!", "Sr. Darcy!"],
    ["diálogo com travessão", "“Are you coming?” asked Captain Reyes.", "— Você vem? — perguntou o Capitão Reyes."],
    [
      "prosa longa",
      "Mrs. Wilson stood up, smiling, and walked to the window of the little flat on 158th Street.",
      "A Sra. Wilson levantou-se, sorrindo, e foi até a janela do pequeno apartamento na Rua 158.",
    ],
    [
      "francês que o autor deixou sem traduzir",
      "“Bonjour, monsieur,” said the waiter in French, bowing low before the table by the window.",
      "— Bonjour, monsieur — disse o garçom em francês, curvando-se diante da mesa junto à janela.",
    ],
    [
      "frase inteira em francês, mantida",
      "“Je ne sais pas ce que vous voulez dire, monsieur,” she said.",
      "— Je ne sais pas ce que vous voulez dire, monsieur — disse ela.",
    ],
    ["citação em latim igual", "Dulce et decorum est pro patria mori.", "Dulce et decorum est pro patria mori."],
    [
      "trecho que já estava em português",
      "Obrigado, meu senhor, pela ajuda que o senhor me deu ontem à noite.",
      "Obrigado, meu senhor, pela ajuda que o senhor me deu ontem à noite.",
    ],
    ["registro bibliográfico", "ISBN 9780399563249 (hardcover)", "ISBN 9780399563249 (capa dura)"],
    [
      "título de obra que fica em inglês",
      "The Collected Poems of William Carlos Williams, Volume I: 1909–1939. New Directions, 1986.",
      "The Collected Poems of William Carlos Williams, volume I: 1909–1939. Nova York: New Directions, 1986.",
    ],
    ["nota de rodapé", "<sup_4>1</sup_4> A note about the lighthouse.", "<sup_4>1</sup_4> Uma nota sobre o farol."],
    ["nota do próprio autor", "(Note: this chapter was written in 1920.)", "(Nota: este capítulo foi escrito em 1920.)"],
    [
      "título de música mantido",
      "She hummed Yesterday by the Beatles while she cooked dinner for the children.",
      "Ela cantarolava Yesterday, dos Beatles, enquanto preparava o jantar das crianças.",
    ],
    ["nome em cirílico mantido", "He wrote Москва on the blackboard.", "Ele escreveu Москва no quadro-negro."],
    ["tratamento solene", "Thou art my shepherd; I shall not want.", "Tu és o meu pastor; nada me faltará."],
    ["fala de desculpas que está no original", "“I'm sorry, I can't help you,” she said.", "— Desculpe, não posso ajudar você — disse ela."],
    ["“aqui está” que está no original", "“Here is the translation you asked for,” he said.", "— Aqui está a tradução que você pediu — disse ele."],
    // “sinto muito”, “lamento”, “desculpe” sem falar da tarefa: frases do livro
    ["“sinto muito frio”", "I'm so cold, but I can't move my legs.", "Sinto muito frio, mas não consigo mexer as pernas."],
    ["“sinto muito a falta dela”", "I miss her terribly, but I cannot tell anyone.", "Sinto muito a falta dela, mas não posso contar a ninguém."],
    ["“lamento a morte dele”", "I mourn his death, but I cannot weep.", "Lamento a morte dele, mas não consigo chorar."],
    [
      "“lamento, mas não posso aceitar”",
      "I regret that I cannot accept your kind invitation for Thursday.",
      "Lamento, mas não posso aceitar seu gentil convite para quinta-feira.",
    ],
    ["“desculpe, não consigo”", "Excuse me, I can't hear you over the wind.", "Desculpe, não consigo ouvir você com esse vento."],
    ["“sinto muito, Dave”", "I'm afraid I can't do that, Dave.", "Sinto muito, Dave, mas não posso fazer isso."],
    // o que o prompt manda manter: endereços, e-mails, DOI, ISBN, código, referências
    ["URL", "www.example.com/about/the-book", "www.example.com/about/the-book"],
    ["link", "<a_4>https://archive.org/details/the_history_of_the_world</a_4>", "<a_4>https://archive.org/details/the_history_of_the_world</a_4>"],
    ["e-mail", "permissions@penguinrandomhouse.com", "permissions@penguinrandomhouse.com"],
    ["DOI", "doi:10.1016/j.cognition.2019.104117", "doi:10.1016/j.cognition.2019.104117"],
    ["ISBN com texto", "isbn 978-0-14-118776-1 penguin modern classics", "isbn 978-0-14-118776-1 penguin modern classics"],
    ["código", "<code_3>for i in range(10): print(i)</code_3>", "<code_3>for i in range(10): print(i)</code_3>"],
    [
      "“Available at:” com endereço",
      "Available at: https://www.nytimes.com/2019/05/12/opinion/the-end-of-the-world-as-we-know-it.html",
      "Disponível em: https://www.nytimes.com/2019/05/12/opinion/the-end-of-the-world-as-we-know-it.html",
    ],
    [
      "referência APA igual",
      "Kahneman, D. (2011). Thinking, fast and slow. New York: Farrar, Straus and Giroux.",
      "Kahneman, D. (2011). Thinking, fast and slow. New York: Farrar, Straus and Giroux.",
    ],
    [
      "referência APA com título em inglês",
      "Diamond, J. (1997). Guns, germs, and steel: The fates of human societies. New York: W. W. Norton & Company.",
      "Diamond, J. (1997). Guns, germs, and steel: The fates of human societies. Nova York: W. W. Norton & Company.",
    ],
    [
      "nota com título de artigo",
      "See John Smith, “The Rise and Fall of the Roman Empire in the Age of Steam and Iron,” The Atlantic, March 2019.",
      "Ver John Smith, “The Rise and Fall of the Roman Empire in the Age of Steam and Iron”, The Atlantic, março de 2019.",
    ],
    [
      "“See also:” com títulos de livros",
      "See also: The Lord of the Rings, The Hobbit, The Silmarillion and Unfinished Tales of Númenor and Middle-earth, all published by George Allen & Unwin.",
      "Ver também: The Lord of the Rings, The Hobbit, The Silmarillion e Unfinished Tales of Númenor and Middle-earth, todos publicados pela George Allen & Unwin.",
    ],
    ["direitos da tradução", "Translation copyright © 1970 by Harper & Row.", "Tradução copyright © 1970 by Harper & Row."],
    // “tradução” e notas que são do livro
    ["“segue uma tradução livre”", "What follows is a free translation of the poem.", "Segue uma tradução livre do poema."],
    [
      "“eis, finalmente, a tradução”",
      "Here, at last, was the translation of the ancient scroll.",
      "Eis, finalmente, a tradução do antigo pergaminho.",
    ],
    [
      "(N.B.: …) do original",
      "(N.B.: the author's spelling has been preserved throughout.)",
      "(Nota: a grafia do autor foi preservada em todo o texto.)",
    ],
    [
      "[Trans.: …] do original",
      "[Trans.: the original is a pun on the word “bark.”]",
      "[N. do T.: o original é um trocadilho com a palavra “bark”.]",
    ],
    ["(Remark: …) do original", "(Remark: the figures are approximate.)", "(Nota: os números são aproximados.)"],
    ["rótulo do original vira “Tradução:”", "Literal meaning: “the house of the rising sun.”", "Tradução: “a casa do sol nascente”."],
    ["“Note:” no começo, do original", "Note: all names have been changed.", "Nota: todos os nomes foram alterados."],
    // frases curtas que o autor deixou em outro idioma (ou já em português)
    ["francês curto mantido", "Mais oui, mon ami!", "Mais oui, mon ami!"],
    ["italiano curto mantido", "dolce far niente", "dolce far niente"],
    ["espanhol curto mantido", "hasta la vista, baby", "hasta la vista, baby"],
    ["Sartre mantido", "L'enfer, c'est les autres.", "L'enfer, c'est les autres."],
    ["lema em latim", "per aspera ad astra", "per aspera ad astra"],
    ["latim com “in”", "mens sana in corpore sano", "mens sana in corpore sano"],
    ["português no original", "Tudo bem, meu amor?", "Tudo bem, meu amor?"],
    ["português no original (2)", "Até logo, meu bem.", "Até logo, meu bem."],
    ["título em caixa alta mantido", "THE GREAT GATSBY", "THE GREAT GATSBY"],
  ];
  for (const [name, src, out] of cases) {
    it(name, () => {
      expect(checkSegment(src, out, EN_PT)).toEqual({ soft: expect.any(Array) });
    });
  }

  it("expressões do Brasil não contam como português de Portugal (“estava a par”, “a ver navios”, “de facto”)", () => {
    const soft = (src: string, out: string) => checkSegment(src, out, EN_PT).soft;
    expect(soft("She was aware of everything, and he was aware of it too.", "Ela estava a par de tudo, e ele também ficou a par disso.")).toEqual([]);
    expect(soft("He was left empty-handed, and she was left empty-handed too.", "Ele ficou a ver navios, e ela também ficou a ver navios.")).toEqual(
      [],
    );
    expect(soft("It was a de facto government, and a de facto border.", "Era um governo de facto, e uma fronteira de facto.")).toEqual([]);
    // as marcas de verdade continuam
    expect(soft("You are reading on the train and the girl is waiting.", "Estás a ler no comboio e a rapariga está à espera.")).toEqual(["pt-PT"]);
  });

  it("japonês → português: sem conferência de tamanho, sem acusar a escrita do original", () => {
    const ctx = { sourceLang: "ja", targetLang: "pt-BR" };
    expect(ok("彼は頷いた。", "Ele assentiu.", ctx)).toBeUndefined();
    const long = "彼は静かに頷いて、灯台の階段をゆっくりと上り始めた。風は強く、海は暗く、遠くの村の灯りだけが見えていた。彼女は何も言わなかった。";
    expect(long.length).toBeLessThan(80);
    const doubled = long + long;
    expect(
      ok(
        doubled,
        "Ele assentiu em silêncio e começou a subir devagar a escada do farol. O vento era forte, o mar estava escuro, e só se viam as luzes da vila ao longe. Ela não disse nada. Ele assentiu em silêncio e começou a subir devagar a escada do farol. O vento era forte, o mar estava escuro, e só se viam as luzes da vila ao longe. Ela não disse nada.",
        ctx,
      ),
    ).toBeUndefined();
  });

  it("português de Portugal não é recusado (é português), mas fica anotado", () => {
    const src = "Are you listening to me? I caught the train, and the girl was waiting for me in the bathroom of the bus station.";
    const pt = "— Estás a ouvir-me? Apanhei o comboio, e a rapariga estava à minha espera na casa de banho da estação de autocarros.";
    const br = "— Você está me ouvindo? Peguei o trem, e a garota estava me esperando no banheiro da rodoviária.";
    expect(checkSegment(src, pt, EN_PT)).toEqual({ soft: ["pt-PT"] });
    expect(checkSegment(src, br, EN_PT)).toEqual({ soft: [] });
    // português do Brasil literário (“tu”, “a caminho”, “vós”) não conta como Portugal
    expect(
      checkSegment("You know I can't, he said. I was on my way home.", "Tu sabes que não posso, disse ele. Estava a caminho de casa.", EN_PT).soft,
    ).toEqual([]);
    expect(checkSegment("Hallowed be thy name; thy kingdom come.", "Santificado seja o vosso nome; venha a nós o vosso reino.", EN_PT).soft).toEqual(
      [],
    );
  });

  it("sem idioma de origem conhecido, ou origem = destino, ou provedor de demonstração: não confere o idioma", () => {
    const src = "Mrs. Wilson stood up, smiling, and walked to the window of the little flat on 158th Street.";
    expect(ok(src, src)).toBe("echo");
    expect(ok(src, src, { sourceLang: null, targetLang: "pt-BR" })).toBeUndefined();
    expect(ok(src, src, { sourceLang: "auto", targetLang: "pt-BR" })).toBeUndefined();
    expect(ok(src, src, { sourceLang: "la", targetLang: "pt-BR" })).toBeUndefined();
    expect(ok(src, src, { ...EN_PT, languageChecks: false })).toBeUndefined();
    const pt = "Ele estava a olhar pela janela do autocarro, a pensar no pequeno-almoço que não tinha comido.";
    expect(ok(pt, pt, { sourceLang: "pt-PT", targetLang: "pt-BR" })).toBeUndefined();
  });
});

describe("conferência de um trecho: o que está errado é barrado", () => {
  const prose = "Mrs. Wilson stood up, smiling, and walked to the window of the little flat on 158th Street.";
  const cases: [string, string, string, string][] = [
    ["voltou igual (prosa)", prose, prose, "echo"],
    ["voltou igual (verso)", "and the night fell on the sea", "and the night fell on the sea", "echo"],
    [
      "voltou igual, com aspas trocadas",
      "“Come with me,” she said, “and bring the lamp.”",
      '"Come with me," she said, "and bring the lamp."',
      "echo",
    ],
    [
      "metade sem traduzir",
      "Mrs. Wilson stood up, smiling, and walked slowly to the window of the little flat on 158th Street, where the evening light was fading.",
      "Mrs. Wilson stood up, smiling, and walked slowly to the window of the little flat, onde a luz da tarde se apagava.",
      "partial-echo",
    ],
    [
      "respondeu em inglês com outras palavras",
      prose,
      "Mrs. Wilson got up, grinning, and went over to the window of the tiny apartment on 158th Street.",
      "wrong-language",
    ],
    [
      "mistura de inglês e português",
      "He hesitated for a moment, looking at the half-open door, and then followed her down the dark corridor.",
      "He hesitated for a moment, looking at the half-open door, e depois a seguiu pelo corredor escuro.",
      "wrong-language",
    ],
    ["<seg> dentro do texto", prose, 'A Sra. Wilson levantou-se, sorrindo. &lt;seg id="4"&gt;Ele saiu.', "leak"],
    ["raciocínio no texto", "He nodded.", "&lt;think&gt;vou traduzir&lt;/think&gt; Ele assentiu.", "leak"],
    ["marcador de canal", "He nodded.", "&lt;|channel|&gt;final Ele assentiu.", "leak"],
    ["contexto no texto", "He nodded.", "Ele assentiu. &lt;/context&gt;", "leak"],
    ["tag HTML sem número", "She said <em_3>softly</em_3>.", "Ela disse &lt;em&gt;baixinho&lt;/em&gt;.", "stray-tag"],
    ["ênfase em Markdown", "She whispered softly.", "Ela sussurrou *baixinho*.", "stray-tag"],
    ["letras chinesas", prose, "A Sra. Wilson levantou-se, sorrindo, e foi até a janela 公寓 do pequeno apartamento na Rua 158.", "foreign-script"],
    ["letras cirílicas", "He nodded and smiled.", "Ele assentiu и sorriu.", "foreign-script"],
    ["“Aqui está a tradução”", "He nodded.", "Aqui está a tradução: Ele assentiu.", "commentary"],
    ["“Here's the translation”", "He nodded.", "Here's the translation: Ele assentiu.", "commentary"],
    [
      "nota do tradutor inventada",
      "He said nothing.",
      "Ele não disse nada. (Nota: o original usa uma construção enfática que não tem equivalente direto em português.)",
      "commentary",
    ],
    ["N. do T.", "It was a pun.", "Era um trocadilho. (N. do T.: intraduzível.)", "commentary"],
    ["pedido de desculpas no lugar do texto", "He nodded.", "Desculpe, mas não posso traduzir este trecho.", "commentary"],
    ["desculpas em inglês no lugar do texto", "He nodded.", "I'm sorry, but I can't help with that.", "commentary"],
    ["“Como modelo de linguagem…”", "He nodded.", "Como modelo de linguagem, não posso ajudar com isso.", "commentary"],
    ["“Claro! Aqui está a tradução:”", "He nodded.", "Claro! Aqui está a tradução: Ele assentiu.", "commentary"],
    ["“Sure! Here it is:”", "He nodded.", "Sure! Here it is: Ele assentiu.", "commentary"],
    ["“Tradução de “…”:”", "He nodded.", "Tradução de “He nodded.”: Ele assentiu.", "commentary"],
    ["“Tradução:” sem rótulo no original", "He nodded.", "Tradução: Ele assentiu.", "commentary"],
    [
      "nota do tradutor solta no fim",
      prose,
      "A Sra. Wilson levantou-se, sorrindo, e foi até a janela do pequeno apartamento na Rua 158.\nNota do tradutor: mantive o nome da rua.",
      "commentary",
    ],
    [
      "“Note:” solta no fim",
      prose,
      "A Sra. Wilson levantou-se, sorrindo, e foi até a janela do pequeno apartamento na Rua 158. Note: I kept the street name.",
      "commentary",
    ],
    // inglês curto que voltou igual (com travessão, reticências, caixa alta)
    ["fala curta igual", "She smiled at him.", "She smiled at him.", "echo"],
    ["“It was cold.”", "It was cold.", "It was cold.", "echo"],
    ["“I don't know.”", "“I don't know.”", "“I don't know.”", "echo"],
    ["“He nodded.”", "He nodded.", "He nodded.", "echo"],
    ["inglês com o travessão do diálogo", "“Come here,” she said.", "— Come here — she said.", "echo"],
    ["reticências trocadas", "I waited… and waited… and nothing came.", "I waited... and waited... and nothing came.", "echo"],
    [
      "caixa alta igual",
      "THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG AND RUNS AWAY INTO THE DARK FOREST.",
      "THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG AND RUNS AWAY INTO THE DARK FOREST.",
      "echo",
    ],
    ["verso quase igual", "and the night fell on the sea", "and the night fell upon the sea", "echo"],
    // escorregou para outro idioma
    [
      "espanhol no lugar de português",
      prose,
      "La señora Wilson se levantó, sonriendo, y caminó hasta la ventana del pequeño piso de la calle 158.",
      "wrong-language",
    ],
    [
      "italiano no lugar de português",
      prose,
      "La signora Wilson si alzò, sorridendo, e andò alla finestra del piccolo appartamento sulla 158esima strada.",
      "wrong-language",
    ],
    [
      "francês no lugar de português",
      prose,
      "Mme Wilson se leva, souriante, et se dirigea vers la fenêtre du petit appartement de la 158e rue.",
      "wrong-language",
    ],
    ["sem nenhuma letra", "He nodded.", "…", "empty"],
    ["pedaço cortado", prose, "A Sra. Wilson levantou-se.", "length"],
    ["texto a mais num trecho curto", "Yes.", "Sim. Esta é uma resposta curta, mas o modelo resolveu explicar muito mais coisas aqui.", "length"],
    [
      "texto inventado num trecho longo",
      prose,
      `${"A Sra. Wilson levantou-se, sorrindo, e foi até a janela do pequeno apartamento na Rua 158. ".repeat(3)}E então ela contou toda a sua vida.`,
      "length",
    ],
  ];
  for (const [name, src, out, issue] of cases) {
    it(name, () => {
      expect(ok(src, out)).toBe(issue);
    });
  }

  it("idioma: citação longa em outro idioma mantida não conta; idioma que o detector não conhece não é conferido", () => {
    const src = "“Je ne sais pas ce que vous voulez dire, monsieur, et je ne veux pas le savoir,” she said quietly to the old man.";
    expect(ok(src, "— Je ne sais pas ce que vous voulez dire, monsieur, et je ne veux pas le savoir — disse ela baixinho ao velho.")).toBeUndefined();
    // catalão: o detector não tem, então não acusa o catalão de ser espanhol
    const ca = { sourceLang: "en", targetLang: "ca" };
    expect(
      ok(
        "Mrs. Wilson stood up, smiling, and walked to the window of the little flat on 158th Street.",
        "La senyora Wilson es va aixecar, somrient, i va anar fins a la finestra del petit pis del carrer 158.",
        ca,
      ),
    ).toBeUndefined();
  });

  it("avisos: tamanho fora do comum e formatação perdida", () => {
    expect(
      checkSegment(
        "Mrs. Wilson stood up, smiling, and walked to the window of the little flat on 158th Street.",
        "A Sra. Wilson levantou-se e foi à janela.",
        EN_PT,
      ),
    ).toEqual({ soft: ["ratio"] });
    expect(checkSegment("She said <em_3>softly</em_3>.", "Ela disse baixinho.", EN_PT)).toEqual({ soft: ["fmt-lost"] });
  });

  it("tags soltas são tiradas sem estragar as tags de verdade", () => {
    expect(stripStrayTags("Ela disse &lt;em&gt;baixinho&lt;/em&gt; e <em_3>riu</em_3>.")).toBe("Ela disse baixinho e <em_3>riu</em_3>.");
    expect(stripStrayTags("Uma linha&lt;br/&gt;outra, *bem* devagar.")).toBe("Uma linha outra, bem devagar.");
  });

  it("<br/> sem número no lugar da quebra de verso volta ao lugar (como uma quebra de linha)", () => {
    const tags: Record<string, InlineTag> = { "3": { n: "br", o: "<br/>", v: 1 }, "4": { n: "br", o: "<br/>", v: 1 } };
    const src = "The heron rises<br_3/>from the dark pond<br_4/>at dawn";
    for (const raw of ["A garça se ergue<br/>do lago escuro<br>ao amanhecer", "A garça se ergue &lt;br /&gt; do lago escuro\nao amanhecer"]) {
      const r = repairMarkup(raw, tags, tagKeys(src));
      const fixed = restoreLineBreaks(r.markup, r.missing, tags);
      expect(fixed).toEqual({ markup: "A garça se ergue<br_3/>do lago escuro<br_4/>ao amanhecer", missing: [] });
      expect(checkSegment(src, fixed.markup, EN_PT)).toEqual({ soft: [] });
    }
  });

  it("mesma tradução para trechos diferentes; pontuação diferente no original não conta", () => {
    const same = "Ele subiu a escada estreita do farol.";
    const r = repeatedOutputs([
      { src: "He climbed the narrow stairs of the lighthouse.", out: same },
      { src: "The wind was cold.", out: "O vento estava frio e cortante." },
      { src: "She waited at the door for a long time.", out: same },
      { src: "Nobody came.", out: same },
    ]);
    expect([...r.indexes]).toEqual([0, 2, 3]);
    expect(r.cases).toBe(2);
    const quotes = repeatedOutputs([
      { src: '"Come here," she said.', out: "— Venha cá — disse ela." },
      { src: "“Come here,” she said.", out: "— Venha cá — disse ela." },
    ]);
    expect(quotes.cases).toBe(0);
  });
});

/* ---------- leitura da resposta ---------- */

describe("leitura da resposta do modelo", () => {
  it("entrada repetida antes da resposta: vale a última", () => {
    const text = `Input:\n<seg id="1">He nodded.</seg>\nOutput:\n<seg id="1">Ele assentiu.</seg>`;
    expect([...parseSegments(text)]).toEqual([[1, "Ele assentiu."]]);
  });

  it("</seg> esquecido: o trecho termina no próximo <seg id> ou no <new_terms>", () => {
    expect([...parseSegments(`<seg id="1">Ele assentiu. <seg id="2">Ela sorriu.</seg>\n<seg id="3">Fim.</seg>`)]).toEqual([
      [1, "Ele assentiu."],
      [2, "Ela sorriu."],
      [3, "Fim."],
    ]);
    expect([...parseSegments(`<seg id="1">Ele assentiu.\n<new_terms>\nReyes => Reyes | character\n</new_terms>`)]).toEqual([[1, "Ele assentiu."]]);
  });

  it("trecho cortado no fim da resposta não conta (resposta cortada)", () => {
    expect([...parseSegments(`<seg id="1">Ele assentiu.</seg>\n<seg id="2">Ela sorr`)]).toEqual([[1, "Ele assentiu."]]);
  });

  it("raciocínio: some tudo até o último </think> e depois de um <think> aberto", () => {
    const text = `<think>Rascunho: <seg id="1">Ele fez que sim.</seg></think>\n<seg id="1">Ele assentiu.</seg>\n<seg id="2">Ela sorriu.</seg><think>conferindo <seg id="2">Rascunho</seg>`;
    expect([...parseSegments(text)]).toEqual([
      [1, "Ele assentiu."],
      [2, "Ela sorriu."],
    ]);
    expect(stripReasoning("<|channel|>analysis<|message|>pensando<|end|><|start|>assistant<|channel|>final<|message|>Resposta<|return|>")).toBe(
      "Resposta",
    );
    expect(stripReasoning("<|channel|>analysis<|message|>só pensando")).toBe("");
  });

  it("“<think>” dentro de um trecho é texto do livro: não derruba os trechos seguintes", () => {
    const text = `<seg id="1">A tag <think> aparece no código.</seg>\n<seg id="2">Fim.</seg>`;
    expect([...parseSegments(text)]).toEqual([
      [1, "A tag <think> aparece no código."],
      [2, "Fim."],
    ]);
    // fora de um trecho continua sendo raciocínio
    expect([...parseSegments(`<seg id="1">Ele assentiu.</seg>\n<think>talvez <seg id="1">outra</seg>`)]).toEqual([[1, "Ele assentiu."]]);
    expect(stripReasoning(`Rascunho <seg id="1">He nodded.</seg></think>\n<seg id="1">Ele assentiu.</seg>`)).toBe(
      `\n<seg id="1">Ele assentiu.</seg>`,
    );
  });

  it("entrada repetida depois da resposta (“Original: …”) ou trecho vazio no fim: vale a tradução", () => {
    const sources = new Map([[1, "He nodded."]]);
    expect([...parseSegments(`<seg id="1">Ele assentiu.</seg>\n\nOriginal:\n<seg id="1">He nodded.</seg>`, { sources })]).toEqual([
      [1, "Ele assentiu."],
    ]);
    expect([...parseSegments(`<seg id="1">Ele assentiu.</seg>\n<seg id="1"></seg>`, { sources })]).toEqual([[1, "Ele assentiu."]]);
    // só o original: fica o original (a conferência de qualidade decide)
    expect([...parseSegments(`<seg id="1">He nodded.</seg>`, { sources })]).toEqual([[1, "He nodded."]]);
    // duas traduções: vale a última (o modelo se corrigiu)
    expect([...parseSegments(`<seg id="1">Ele fez que sim.</seg><seg id="1">Ele assentiu.</seg>`, { sources })]).toEqual([[1, "Ele assentiu."]]);
  });

  it("último trecho sem </seg> numa resposta que terminou normalmente: conta (sem a conversa depois)", () => {
    const text = `<seg id="1">Ele assentiu.</seg>\n<seg id="2">Ela sorriu.`;
    expect([...parseSegments(text, { complete: true })]).toEqual([
      [1, "Ele assentiu."],
      [2, "Ela sorriu."],
    ]);
    expect([...parseSegments(`${text}\n\nEspero ter ajudado!`, { complete: true })].at(-1)).toEqual([2, "Ela sorriu."]);
    // resposta cortada: não conta
    expect([...parseSegments(text, { complete: false })]).toEqual([[1, "Ele assentiu."]]);
  });

  it("nomes novos: plural, possessivo, apóstrofo curvo, acento decomposto e espaço especial contam como o mesmo nome", () => {
    const src =
      "The dementors glided closer. Three Ents stood by the river. Seamus O’Brien laughed. The Weasleys arrived. Zoe\u0308 met Mr.\u00a0Darcy.";
    const text = `<seg id="1">x</seg>\n<new_terms>\nDementor => Dementador | term\nEnt => Ent | other\nSeamus O'Brien => Seamus O'Brien | character\nWeasley => Weasley | character\nThe Weasleys => Os Weasley | character\nZoë => Zoë | character\nMr. Darcy => Sr. Darcy | character\nAtlantis => Atlântida | place\n</new_terms>`;
    expect(parseNewTerms(text, src).map((t) => t.term)).toEqual(["Dementor", "Ent", "Seamus O'Brien", "Weasley", "The Weasleys", "Zoë", "Mr. Darcy"]);
    // palavra inteira continua valendo: “Ana” não está em “Anabela”, “Ent” não está em “Entwife”
    expect(mentions("Anabela chegou.", "Ana")).toBe(false);
    expect(mentions("An Entwife sang.", "Ent")).toBe(false);
    // o glossário de cada pedido também acha a entrada no plural
    const entry: GlossaryEntry = { id: "1", term: "Dementor", translation: "Dementador", type: "term", origin: "auto" };
    expect(relevantEntries([entry], "The dementors glided closer.")).toEqual([entry]);
  });

  it("nomes novos: só os que aparecem no lote", () => {
    const text = `<seg id="1">…</seg>\n<new_terms>\nCaptain Reyes => Capitão Reyes | character\nthe valley of ashes => o Vale das Cinzas | place\nJohn => João | character\n</new_terms>`;
    const source = "Captain Reyes looked across The Valley of Ashes.";
    expect(parseNewTerms(text, source).map((t) => t.term)).toEqual(["Captain Reyes", "the valley of ashes"]);
    expect(parseNewTerms(text)).toHaveLength(3);
  });

  it("recusa escrita no texto", () => {
    expect(looksLikeRefusal("I'm sorry, but I can't help with translating this text.")).toBe(true);
    expect(looksLikeRefusal("Desculpe, não posso traduzir este conteúdo.")).toBe(true);
    expect(looksLikeRefusal("I'm sorry, but I can't help with that.")).toBe(true);
    expect(looksLikeRefusal('<seg id="1">Ele assentiu.</seg>')).toBe(false);
    expect(looksLikeRefusal("")).toBe(false);
  });

  it("tradução sem as tags, com falas de desculpas, não é recusa", () => {
    expect(looksLikeRefusal("— Desculpe — disse ela. — Não foi minha intenção.\n\n— Tudo bem — respondeu ele.")).toBe(false);
    expect(looksLikeRefusal("Sinto muito pela sua perda, disse o padre.\nEla não respondeu.")).toBe(false);
    expect(looksLikeRefusal("Lamento, mas o trem já partiu, disse o funcionário.")).toBe(false);
    expect(looksLikeRefusal("“I'm sorry,” he said. “I didn't mean to.”")).toBe(false);
    // só o começo conta: uma fala lá no meio de uma resposta comprida não
    expect(looksLikeRefusal(`${"O faroleiro subiu a escada e olhou o mar. ".repeat(6)}Desculpe, não posso traduzir isso, disse o intérprete.`)).toBe(
      false,
    );
  });

  it("recusa depois dos trechos que voltaram: o lote é dividido; fala depois dos trechos não", async () => {
    const segments = [1, 2, 3].map((id) => ({ id, text: `Line ${id}: the keeper climbed the stairs.` }));
    const input = { book: BOOK, glossary: [], storySoFar: [], chapterTitle: "c", preceding: [], segments };
    const two = `<seg id="1">Linha 1.</seg>\n<seg id="2">Linha 2.</seg>\n`;
    const run = async (text: string) =>
      (
        await new LLMTranslationProvider(fakeLLM(() => ({ text })).llm, { paid: false, limits: { batchChars: 5000, concurrency: 1 } }).translateBatch(
          input,
        )
      ).refused;
    expect(await run(`${two}I'm sorry, but I can't continue translating this text.`)).toBe(true);
    expect(await run(`${two}— Desculpe — disse ele.`)).toBe(false);
    expect(await run(`${two}<seg id="3">Linha 3.</seg>`)).toBe(false);
  });
});

/* ---------- prompt ---------- */

const BOOK: BookContext = {
  title: "The Keeper",
  sourceLanguage: "English",
  targetLanguage: "Brazilian Portuguese",
  targetCode: "pt-BR",
  options: { dialogueStyle: "target", deepContext: false },
};

describe("prompt", () => {
  it("português do Brasil: regra fixa de tratamento e vocabulário, só para pt-BR, sempre igual", () => {
    const br = translationSystemPrompt(BOOK);
    expect(br).toMatch(/“você” by default/);
    expect(br).toMatch(/“estava fazendo”, never “estava a fazer”/);
    expect(br).toMatch(/“o senhor”\/“a senhora”/);
    expect(translationSystemPrompt(BOOK)).toBe(br); // estável: aproveita o cache
    expect(translationSystemPrompt({ ...BOOK, targetCode: "pt-PT", targetLanguage: "European Portuguese" })).not.toMatch(/você/);
    expect(translationSystemPrompt({ ...BOOK, targetCode: "es", targetLanguage: "Spanish" })).not.toMatch(/você/);
  });

  it("nova tentativa: o pedido diz o que deu errado", () => {
    const base = { book: BOOK, glossary: [], storySoFar: [], chapterTitle: "c", preceding: [], segments: [{ id: 1, text: "He nodded." }] };
    expect(translationUserPrompt({ ...base, strict: true })).toMatch(/a previous attempt lost segments or inline tags/);
    const p = translationUserPrompt({ ...base, strict: true, issues: ["echo", "commentary", "desconhecido"] });
    expect(p).toMatch(/came back untranslated: translate every segment fully into Brazilian Portuguese/);
    expect(p).toMatch(/no notes, explanations or remarks/);
    expect(p).not.toMatch(/desconhecido/);
    expect(translationUserPrompt({ ...base, issues: ["echo"] })).not.toMatch(/retry/);
    // sem mandar traduzir o que o autor deixou em outro idioma
    for (const issue of ["echo", "partial-echo", "wrong-language"]) {
      expect(translationUserPrompt({ ...base, strict: true, issues: [issue] })).toMatch(
        /phrases the author deliberately left in another language stay as they are/,
      );
    }
  });
});

/* ---------- análise do livro ---------- */

function fakeLLM(reply: (req: LLMRequest, call: number) => Partial<LLMResponse>) {
  const requests: LLMRequest[] = [];
  const llm: LLMClient = {
    providerId: "fake",
    model: "m1",
    async complete(req) {
      requests.push(req);
      return { text: "", stopReason: "end", usage: { inputTokens: 10, outputTokens: 10 }, ...reply(req, requests.length) };
    },
  };
  return { llm, requests };
}

const ANALYSIS = JSON.stringify({
  sourceLanguage: "en",
  translatedTitle: "O Faroleiro",
  genre: "Romance",
  tone: "Sóbrio",
  narrativeVoice: "Terceira pessoa",
  styleNotes: "Frases curtas",
  synopsis: "Uma faroleira.",
  glossary: [{ term: "Reyes", translation: "Reyes", type: "character", note: "capitão" }],
  tocTranslations: [],
});

describe("análise do livro e dos capítulos", () => {
  const input = { book: BOOK, sample: "Some text.", tocLabels: Array.from({ length: 120 }, (_, i) => `Chapter ${i + 1}`) };
  const limits = { batchChars: 5000, concurrency: 1 };

  it("cortada: pede uma vez uma versão menor; cortada de novo: erro passageiro (não grava perfil vazio)", async () => {
    const twice = fakeLLM((_req, call) => (call === 1 ? { text: '{"genre": "Rom', stopReason: "max_tokens" } : { text: ANALYSIS }));
    const a = await new LLMTranslationProvider(twice.llm, { paid: false, limits }).analyzeBook(input);
    expect(a.profile.genre).toBe("Romance");
    expect(twice.requests).toHaveLength(2);
    expect(twice.requests[0].user).toMatch(/Up to 60 entries/);
    expect(twice.requests[1].user).toMatch(/Up to 30 entries/);
    expect(twice.requests[1].user).not.toMatch(/table_of_contents/); // sumário longo fica de fora
    expect(a.usage).toEqual({ inputTokens: 20, outputTokens: 20 });

    const cut = fakeLLM(() => ({ text: '{"genre": "Rom', stopReason: "max_tokens" }));
    const err = await new LLMTranslationProvider(cut.llm, { paid: false, limits }).analyzeBook(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).fatal).toBe(false);
    expect(cut.requests).toHaveLength(2);
  });

  it("JSON ilegível ou perfil vazio: erro passageiro, sem nova chamada", async () => {
    for (const text of ["não é json", "{}", JSON.stringify({ genre: "", tone: "", glossary: [] })]) {
      const bad = fakeLLM(() => ({ text }));
      const err = await new LLMTranslationProvider(bad.llm, { paid: false, limits }).analyzeBook(input).catch((e: unknown) => e);
      expect((err as ProviderError).fatal).toBe(false);
      expect(bad.requests).toHaveLength(1);
    }
  });

  it("teto de saída baixo (ex.: Groq): já começa pedindo menos nomes, dentro do teto", async () => {
    const small = fakeLLM(() => ({ text: ANALYSIS }));
    // os limites de verdade do Groq (createProvider), não um teto escrito à mão no teste
    const groq = createProvider("groq", { groqApiKey: "k" }).limits;
    expect(groq.maxOutputTokens).toBe(4000);
    const provider = new LLMTranslationProvider(small.llm, { paid: false, limits: groq });
    await provider.analyzeBook(input);
    expect(small.requests).toHaveLength(1);
    expect(small.requests[0].maxTokens).toBe(4000);
    expect(small.requests[0].user).toMatch(/Up to 30 entries/);
    await provider.analyzeChapter({ book: BOOK, chapterTitle: "c", text: "t", knownTerms: [], previousSummaries: [] });
    expect(small.requests[1].maxTokens).toBe(4000);
    expect(small.requests[1].user).toMatch(/at most 15/);
    await provider.translateBatch({ book: BOOK, glossary: [], storySoFar: [], chapterTitle: "c", preceding: [], segments: [{ id: 1, text: "Hi." }] });
    expect(small.requests[2].maxTokens).toBe(4000);
    // sem teto: como antes
    expect(bookAnalysisPrompt(input)).toMatch(/Up to 60 entries/);
  });

  it("Cloudflare e Mistral (teto de 8192): lista completa de nomes, pedido dentro do teto", async () => {
    const settings = { cloudflareAccountId: "a", cloudflareApiToken: "t", mistralApiKey: "k" };
    for (const id of ["cloudflare", "mistral"]) {
      const lim = createProvider(id, settings).limits;
      expect(lim.maxOutputTokens).toBe(8192);
      const llm = fakeLLM(() => ({ text: ANALYSIS }));
      await new LLMTranslationProvider(llm.llm, { paid: false, limits: lim }).analyzeBook(input);
      expect(llm.requests).toHaveLength(1);
      expect(llm.requests[0].maxTokens).toBe(8192);
      expect(llm.requests[0].user).toMatch(/Up to 60 entries/);
    }
  });

  it("análise que falhou leva junto os tokens gastos (para entrar na conta)", async () => {
    const cut = fakeLLM(() => ({ text: '{"genre": "Rom', stopReason: "max_tokens" }));
    const book = (await new LLMTranslationProvider(cut.llm, { paid: false, limits }).analyzeBook(input).catch((e: unknown) => e)) as ProviderError;
    expect(book.usage).toEqual({ inputTokens: 20, outputTokens: 20 }); // os dois pedidos
    const bad = fakeLLM(() => ({ text: "não é json" }));
    const chapter = (await new LLMTranslationProvider(bad.llm, { paid: false, limits })
      .analyzeChapter({ book: BOOK, chapterTitle: "c", text: "t", knownTerms: [], previousSummaries: [] })
      .catch((e: unknown) => e)) as ProviderError;
    expect(chapter).toBeInstanceOf(ProviderError);
    expect(chapter.usage).toEqual({ inputTokens: 10, outputTokens: 10 });
    // a segunda tentativa deu erro de rede: o primeiro pedido continua na conta
    const net = fakeLLM((_req, call) => {
      if (call === 2) throw new ProviderError("sem rede", { fatal: false, code: "network" });
      return { text: '{"genre": "Rom', stopReason: "max_tokens" };
    });
    const err = (await new LLMTranslationProvider(net.llm, { paid: false, limits }).analyzeBook(input).catch((e: unknown) => e)) as ProviderError;
    expect(err).toMatchObject({ code: "network", fatal: false, usage: { inputTokens: 10, outputTokens: 10 } });
  });

  it("análise de capítulo cortada: erro passageiro", async () => {
    const cut = fakeLLM(() => ({ text: '{"summary": "Um', stopReason: "max_tokens" }));
    const err = await new LLMTranslationProvider(cut.llm, { paid: false, limits })
      .analyzeChapter({ book: BOOK, chapterTitle: "c", text: "t", knownTerms: [], previousSummaries: [] })
      .catch((e: unknown) => e);
    expect((err as ProviderError).fatal).toBe(false);
  });
});

/* ---------- no processador, com um modelo falso que erra de vários jeitos ---------- */

const PT: Record<string, string> = {
  "The Lighthouse": "O Farol",
  "Maria walked to the old lighthouse at dawn, where the captain was already waiting for her.":
    "Maria caminhou até o velho farol ao amanhecer, onde o capitão já esperava por ela.",
  "“Are you coming with me?” asked the captain, without turning around.": "— Você vem comigo? — perguntou o capitão, sem se virar.",
  "She nodded and followed him up the narrow stairs, counting every step in silence.":
    "Ela assentiu e o seguiu pela escada estreita, contando cada degrau em silêncio.",
  "The sea remembers everything.": "O mar se lembra de tudo.",
  "At the top, the great lamp was cold and dark, and the wind whistled through the broken glass.":
    "No alto, a grande lanterna estava fria e apagada, e o vento assobiava pelo vidro quebrado.",
  "Sherlock Holmes, Baker Street, 221B, London.": "Sherlock Holmes, Baker Street, 221B, London.",
  "The Storm": "A Tempestade",
  "That night the storm came from the north, and the whole village of Porto Velho stayed awake.":
    "Naquela noite a tempestade veio do norte, e toda a vila de Porto Velho ficou acordada.",
  "The captain lit the lamp again, and its light swept across the black water until morning.":
    "O capitão acendeu a lanterna de novo, e sua luz varreu a água negra até de manhã.",
};
const LONG = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1}: the keeper climbed the stairs once more and looked at the grey sea.`);
LONG.forEach((s, i) => (PT[s] = `Parágrafo ${i + 1}: o faroleiro subiu a escada mais uma vez e olhou para o mar cinzento.`));
PT["The Long Night"] = "A Longa Noite";
const P1 = "Maria walked to the old lighthouse at dawn, where the captain was already waiting for her.";
const P2 = "“Are you coming with me?” asked the captain, without turning around.";
const P3 = "She nodded and followed him up the narrow stairs, counting every step in silence.";
const P5 = "At the top, the great lamp was cold and dark, and the wind whistled through the broken glass.";

async function keeperBook() {
  const epub = await writeEpub({
    title: "The Keeper",
    language: "en",
    chapters: [
      {
        title: "The Lighthouse",
        body: `<h1>The Lighthouse</h1><p>${P1}</p><p>${P2}</p><p>${P3}</p><p>The sea remembers everything.</p><p>${P5}</p><p>Sherlock Holmes, Baker Street, 221B, London.</p>`,
      },
      {
        title: "The Storm",
        body: `<h1>The Storm</h1><p>That night the storm came from the north, and the whole village of Porto Velho stayed awake.</p><p>The captain lit the lamp again, and its light swept across the black water until morning.</p>`,
      },
      { title: "The Long Night", body: `<h1>The Long Night</h1>${LONG.map((p) => `<p>${p}</p>`).join("")}` },
    ],
  });
  const meta = await importBook(epub, { fileName: "keeper.epub", targetLanguage: "pt-BR" });
  expect(meta.detectedLanguage).toBe("en");
  return meta;
}

type Seg = { id: number; text: string };
const segsOf = (req: LLMRequest): Seg[] =>
  [...req.user.matchAll(/<seg id="(\d+)">([\s\S]*?)<\/seg>/g)].map((m) => ({ id: Number(m[1]), text: m[2] }));
const tr = (text: string) => PT[text] ?? `[sem tradução: ${text}]`;
const answer = (segs: Seg[], map: (s: Seg) => string = (s) => tr(s.text)) => segs.map((s) => `<seg id="${s.id}">${map(s)}</seg>`).join("\n");

/** Modelo falso com o mesmo caminho de um modelo de verdade (prompt, leitura da resposta, recusa no texto). */
function scripted(reply: (segs: Seg[], req: LLMRequest, call: number) => string, model = "m1") {
  const requests: LLMRequest[] = [];
  const llm: LLMClient = {
    providerId: "fake",
    model,
    async complete(req) {
      requests.push(req);
      return { text: reply(segsOf(req), req, requests.length), stopReason: "end", usage: { inputTokens: 10, outputTokens: 10 } };
    },
  };
  const provider = new LLMTranslationProvider(llm, { paid: false, limits: { batchChars: 50_000, concurrency: 1 } });
  return { provider, requests };
}

function hooks(engine = "fake/m1") {
  const stats = { requests: 0, retries: 0, refused: 0, words: 0, failed: 0, local: 0 };
  return {
    stats,
    engine,
    signal: new AbortController().signal,
    analysisLock: <T>(fn: () => Promise<T>) => fn(),
    onUsage: async (_u: unknown, info?: { retry?: boolean; refused?: boolean }) => {
      stats.requests++;
      if (info?.retry) stats.retries++;
      if (info?.refused) stats.refused++;
    },
    onLocal: async (n: number) => {
      stats.local += n;
    },
    onProgress: async (_c: string, d: { words: number; failed: number }) => {
      stats.words += d.words;
      stats.failed += d.failed;
    },
    onChapterSaved: async () => {},
  };
}

async function chapterSegments(meta: BookMeta, chapter: ChapterMeta) {
  const doc = await store.readDoc(meta.id, chapter.docId);
  return doc.segments.slice(chapter.start, chapter.end);
}

async function run(reply: Parameters<typeof scripted>[0], chapterIdx = 0) {
  const meta = await keeperBook();
  const { provider, requests } = scripted(reply);
  const h = hooks();
  await processChapters(meta, [meta.chapters[chapterIdx]], provider, h);
  return { meta, requests, stats: h.stats, segs: await chapterSegments(meta, meta.chapters[chapterIdx]) };
}

const allTranslated = (segs: Awaited<ReturnType<typeof chapterSegments>>) => segs.every((s) => s.out === PT[s.src]);

describe("no processador: o modelo erra, o livro sai certo", () => {
  it("resposta limpa: um pedido, cada trecho com quem traduziu, sem avisos", async () => {
    const { requests, segs } = await run((s) => answer(s));
    expect(requests).toHaveLength(1);
    expect(allTranslated(segs)).toBe(true);
    expect(segs.every((s) => s.by === "fake/m1" && s.warn === undefined)).toBe(true);
  });

  it("repete a entrada antes da resposta: vale a resposta, sem nova tentativa", async () => {
    const { requests, segs } = await run((s) => `Input:\n${answer(s, (x) => x.text)}\nOutput:\n${answer(s)}`);
    expect(requests).toHaveLength(1);
    expect(allTranslated(segs)).toBe(true);
  });

  it("esquece o </seg>: cada trecho termina no próximo, sem nova tentativa nem texto duplicado", async () => {
    const { requests, segs } = await run((s) => s.map((x, i) => `<seg id="${x.id}">${tr(x.text)}${i === s.length - 1 ? "</seg>" : ""}`).join("\n"));
    expect(requests).toHaveLength(1);
    expect(allTranslated(segs)).toBe(true);
  });

  it("rascunhos dentro de <think>: só a resposta final conta", async () => {
    const { requests, segs } = await run(
      (s) =>
        `<think>Rascunho:\n${answer(s, () => "rascunho ruim")}</think>\n${answer(s)}\n<think>conferindo ${answer(s.slice(0, 1), () => "outro rascunho")}`,
    );
    expect(requests).toHaveLength(1);
    expect(allTranslated(segs)).toBe(true);
  });

  it("devolve um trecho em inglês: nova tentativa só dele, com o motivo no pedido", async () => {
    const { requests, segs, stats } = await run((s, req) => answer(s, (x) => (x.text === P1 && !/retry/.test(req.user) ? x.text : tr(x.text))));
    expect(requests).toHaveLength(2);
    expect(segsOf(requests[1]).map((x) => x.text)).toEqual([P1]);
    expect(requests[1].user).toMatch(/came back untranslated/);
    expect(stats.retries).toBe(1);
    expect(allTranslated(segs)).toBe(true);
  });

  it("acrescenta comentário, vaza o contexto ou responde em inglês com outras palavras: nova tentativa de cada um", async () => {
    const { requests, segs } = await run((s, req) =>
      answer(s, (x) => {
        if (/retry/.test(req.user)) return tr(x.text);
        if (x.text === P3) return `${tr(x.text)} (Nota: “narrow” também pode ser “apertada”.)`;
        if (x.text === P2) return `${tr(x.text)} <glossary>`;
        if (x.text === P5) return "At the very top the big lamp was cold and unlit, and wind was whistling through the shattered glass.";
        return tr(x.text);
      }),
    );
    expect(requests).toHaveLength(2);
    expect(segsOf(requests[1])).toHaveLength(3);
    expect(requests[1].user).toMatch(/notes, comments or apologies/);
    expect(requests[1].user).toMatch(/parts of the request/);
    expect(requests[1].user).toMatch(/not written in Brazilian Portuguese/);
    expect(allTranslated(segs)).toBe(true);
  });

  it("insiste em devolver o original: fica marcado para revisão, com o motivo, sem gravar inglês", async () => {
    const { requests, segs, stats } = await run((s) => answer(s, (x) => (x.text === P5 ? x.text : tr(x.text))));
    expect(requests).toHaveLength(2);
    const bad = segs.find((s) => s.src === P5)!;
    expect(bad).toMatchObject({ failed: true, warn: ["echo"] });
    expect(bad.out).toBeUndefined();
    expect(bad.by).toBeUndefined();
    expect(stats.failed).toBe(1);
    // os nomes que ficam iguais de propósito passam
    expect(segs.find((s) => s.src.startsWith("Sherlock"))!.out).toBe("Sherlock Holmes, Baker Street, 221B, London.");
  });

  it("tags soltas na nova tentativa: tira as tags, grava e anota", async () => {
    const meta = await keeperBook();
    const ch = meta.chapters[0];
    let italic = "";
    await store.updateDoc(meta.id, ch.docId, (content) => {
      const s = content.segments.find((x) => x.src === P3)!;
      content.tags["900"] = { n: "em", o: "<em>" };
      s.src = "She nodded and followed him up the <em_900>narrow</em_900> stairs, counting every step in silence.";
      italic = s.src;
    });
    PT[italic] = "Ela assentiu e o seguiu pela escada <em_900>estreita</em_900>, contando cada degrau em silêncio.";
    const { provider, requests } = scripted((s) =>
      answer(s, (x) => (x.text === italic ? "Ela assentiu e o seguiu pela escada <em>estreita</em>, contando cada degrau em silêncio." : tr(x.text))),
    );
    await processChapters((await store.get(meta.id))!, [ch], provider, hooks());
    expect(requests).toHaveLength(2);
    const seg = (await chapterSegments(meta, ch)).find((s) => s.src === italic)!;
    expect(seg.out).toBe("Ela assentiu e o seguiu pela escada estreita, contando cada degrau em silêncio.");
    expect(seg.warn).toEqual(["stray-tag", "fmt-lost"]);
    expect(seg.failed).toBeUndefined();
  });

  it("recusa escrita no texto (“I'm sorry…”): conta como recusa e divide o lote", async () => {
    const { requests, segs, stats } = await run((s, _req, call) =>
      call === 1 ? "I'm sorry, but I can't help with translating this text." : answer(s),
    );
    expect(stats.refused).toBe(1);
    expect(requests.map((r) => segsOf(r).length)).toEqual([7, 4, 3]);
    expect(allTranslated(segs)).toBe(true);
  });

  it("a mesma tradução em vários trechos (ordem perdida): divide o pedido uma vez e acerta", async () => {
    const { requests, segs } = await run((s, _req, call) => answer(s, (x) => (call === 1 && [P1, P3, P5].includes(x.text) ? tr(P1) : tr(x.text))));
    expect(requests.map((r) => [segsOf(r).length, /retry/.test(r.user)])).toEqual([
      [7, false],
      [4, false],
      [3, false],
    ]);
    expect(allTranslated(segs)).toBe(true);
  });

  it("repetições raras num pedido grande (um refrão): não descarta a resposta, só esses voltam", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}: the wind is singing softly over the quiet water tonight.`);
    lines.forEach((l, i) => (PT[l] = `Verso ${i + 1}: o vento canta baixinho sobre a água calma esta noite.`));
    const epub = await writeEpub({
      title: "Refrain",
      language: "en",
      chapters: [{ title: "Refrain", body: lines.map((l) => `<p>${l}</p>`).join("") }],
    });
    const meta = await importBook(epub, { fileName: "refrain.epub", targetLanguage: "pt-BR" });
    const { provider, requests } = scripted((s, _req, call) =>
      answer(s, (x) => (call === 1 && [lines[4], lines[14], lines[24]].includes(x.text) ? tr(lines[4]) : tr(x.text))),
    );
    await processChapters(meta, [meta.chapters[0]], provider, hooks());
    expect(requests.map((r) => [segsOf(r).length, /retry/.test(r.user)])).toEqual([
      [30, false],
      [3, true],
    ]);
    expect(allTranslated(await chapterSegments(meta, meta.chapters[0]))).toBe(true);
  });

  it("um par com a mesma tradução: só esses dois voltam, com o motivo", async () => {
    const { requests, segs } = await run((s, _req, call) => answer(s, (x) => (call === 1 && x.text === P3 ? tr(P1) : tr(x.text))));
    expect(requests).toHaveLength(2);
    expect(segsOf(requests[1]).map((x) => x.text)).toEqual([P1, P3]);
    expect(requests[1].user).toMatch(/received the translation of another segment/);
    expect(allTranslated(segs)).toBe(true);
  });

  it("provedor sem conferência de idioma (demonstração): o original volta igual e é aceito", async () => {
    const meta = await keeperBook();
    const echo: TranslationProvider = {
      id: "demo",
      model: "demo",
      paid: false,
      limits: { batchChars: 50_000, concurrency: 1 },
      analyzeBook: async () => ({ profile: { genre: "", tone: "", narrativeVoice: "", styleNotes: "" }, glossary: [], tocTranslations: [] }),
      analyzeChapter: async () => ({ summary: "", newTerms: [] }),
      translateBatch: async (input: BatchInput): Promise<BatchOutput> => ({
        translations: new Map(input.segments.map((s) => [s.id, s.text])),
        truncated: false,
        refused: false,
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    };
    const h = hooks("demo/demo");
    await processChapters(meta, [meta.chapters[0]], echo, h);
    const segs = await chapterSegments(meta, meta.chapters[0]);
    expect(segs.every((s) => s.out === s.src && !s.failed)).toBe(true);
    expect(h.stats.requests).toBe(1);
  });
});

describe("troca de modelo no meio do livro: ponte de contexto", () => {
  it("começo de capítulo: leva o fim do capítulo anterior; mesmo modelo no meio do capítulo: 3 parágrafos", async () => {
    const meta = await keeperBook();
    const a = scripted((s) => answer(s));
    await processChapters(meta, [meta.chapters[0]], a.provider, hooks("fake/m1"));
    const b = scripted((s) => answer(s), "m2");
    await processChapters((await store.get(meta.id))!, [meta.chapters[1]], b.provider, hooks("fake/m2"));
    const bridge = /<preceding_translation>\n([\s\S]*?)\n<\/preceding_translation>/.exec(b.requests[0].user)![1].split("\n\n");
    // o capítulo 1 tem 7 trechos com palavras: todos cabem na ponte (até 8)
    expect(bridge).toHaveLength(7);
    expect(bridge.at(-1)).toBe("Sherlock Holmes, Baker Street, 221B, London.");
    expect(bridge[0]).toBe("O Farol");
    const ch2 = await chapterSegments(meta, meta.chapters[1]);
    expect(ch2.every((s) => s.by === "fake/m2")).toBe(true);
  });

  it("outro modelo no meio do capítulo: até 8 parágrafos; o mesmo modelo: 3", async () => {
    for (const [engine, expected] of [
      ["fake/m2", BRIDGE_PARAGRAPHS],
      ["fake/m1", 3],
    ] as const) {
      const meta = await keeperBook();
      const ch = meta.chapters[2];
      // o 1º modelo traduz o título e 10 parágrafos (como antes de a cota acabar)
      const a = scripted((s) => answer(s));
      await translateRange(meta, ch, ch.start, ch.start + 11, a.provider, hooks("fake/m1"));
      const b = scripted((s) => answer(s), engine.split("/")[1]);
      await processChapters((await store.get(meta.id))!, [ch], b.provider, hooks(engine));
      expect(b.requests).toHaveLength(1);
      const preceding = /<preceding_translation>\n([\s\S]*?)\n<\/preceding_translation>/.exec(b.requests[0].user)![1].split("\n\n");
      expect(preceding).toHaveLength(expected);
      expect(preceding.at(-1)).toMatch(/^Parágrafo 10:/);
      const segs = await chapterSegments(meta, ch);
      expect(segs.slice(0, 11).every((s) => s.by === "fake/m1")).toBe(true);
      expect(segs.slice(11).every((s) => s.by === engine)).toBe(true);
    }
  });

  it("ponte proporcional ao pedido: Groq (5000) do tamanho do contexto comum, Gemini (24000) completa", () => {
    expect(bridgeChars({ batchChars: 5000, concurrency: 1 })).toBe(1800);
    expect(bridgeChars({ batchChars: 6000, concurrency: 1 })).toBe(2160);
    expect(bridgeChars({ batchChars: 24000, concurrency: 1 })).toBe(3600);
    expect(bridgeChars({ batchChars: 1000, concurrency: 1 })).toBe(1800);
  });

  it("ponte num serviço de pedidos pequenos: cabe no limite (até 1800 caracteres)", async () => {
    const meta = await keeperBook();
    const ch = meta.chapters[2];
    await store.updateDoc(meta.id, ch.docId, (content) => {
      // parágrafos longos já traduzidos pelo 1º modelo
      for (const s of content.segments.slice(ch.start + 1, ch.start + 9))
        s.out = `${"O faroleiro subiu a escada e olhou o mar cinzento. ".repeat(10).trim()}`;
      for (const s of content.segments.slice(ch.start, ch.start + 9)) s.by = "fake/m1";
      content.segments[ch.start].out = "A Longa Noite";
    });
    const requests: LLMRequest[] = [];
    const llm: LLMClient = {
      providerId: "fake",
      model: "m2",
      async complete(req) {
        requests.push(req);
        return { text: answer(segsOf(req)), stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const provider = new LLMTranslationProvider(llm, { paid: false, limits: { batchChars: 5000, concurrency: 1 } });
    await processChapters((await store.get(meta.id))!, [ch], provider, hooks("fake/m2"));
    const bridge = /<preceding_translation>\n([\s\S]*?)\n<\/preceding_translation>/.exec(requests[0].user)![1].split("\n\n");
    expect(bridge.join("").length).toBeLessThanOrEqual(1800);
    expect(bridge.length).toBeGreaterThanOrEqual(3);
  });

  it("“leitura atenta”: a análise do capítulo falhou, mas os tokens gastos entram na conta", async () => {
    const paras = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1}: the keeper climbed the stairs once more and looked at the grey sea.`);
    paras.forEach((p, i) => (PT[p] = `Parágrafo ${i + 1}: o faroleiro subiu a escada mais uma vez e olhou para o mar cinzento.`));
    PT["The Watch"] = "A Vigília";
    const epub = await writeEpub({
      title: "Watch",
      language: "en",
      chapters: [{ title: "The Watch", body: `<h1>The Watch</h1>${paras.map((p) => `<p>${p}</p>`).join("")}` }],
    });
    const imported = await importBook(epub, { fileName: "watch.epub", targetLanguage: "pt-BR" });
    await store.update(imported.id, (m) => {
      m.options.deepContext = true;
    });
    const meta = (await store.get(imported.id))!;
    const usage: { inputTokens: number; outputTokens: number }[] = [];
    const requests: LLMRequest[] = [];
    const llm: LLMClient = {
      providerId: "fake",
      model: "m1",
      async complete(req) {
        requests.push(req);
        if (req.purpose === "analysis") return { text: '{"summary": "Um', stopReason: "max_tokens", usage: { inputTokens: 700, outputTokens: 300 } };
        return { text: answer(segsOf(req)), stopReason: "end", usage: { inputTokens: 10, outputTokens: 10 } };
      },
    };
    const provider = new LLMTranslationProvider(llm, { paid: false, limits: { batchChars: 50_000, concurrency: 1 } });
    await processChapters(meta, [meta.chapters[0]], provider, {
      ...hooks(),
      onUsage: async (u: { inputTokens: number; outputTokens: number }) => {
        usage.push(u);
      },
    });
    expect(requests.map((r) => r.purpose)).toEqual(["analysis", "translation"]);
    expect(usage).toEqual([
      { inputTokens: 700, outputTokens: 300 },
      { inputTokens: 10, outputTokens: 10 },
    ]);
    expect(allTranslated(await chapterSegments(meta, meta.chapters[0]))).toBe(true);
    expect((await store.get(meta.id))!.chapters[0].summary).toBe("");
  });

  it("nomes novos inventados pelo modelo não entram no glossário", async () => {
    const { meta } = await run(
      (s) => `${answer(s)}\n<new_terms>\nPorto Velho => Porto Velho | place\nAtlantis => Atlântida | place\n</new_terms>`,
      1,
    );
    const terms = (await store.readGlossary(meta.id)).map((g) => g.term);
    expect(terms).toContain("Porto Velho");
    expect(terms).not.toContain("Atlantis");
  });
});
