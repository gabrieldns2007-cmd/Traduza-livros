/**
 * Conferência de cada trecho traduzido, antes de gravar.
 *
 * Pura (nada do Node): roda no servidor e no motor do navegador. Pega os
 * defeitos que aparecem quando o modelo muda no meio do livro — sobretudo nos
 * modelos gratuitos mais fracos — sem barrar o que é legítimo: versos curtos,
 * títulos, números, nomes próprios, texto que já estava em português, frases
 * que o autor deixou em outro idioma, endereços, código e referências
 * bibliográficas (o prompt manda manter tudo isso como está).
 *
 *  - `hard`: o trecho não é gravado. Vai numa única nova tentativa só dele, com
 *    o motivo no pedido; se falhar de novo, fica marcado para revisão.
 *  - `soft`: o trecho é gravado e o aviso fica anotado (tamanho fora do comum,
 *    formatação perdida na nova tentativa, jeito de português de Portugal).
 *
 * Cada recusa errada gasta um pedido da cota grátis e pode deixar o original no
 * livro: na dúvida, a regra deixa passar.
 */
import { francAll } from "franc-min";
import { data as FRANC_DATA } from "franc-min/data.js";
import { expressions as FRANC_SCRIPTS } from "franc-min/expressions.js";
import { findLanguage } from "@/lib/languages";
import { tagKeys, toPlainText } from "@/lib/markup";

export type HardIssue =
  /** voltou sem nenhuma letra */
  | "empty"
  /** pedaço do pedido (<seg>, <context>, <think>…) dentro da tradução */
  | "leak"
  /** tag HTML ou Markdown que não existe no original */
  | "stray-tag"
  /** letras de outra escrita (chinês, cirílico…) que não estão no original */
  | "foreign-script"
  /** “Aqui está a tradução:”, “(Nota: …)”, pedido de desculpas no lugar do texto */
  | "commentary"
  /** voltou igual ao original */
  | "echo"
  /** boa parte voltou sem traduzir */
  | "partial-echo"
  /** ficou no idioma de origem (ou escorregou para espanhol, italiano…) */
  | "wrong-language"
  /** tamanho impossível para uma tradução (pedaço cortado ou texto inventado) */
  | "length";

export type SoftIssue =
  /** tamanho fora do comum, mas possível */
  | "ratio"
  /** formatação perdida (aceita na nova tentativa) */
  | "fmt-lost"
  /** tags soltas removidas na nova tentativa */
  | "stray-tag"
  /** jeito de português de Portugal num livro em português do Brasil */
  | "pt-PT";

export interface QualityContext {
  /** idioma do original (código BCP-47); sem ele, a conferência de idioma não roda */
  sourceLang?: string | null;
  targetLang: string;
  /**
   * confere também o idioma (voltou igual ao original, ficou no idioma de origem).
   * Padrão: sim. O provedor de demonstração devolve o original de propósito.
   */
  languageChecks?: boolean;
}

export interface SegmentCheck {
  hard?: HardIssue;
  soft: SoftIssue[];
}

/** Só com isto de letras o detector de idioma é confiável (“Hmm, I see.” sai como português). */
export const LANGUAGE_MIN_LETTERS = 60;

/** Abaixo disto (versos, títulos, “Sim.”) a proporção de tamanho não serve como prova. */
export const RATIO_MIN_CHARS = 80;

/** Tradução / original, em letras e números, entre idiomas de alfabeto latino (inglês → português ≈ 1,1). */
const EXPECTED_RATIO = 1.1;

/** Idiomas que o detector compara para saber se um trecho está mesmo no idioma de origem. */
const COMMON = ["eng", "por", "spa", "fra", "ita", "deu", "nld"];

/** Idiomas para os quais um modelo costuma escorregar no lugar do idioma pedido (“La señora Wilson se levantó…”). */
const DRIFT = ["por", "spa", "ita", "fra", "cat", "deu"];

/** Idiomas que o detector conhece (o franc-min não tem catalão, dinamarquês, finlandês…: sem conferência de idioma). */
const DETECTABLE = new Set([...Object.values(FRANC_DATA).flatMap((langs) => Object.keys(langs)), ...Object.keys(FRANC_SCRIPTS)]);

