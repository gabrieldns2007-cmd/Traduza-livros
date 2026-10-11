/**
 * Espaços de publicidade (configurados no painel → Anúncios).
 *
 * Desligados por padrão: nada muda no site até o dono ligar. Quando ligados,
 * aparecem no máximo um por página, sempre identificados como “Publicidade”, e
 * só nos lugares desta lista — nunca no pagamento, na confirmação do pedido, na
 * leitura/revisão do livro, no painel, na entrada, nos termos ou na
 * privacidade. A lista é a única forma de existir um espaço: os testes
 * conferem que nenhuma outra página mostra anúncio.
 *
 * Módulo puro (sem disco nem rede): usado pelo servidor e pelo painel.
 */

export const AD_PLACEMENTS = ["home", "precos", "livros", "traduzindo", "pronto"] as const;
export type AdPlacement = (typeof AD_PLACEMENTS)[number];

export const AD_PLACEMENT_INFO: Record<AdPlacement, { label: string; where: string; defaultOn: boolean }> = {
  home: { label: "Página inicial", where: "No fim da página, depois do último botão. Nunca no topo.", defaultOn: true },
  precos: { label: "Preços", where: "No fim da página. Desligado de início: é onde a pessoa decide comprar.", defaultOn: false },
  livros: { label: "Meus livros", where: "Abaixo da estante, só quando já há livros nela (nunca na estante vazia).", defaultOn: true },
  traduzindo: {
    label: "Livro sendo traduzido",
    where: "No fim da página, enquanto a tradução anda. Desligado de início: o Google é rigoroso com anúncios em telas de espera.",
    defaultOn: false,
  },
  pronto: { label: "Livro pronto", where: "No fim da página, depois dos downloads e da lista de capítulos, nunca entre os botões.", defaultOn: true },
};

/**
 * Qual espaço a página do livro mostra, conforme a etapa: durante a tradução
 * ou com o livro pronto (sempre no fim da página). Nunca no pedido (“ready”:
 * preço e pagamento), com erro nem pausado — nesses casos a pessoa precisa
 * agir (“Continuar tradução”), e o anúncio ficaria colado no botão.
 */
export function bookAdPlacement(status: string): "traduzindo" | "pronto" | null {
  if (status === "queued" || status === "analyzing" || status === "translating") return "traduzindo";
  return status === "done" ? "pronto" : null;
}

/** Configuração salva em data/settings.json (painel → Anúncios). */
export interface AdsSettings {
  /** chave geral; desligado por padrão */
  enabled?: boolean;
  /** quem preenche os espaços */
  source?: "adsense" | "house";
  adsense?: {
    /** código do editor, sempre como “ca-pub-…” */
    publisherId?: string;
    /** número do bloco de anúncio (data-ad-slot) usado em todos os lugares */
    slotId?: string;
    /** um bloco diferente por lugar (opcional) */
    slots?: Partial<Record<AdPlacement, string>>;
  };
  /** anúncio de um patrocinador direto, escrito pelo dono */
  house?: { title?: string; text?: string; url?: string; imageUrl?: string; cta?: string; sponsor?: string };
  /** lugares ligados; sem valor, vale o padrão de AD_PLACEMENT_INFO */
  placements?: Partial<Record<AdPlacement, boolean>>;
  /** quando o aviso de publicidade mudou (aparece como “Última atualização” nos termos e na privacidade) */
  updatedAt?: string;
}

/** O que a página recebe para desenhar um espaço — nunca as configurações inteiras (elas guardam chaves). */
export type AdConfig =
  | { kind: "adsense"; client: string; slot: string }
  | { kind: "house"; title: string; text?: string; url: string; imageUrl?: string; cta: string; sponsor?: string };

// o código do editor tem sempre 16 algarismos: um a mais ou a menos é erro de digitação
const PUBLISHER_RE = /(?:ca-)?pub-(\d{16})(?!\d)/i;
const SLOT_RE = /^\d{6,20}$/;

/**
 * Código do editor a partir do que o dono colar: “pub-…”, “ca-pub-…” ou até o
 * trecho de código inteiro do AdSense. Devolve “ca-pub-…”, "" (apagar) ou null
 * (não dá para entender).
 */
export function pickPublisherId(text: string): string | null {
  const t = text.trim();
  if (!t) return "";
  const m = PUBLISHER_RE.exec(t);
  return m ? `ca-pub-${m[1]}` : null;
}

/** Número do bloco a partir do número puro ou do código do bloco (data-ad-slot="…"). */
export function pickSlotId(text: string): string | null {
  const t = text.trim();
  if (!t) return "";
  if (SLOT_RE.test(t)) return t;
  const m = /data-ad-slot\s*=\s*["']?(\d{6,20})/i.exec(t);
  return m ? m[1] : null;
}

/** Endereço aceito num anúncio: http(s) para o link, só https para a imagem (sem conteúdo misto). */
export function safeUrl(url: string | undefined, httpsOnly = false): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    const ok = httpsOnly ? u.protocol === "https:" : u.protocol === "https:" || u.protocol === "http:";
    return ok && u.hostname.includes(".") ? u.href : undefined;
  } catch {
    return undefined;
  }
}

export function placementOn(ads: AdsSettings | undefined, placement: AdPlacement): boolean {
  return ads?.placements?.[placement] ?? AD_PLACEMENT_INFO[placement].defaultOn;
}