const LEAK =
  /<\/?(?:seg|new_terms|context|glossary|story_so_far|current_chapter|preceding_translation|think|book)(?![\p{L}\p{N}_])|<\|[a-z_]{2,24}\|>/iu;

const STRAY_TAG = /<\/?(?:em|i|b|strong|u|s|br|p|span|a|sup|sub|small|q|cite|div|font)(?:\s[^<>]*)?\/?>/i;
const MARKDOWN = /(?<![\p{L}\p{N}*])\*{1,2}(?=[\p{L}\p{N}])[^*\n]{0,80}?[\p{L}\p{N}.!?,]\*{1,2}(?![\p{L}\p{N}*])/u;

const FOREIGN_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Thai}\p{Script=Devanagari}]/gu;
const DENSE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const NON_LATIN_TARGET = /^(?:el|ru|uk|be|bg|sr|mk|ja|zh|ko|ar|he|fa|ur|th|hi)(?:-|$)/i;

/* ---------- comentários do modelo ---------- */

/** “tradução”, “translation” e parentes */
const TR = "(?:tradu[çc](?:ão|ões|ao|oes)|traduzid[oa]s?|translations?|translated)";

/**
 * O pedido de desculpas fala da tarefa (“não posso traduzir este trecho”), e não de uma
 * cena do livro (“Sinto muito frio, mas não consigo mexer as pernas”).
 */
const TASK =
  "(?:traduz\\p{L}*|tradu[çc]\\p{L}*|translat\\p{L}*|(?:este|esse|esta|essa) (?:texto|trecho|conteúdo|pedido|passagem|solicitação)|this (?:text|passage|content|request|excerpt)|ajudar com (?:isso|isto)|(?:help|assist) (?:you )?with (?:this|that))";

/** O original começa com um rótulo (“Literal meaning:”, “Note:”): o rótulo traduzido não é comentário. */
const LABEL_START = /^\s*[\p{L}.'’ ]{1,25}:/u;
/** Rótulo entre parênteses ou colchetes no original: “(N.B.: …)”, “[Trans.: …]”, “(Remark: …)”. */
const BRACKET_LABEL = /[([]\s*[\p{L}.'’ ]{1,25}:/u;
/** Rótulo no começo de uma frase do original (“… dobre o papel. Note: não rasgue.”). */
const SENTENCE_LABEL = /(?:^|[.!?…"”»)\]]\s+|\n\s*)[\p{L}.'’ ]{1,25}:/u;

/**
 * Comentários que o modelo acrescenta. Um trecho só é barrado se a regra não vale também
 * para o original (a fala “I'm sorry, I can't translate this” existe em romances) e se o
 * original não tem um rótulo parecido (`skip`).
 */
const COMMENTARY: { re: RegExp; skip?: RegExp }[] = [
  // “Aqui está a tradução:”, “Here's the translation:”, “Claro! Segue a tradução do trecho:”. Precisa
  // dos dois-pontos logo depois: “Segue uma tradução livre do poema.” é uma frase do livro
  {
    re: new RegExp(
      `^\\s*(?:(?:claro|certo|com certeza|sure|of course|certainly)\\s*[!,.]\\s*)?(?:aqui (?:está|estão|vai|segue)|segue(?:m)?|eis|abaixo (?:está|estão|segue)|here(?:'s|’s| is| are)|below (?:is|are))(?![\\p{L}])[^\\n.:]{0,40}?(?<![\\p{L}])${TR}(?![\\p{L}])[^\\n.:!?]{0,30}:`,
      "iu",
    ),
  },
  // “Claro! Aqui está:”, “Sure! Here it is:”
  {
    re: /^\s*(?:claro|certo|com certeza|sure|of course|certainly)\s*[!,.]\s*(?:aqui (?:está|estão|vai)|segue|eis|here(?:'s|’s| is| are| you go| it is))[^\n:]{0,30}:/iu,
  },
  // “Tradução:”, “Translation (pt-BR):”, “Tradução de “He nodded.”:” no começo
  { re: /^\s*(?:tradu[çc](?:ão|ao)|translation)\s*(?:\([^)]{0,30}\)|(?:de|do|da|of)\s[^\n:]{1,200}?)?\s*:/iu, skip: LABEL_START },
  // nota do tradutor entre parênteses ou colchetes: “(Nota: …)”, “(N. do T.)”, “[Translator's note]”
  { re: /[([]\s*(?:nota|note|n\.\s?b\.)\s*(?:d[oa]s?\s+tradu\p{L}*|of the translator|du traducteur|del traductor)?\s*:/iu, skip: BRACKET_LABEL },
  { re: /[([]\s*(?:nota d[oa]s? tradu\p{L}*|translator['’]?s note|n\.\s?(?:d[oa]\s?)?t\.)/iu, skip: BRACKET_LABEL },
  // nota solta depois do texto: “… na Rua 158.\nNota do tradutor: mantive o nome da rua.”
  {
    re: /(?:[.!?…"”»)\]]\s+|\n\s*)(?:nota(?:\s+d[oa]s?\s+tradu\p{L}*)?|n\.\s?(?:d[oa]\s?)?t\.|n\.\s?b\.|notes?|translator['’]?s notes?|obs(?:ervação)?\.?)\s*:/iu,
    skip: SENTENCE_LABEL,
  },
  // pedido de desculpas no lugar da tradução (falando da tarefa)
  {
    re: new RegExp(
      `^\\s*(?:desculpe|perdão|sinto muito|lamento|infelizmente|i['’]?m sorry|i am sorry|sorry|unfortunately|i apologi[sz]e)(?![\\p{L}])[^\\n]{0,80}?(?<![\\p{L}])(?:não posso|não consigo|não é possível|não seria possível|can(?:no|['’])t|cannot|unable|not able|won['’]t be able)(?![\\p{L}])[^\\n]{0,60}?(?<![\\p{L}])${TASK}`,
      "iu",
    ),
  },
  {
    re: /^\s*(?:i can(?:no|['’])t|i cannot|i['’]?m unable to|i am unable to|i['’]?m not able to|não (?:posso|consigo|é possível)) (?:help (?:you )?(?:with )?translat|translat|provide (?:a |the )?translation|traduzir|ajudar com (?:a |esta |essa )?tradução|fornecer (?:a |uma )?tradução)/iu,
  },
  // “Como modelo de linguagem, não posso…”
  {
    re: /(?:^|[.!?…]\s+|\n\s*)(?:como|sendo|as|being)\s+(?:an?\s+|um\s+)?(?:AI\s+|IA\s+)?(?:language model|modelo de linguagem|modelo de IA|AI model|assistente de IA|AI assistant)/iu,
  },
];

/* ---------- português de Portugal ---------- */

/** Marcas de português de Portugal × do Brasil (fronteiras com Unicode: /\bVocê\b/ falha em JS). */
const word = (s: string) => new RegExp(`(?<![\\p{L}])(?:${s})(?![\\p{L}])`, "giu");
const PT_PT = [
  // “estava a fazer”; não “estava a par”, “ficou a ver navios” (expressões do Brasil também)
  word(
    "(?:estou|estás|está|estamos|estão|estava|estavas|estávamos|estavam|esteve|andava|anda|andavam|ficou|ficava|ficaram)\\s+a\\s+(?!par(?![\\p{L}])|ver navios)\\p{L}+(?:ar|er|ir)",
  ),
  // “de facto” é latim (e jurídico) no Brasil também: não conta
  word(
    "comboios?|raparigas?|autocarros?|telemóve(?:l|is)|ecrãs?|pequeno-almoço|frigoríficos?|casa de banho|miúd[oa]s?|(?<!de\\s)factos?|contactos?|receção|óptim[oa]s?|actua(?:l|is)|acção|direcção",
  ),
];
const PT_BR = [
  word("(?:estou|está|estamos|estão|estava|estávamos|estavam|esteve|ficou|ficava)\\s+\\p{L}+ndo"),
  word(
    "vocês?|ônibus|trens?|garotas?|celulares?|café da manhã|geladeiras?|banheiros?|fatos?|contatos?|recepção|ótim[oa]s?|atua(?:l|is)|ação|direção",
  ),
];

/* ---------- idioma ---------- */

/**
 * Palavras funcionais (artigos, pronomes, auxiliares) de cada idioma de origem, sem as que
 * existem também em português, latim ou outro idioma próximo (“a”, “in”, “per”, “et”, “do”…).
 * Em trechos curtos, onde o detector erra, são elas que dizem se o texto está mesmo no
 * idioma de origem: “It was cold.” sim; “Mais oui, mon ami!” e “per aspera ad astra” não.
 */
const FUNCTION_WORDS: Record<string, Set<string>> = Object.fromEntries(
  Object.entries({
    eng: "the and of to is are were he she you it its that with for not my his him they them their we our us this these those what have has had been be would could should there from but your who which when where why how into upon than then if don't can't won't didn't doesn't isn't wasn't aren't weren't couldn't wouldn't shouldn't haven't hasn't hadn't i'm i've i'll i'd you're you've you'll it's that's there's he's she's let's we're they're",
    spa: "el los las y yo él ella ellos ellas nosotros usted ustedes mis más ya hay qué cuando también aquí eso esto esa fue estaba había soy eres somos tengo tiene pues donde entonces están muy pero",
    fra: "les une elle ils elles je nous vous pas dans avec pour sur cette était sont au aux très c'est j'ai n'est qu'il d'un suis avait être ont leur votre notre moi toi",
    ita: "gli della delle degli che è sono questo questa quella quello anche molto più perché io lei noi voi loro siamo hanno nel nella dal dalla alla alle sul",
    deu: "der das und ist nicht ich sie wir ihr ein eine einen dem mit auf für von zu im sind wie aber auch noch nur sehr schon dass",
  }).map(([lang, list]) => [lang, new Set(list.split(" "))]),
);

const letters = (s: string) => s.match(/\p{L}/gu)?.length ?? 0;
/** letras e números: pontuação (reticências, travessões, aspas) varia muito entre idiomas */
const size = (s: string) => s.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
const count = (s: string, res: RegExp[]) => res.reduce((n, re) => n + (s.match(re)?.length ?? 0), 0);
const tokens = (s: string) => s.match(/[\p{L}\p{N}]+(?:['’]\p{L}+)*/gu) ?? [];
/** palavra comparável: minúscula, NFC, apóstrofo reto */
const fold = (w: string) =>
  w
    .normalize("NFC")
    .replace(/[’‘`´]/g, "'")
    .toLowerCase();
/** as palavras do texto, comparáveis: ignora aspas, travessões, reticências e maiúsculas */
const words = (s: string) => tokens(s.normalize("NFC")).map(fold);
/** palavras de 3+ letras que começam com minúscula: frase de verdade, não lista de nomes */
const commonWords = (s: string) => s.match(/(?<![\p{L}\p{N}])\p{Ll}\p{L}{2,}/gu)?.length ?? 0;
/** TEXTO EM CAIXA ALTA vira minúsculo (para a regra das palavras comuns) */
const caseless = (s: string) => (/\p{Ll}/u.test(s) ? s : s.toLowerCase());

function normalize(s: string): string {
  return s
    .normalize("NFC")
    .replace(/[“”„«»"]/g, '"')
    .replace(/[‘’`']/g, "'")
    .replace(/[—–‐]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Código ISO 639-3 do detector; português de Portugal também é "por"; latim e “auto” não têm. */
function iso3(code: string | null | undefined): string | undefined {
  if (!code) return undefined;
  const c = code.trim().toLowerCase();
  if (c === "pt" || c.startsWith("pt-") || c.startsWith("pt_")) return "por";
  return findLanguage(code)?.iso3;
}

/** Idiomas do mais provável ao menos provável (o primeiro tem nota 1). */
function ranking(text: string, only: string[]): [string, number][] {
  return francAll(text, { minLength: 1, only: [...new Set(only)] });
}

function scores(text: string, only: string[]): Record<string, number> {
  return Object.fromEntries(ranking(text, only));
}

/** O trecho está mesmo no idioma de origem (e não é uma citação em francês, latim, ou texto já em português)? */
function inSourceLanguage(text: string, src: string, tgt: string): boolean {
  if (letters(text) < 20) return true; // curto demais para o detector: vale a regra das palavras comuns
  return (scores(text, [src, tgt, ...COMMON])[src] ?? 0) >= 0.9;
}

/**
 * O texto está escrito no idioma de origem do livro (e não é um nome, um título ou uma
 * frase em outro idioma que o autor deixou sem traduzir)?
 *  - curto (menos de 60 letras, onde o detector erra): precisa de uma palavra funcional do
 *    idioma de origem e de uma palavra comum em minúscula. “She smiled at him.” sim;
 *    “THE GREAT GATSBY”, “The Old Man and the Sea”, “Mais oui, mon ami!” e “Tudo bem,
 *    meu amor?” não;
 *  - longo: 3 ou mais palavras comuns e o detector confirma o idioma de origem.
 */
function looksLikeSource(text: string, src: string, tgt: string): boolean {
  const fw = FUNCTION_WORDS[src];
  if (fw && letters(text) < LANGUAGE_MIN_LETTERS) {
    const ws = tokens(text.normalize("NFC"));
    return ws.some((w) => fw.has(fold(w))) && ws.some((w) => /^\p{Ll}/u.test(w) && !fw.has(fold(w)));
  }
  const t = caseless(text);
  return commonWords(t) >= 3 && inSourceLanguage(t, src, tgt);
}

/** Código (<code_3>…</code_3>, <kbd_4>…</kbd_4>): fica igual de propósito. */
const CODE = /<(code|kbd|samp|tt|var|pre)_(\d+)>[\s\S]*?<\/\1_\2>/gi;

/** Endereços, e-mails, DOI e ISBN: o prompt manda manter como estão. */
const VERBATIM = [
  /(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>"“”‘’]+/gi,
  /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu,
  /\bdoi:\s*\S+|\b10\.\d{4,9}\/[^\s<>"“”]+/gi,
  /\bISBN(?:-?1[03])?\s*:?\s*[\dXx](?:[\s-]?[\dXx]){9,12}/gi,
  /\b97[89](?:[\s-]?\d){10}\b/g,
];

/** Texto puro sem o que fica igual de propósito (código, endereços, e-mails, DOI, ISBN). */
function translatable(markup: string): string {
  let t = toPlainText(markup.replace(CODE, " "));
  for (const re of VERBATIM) t = t.replace(re, " ");
  return t;
}

/**
 * Referência bibliográfica: os títulos ficam no idioma original (“Kahneman, D. (2011).
 * Thinking, fast and slow. New York: Farrar…”), então não conta como “sem traduzir”.
 */
const REFERENCE = [
  // (1998), (2011a)
  /\(\s*(?:c\.\s*)?(?:1[4-9]|20)\d{2}[a-z]?\s*\)/,
  // pp. 23, vol. 2, ch. 3
  /(?<![\p{L}])(?:pp?|vols?|chap|ch)\.\s*[\dIVXLC]/iu,
  // 2nd ed., (eds.), et al.
  /\d(?:st|nd|rd|th)\s+ed\.|\(eds?\.\)|(?<![\p{L}])et al\./iu,
  /(?<![\p{L}])(?:ibid|op\.\s*cit|loc\.\s*cit)(?![\p{L}])/iu,
  // “Smith, J. …”, “Gould, S. J. …” no começo
  /^\s*\p{Lu}[\p{L}'’-]+(?:\s\p{Lu}[\p{L}'’-]+)?,\s+(?:\p{Lu}\.\s?){1,3}/u,
  // “New York: Random House, 1998”
  /(?<![\p{L}])\p{Lu}\p{L}+(?:\s\p{Lu}\p{L}+)?:\s*\p{Lu}[^.:]{2,60}?,\s*(?:1[4-9]|20)\d{2}(?!\d)/u,
  // “See also: …”, “Further reading: …”, “See John Smith, …”
  /^\s*(?:see also|further reading|works cited|bibliography|references|sources)\s*:/iu,
  /^\s*(?:[Ss]ee|[Cc]f\.?)\s+(?:also\b|(?:\p{Lu}[\p{L}.'’-]*\s+){1,3}\p{Lu}[\p{L}'’-]+,)/u,
];

function isReference(text: string): boolean {
  return REFERENCE.some((re) => re.test(text));
}

/**
 * Metade ou mais das sequências de 6 palavras do original voltaram iguais (originais com 12+ palavras).
 * Devolve as palavras do original cobertas por elas, na grafia original.
 */
function sharedWords(src: string, out: string): string | undefined {
  const a = tokens(src);
  if (a.length < 12) return undefined;
  const b = words(out);
  const grams = new Set<string>();
  for (let i = 0; i + 6 <= b.length; i++) grams.add(b.slice(i, i + 6).join(" "));
  const lower = a.map(fold);
  const covered = new Array<boolean>(a.length).fill(false);
  let hits = 0;
  for (let i = 0; i + 6 <= a.length; i++) {
    if (!grams.has(lower.slice(i, i + 6).join(" "))) continue;
    hits++;
    for (let j = i; j < i + 6; j++) covered[j] = true;
  }
  if (hits * 2 < a.length - 5) return undefined;
  return a.filter((_, i) => covered[i]).join(" ");
}

/**
 * Idioma mais provável de um texto, quando não é o pedido. Com `margin`, só quando o pedido
 * fica bem atrás (nota abaixo de 0,9): português e espanhol se parecem muito.
 */
function otherLanguage(text: string, langs: string[], tgt: string, margin = true): string | undefined {
  const rank = ranking(text, langs);
  const top = rank[0]?.[0];
  if (!top || top === "und" || top === tgt) return undefined;
  return !margin || (rank.find(([l]) => l === tgt)?.[1] ?? 0) < 0.9 ? top : undefined;
}

function languageIssue(srcMarkup: string, outMarkup: string, ctx: QualityContext): HardIssue | undefined {
  const src = iso3(ctx.sourceLang);
  const tgt = iso3(ctx.targetLang);
  if (!src || !tgt || src === tgt) return undefined;
  const a = translatable(srcMarkup);
  const b = translatable(outMarkup);
  // referência bibliográfica: títulos e nomes ficam no original
  if (isReference(a)) return undefined;
  const wa = words(a);
  const wb = words(b);
  if (wa.length && wa.join(" ") === wb.join(" ")) {
    // nomes, endereços e títulos (“Sherlock Holmes, Baker Street, 221B.”) podem ficar iguais
    return looksLikeSource(a, src, tgt) ? "echo" : undefined;
  }
  if (letters(a) < LANGUAGE_MIN_LETTERS) {
    // verso ou fala curta devolvida quase igual (“upon” no lugar de “on”): 3/4 das palavras do original
    const known = new Set(wa);
    const out = wb.filter((w) => /\p{L}/u.test(w));
    const fw = FUNCTION_WORDS[src];
    const english = fw ? out.filter((w) => fw.has(w)).length >= 2 : true; // “Tradução copyright by Harper” não
    if (out.length >= 3 && english && out.filter((w) => known.has(w)).length * 4 >= out.length * 3 && looksLikeSource(b, src, tgt)) return "echo";
  }
  const shared = sharedWords(a, b);
  if (shared && looksLikeSource(shared, src, tgt)) return "partial-echo";
  // frase de verdade (não um título ou uma lista de nomes que fica em inglês)
  if (DETECTABLE.has(tgt) && letters(b) >= LANGUAGE_MIN_LETTERS && commonWords(caseless(b)) >= 4) {
    const langs = [tgt, src, ...DRIFT];
    const top = otherLanguage(b, langs, tgt);
    if (top && inSourceLanguage(caseless(a), src, tgt)) {
      if (top === src) return "wrong-language";
      // outro idioma (espanhol, italiano…): confere sem as palavras que vieram do original
      // (uma citação em francês que o autor deixou no texto não conta)
      const known = new Set(wa);
      const rest = tokens(b)
        .filter((w) => !known.has(fold(w)))
        .join(" ");
      if (letters(rest) >= 30 && otherLanguage(rest, langs, tgt, false)) return "wrong-language";
    }
  }
  return undefined;
}

function isCommentary(a: string, b: string): boolean {
  return COMMENTARY.some(({ re, skip }) => re.test(b) && !re.test(a) && !skip?.test(a));
}

/** Escrita “densa” (chinês, japonês, coreano): uma letra vale várias, a proporção de tamanho não se aplica. */
function isDense(text: string): boolean {
  return (text.match(DENSE_SCRIPT)?.length ?? 0) * 3 > letters(text);
}

/**
 * Confere um trecho traduzido. `src` e `outMarkup` estão na marcação compacta
 * (ver lib/markup.ts); `outMarkup` pode ser a resposta crua ou já consertada.
 */
export function checkSegment(src: string, outMarkup: string, ctx: QualityContext): SegmentCheck {
  const soft: SoftIssue[] = [];
  const a = toPlainText(src);
  const b = toPlainText(outMarkup);
  const fail = (hard: HardIssue): SegmentCheck => ({ hard, soft });

  if (!/\p{L}/u.test(b) && /\p{L}/u.test(a)) return fail("empty");
  if (LEAK.test(b) && !LEAK.test(a)) return fail("leak");
  if ((STRAY_TAG.test(b) && !STRAY_TAG.test(a)) || (MARKDOWN.test(b) && !a.includes("*"))) return fail("stray-tag");
  if (!NON_LATIN_TARGET.test(ctx.targetLang) && (b.match(FOREIGN_SCRIPT) ?? []).some((ch) => !a.includes(ch))) return fail("foreign-script");
  if (isCommentary(a, b)) return fail("commentary");
  if (ctx.languageChecks !== false) {
    const issue = languageIssue(src, outMarkup, ctx);
    if (issue) return fail(issue);
  }

  const denseTarget = findLanguage(ctx.targetLang)?.script === "cjk";
  if (a.length >= RATIO_MIN_CHARS && !denseTarget && !isDense(a)) {
    const r = size(b) / Math.max(1, size(a)) / EXPECTED_RATIO;
    if (r < 0.35 || r > 2.8) return fail("length");
    if (r < 0.6 || r > 1.8) soft.push("ratio");
  } else if (b.length > a.length * 6 + 40) {
    // verso, título, “Sim.”: só barra o que é claramente texto a mais
    return fail("length");
  }

  const outKeys = tagKeys(outMarkup);
  if ([...tagKeys(src)].some((k) => !outKeys.has(k))) soft.push("fmt-lost");
  if (/^pt(?:-br)?$/i.test(ctx.targetLang)) {
    const pt = count(b, PT_PT);
    if (pt >= 2 && pt > 2 * count(b, PT_BR)) soft.push("pt-PT");
  }
  return { soft };
}

/**
 * Tira tags HTML e ênfase Markdown soltas da marcação (o que sobra quando o modelo
 * escreve <em>…</em> em vez de <em_3>…</em_3>). Usado na nova tentativa: nunca
 * gravar tags literais no livro.
 */
export function stripStrayTags(markup: string): string {
  return markup
    .replace(/&lt;br\s*\/?&gt;/gi, " ")
    .replace(/&lt;\/?(?:em|i|b|strong|u|s|p|span|a|sup|sub|small|q|cite|div|font)(?:\s(?:(?!&gt;)[^<>])*)?\/?&gt;/gi, "")
    .replace(/(?<![\p{L}\p{N}*])\*{1,2}(?=[\p{L}\p{N}])([^*\n<>]{0,80}?[\p{L}\p{N}.!?,])\*{1,2}(?![\p{L}\p{N}*])/gu, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Trechos de um mesmo pedido que receberam a mesma tradução (20+ caracteres) que
 * outro trecho de original diferente: o modelo se perdeu na ordem. `cases` conta as
 * repetições (um par = 1). Originais que só diferem em pontuação ou maiúsculas não contam.
 */
export function repeatedOutputs(pairs: { src: string; out?: string }[]): { indexes: Set<number>; cases: number } {
  const groups = new Map<string, { idx: number[]; srcs: Set<string> }>();
  pairs.forEach((p, idx) => {
    if (p.out === undefined) return;
    const out = normalize(toPlainText(p.out));
    if (out.length < 20) return;
    const g = groups.get(out) ?? { idx: [], srcs: new Set<string>() };
    g.idx.push(idx);
    g.srcs.add(
      toPlainText(p.src)
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .toLowerCase(),
    );
    groups.set(out, g);
  });
  const indexes = new Set<number>();
  let cases = 0;
  for (const g of groups.values()) {
    if (g.srcs.size < 2) continue;
    cases += g.idx.length - 1;
    for (const i of g.idx) indexes.add(i);
  }
  return { indexes, cases };
}