/** Código do editor válido (para o ads.txt e a verificação do site), mesmo com os anúncios desligados. */
export function adsensePublisher(ads: AdsSettings | undefined): string | null {
  const id = pickPublisherId(ads?.adsense?.publisherId ?? "");
  return id || null;
}

/** O anúncio de um lugar, ou null quando não deve aparecer nada. */
export function resolveAd(ads: AdsSettings | undefined, placement: AdPlacement): AdConfig | null {
  if (!ads?.enabled || !placementOn(ads, placement)) return null;
  if (ads.source === "house") {
    const h = ads.house ?? {};
    const url = safeUrl(h.url);
    if (!h.title || !url) return null;
    return {
      kind: "house",
      title: h.title,
      text: h.text || undefined,
      url,
      imageUrl: safeUrl(h.imageUrl, true),
      cta: h.cta || "Saiba mais",
      sponsor: h.sponsor || undefined,
    };
  }
  // AdSense: só blocos de anúncio fixos, nunca “anúncios automáticos” (sem bloco, nada aparece)
  const client = adsensePublisher(ads);
  const slot = pickSlotId(ads.adsense?.slots?.[placement] || ads.adsense?.slotId || "");
  if (!client || !slot) return null;
  return { kind: "adsense", client, slot };
}

/** Partes do aviso nos termos e na privacidade; null quando nenhum anúncio pode aparecer. */
export function adsDisclosure(ads: AdsSettings | undefined): { adsense: boolean; house: boolean } | null {
  if (!ads?.enabled || !AD_PLACEMENTS.some((p) => placementOn(ads, p))) return null;
  const house = ads.source === "house";
  return { adsense: !house, house };
}

/** O que o painel envia (os campos vazios apagam o valor salvo). */
export type AdsPatch = Omit<AdsSettings, "updatedAt">;

const clean = (s: string | undefined) => s?.trim() || undefined;

function cleanRecord<T>(r: Partial<Record<AdPlacement, T>>, keep: (v: T) => boolean) {
  const out: Partial<Record<AdPlacement, T>> = {};
  for (const p of AD_PLACEMENTS) if (r[p] !== undefined && keep(r[p] as T)) out[p] = r[p];
  return Object.keys(out).length ? out : undefined;
}

/**
 * Junta o que foi salvo com o que o painel enviou: tira espaços, apaga campos
 * vazios, escreve o código do editor como “ca-pub-…” e marca a data quando o
 * aviso de publicidade muda (ligar, desligar ou trocar de fornecedor).
 */
export function normalizeAds(current: AdsSettings | undefined, patch: AdsPatch, now = new Date()): AdsSettings {
  const cur = current ?? {};
  const adsense = { ...cur.adsense, ...patch.adsense };
  const slots = { ...cur.adsense?.slots, ...patch.adsense?.slots };
  const house = { ...cur.house, ...patch.house };
  const next: AdsSettings = {
    enabled: patch.enabled ?? cur.enabled ?? false,
    source: patch.source ?? cur.source ?? "adsense",
    adsense: {
      publisherId: pickPublisherId(adsense.publisherId ?? "") || undefined,
      slotId: pickSlotId(adsense.slotId ?? "") || undefined,
      slots: cleanRecord(slots, (v) => Boolean(pickSlotId(v ?? ""))),
    },
    house: {
      title: clean(house.title),
      text: clean(house.text),
      url: clean(house.url),
      imageUrl: clean(house.imageUrl),
      cta: clean(house.cta),
      sponsor: clean(house.sponsor),
    },
    placements: cleanRecord({ ...cur.placements, ...patch.placements }, () => true),
    updatedAt: cur.updatedAt,
  };
  const changed = Boolean(cur.enabled) !== Boolean(next.enabled) || JSON.stringify(adsDisclosure(cur)) !== JSON.stringify(adsDisclosure(next));
  if (changed) next.updatedAt = now.toISOString();
  return next;
}

/** O que impede de ligar os anúncios, em palavras simples (null = pode salvar). */
export function adsProblem(ads: AdsSettings): string | null {
  if (!ads.enabled) return null;
  if (!AD_PLACEMENTS.some((p) => placementOn(ads, p))) return "Ligue pelo menos um lugar em “Onde aparecem” — ou desligue os anúncios.";
  if (ads.source === "house") {
    if (!ads.house?.title || !ads.house?.url) return "Para o anúncio do patrocinador, preencha pelo menos o título e o link.";
    return null;
  }
  if (!adsensePublisher(ads)) return "Cole o código do editor do AdSense (começa com ca-pub-).";
  const missing = AD_PLACEMENTS.filter((p) => placementOn(ads, p) && !ads.adsense?.slots?.[p]);
  if (!ads.adsense?.slotId && missing.length) return "Cole o número do bloco de anúncio do AdSense (só algarismos, aparece como data-ad-slot).";
  return null;
}

/** Conteúdo do /ads.txt (o Google confere quem pode vender anúncios no site). */
export function adsTxt(ads: AdsSettings | undefined): string | null {
  const client = adsensePublisher(ads);
  return client ? `google.com, ${client.replace(/^ca-/, "")}, DIRECT, f08c47fec0942fa0\n` : null;
}
