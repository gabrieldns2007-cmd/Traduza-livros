"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Script from "next/script";
import { safeUrl, type AdConfig, type AdPlacement } from "@/lib/ads";

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

type HouseAd = Extract<AdConfig, { kind: "house" }>;

/**
 * Moldura de todo anúncio: linha tracejada e papel mais escuro, sempre com
 * “Publicidade” em cima. Nunca usa a cor de destaque, o botão principal nem
 * ícones de download — o anúncio não pode se passar por uma ação do Verso.
 */
export const adFrame = "rounded-[1.25rem] border border-dashed border-rule-strong bg-paper-2/60 px-5 py-5 sm:px-6";

/**
 * Moldura do AdSense: no celular, só as linhas de cima e de baixo e sem margem
 * dos lados, para caber um anúncio de 300 ou 320 px de largura (com a margem,
 * sobravam ~280 px numa tela de 360 px).
 */
const adsenseFrame = "border-y border-dashed border-rule-strong bg-paper-2/60 py-4 sm:rounded-[1.25rem] sm:border-x sm:px-6 sm:py-5";

function AdLabel() {
  return <p className="label">Publicidade</p>;
}

/** Corpo do anúncio de patrocinador (também usado na prévia do painel, com `preview`). */
export function AdCard({ ad, preview = false }: { ad: Omit<HouseAd, "kind">; preview?: boolean }) {
  const image = safeUrl(ad.imageUrl, true);
  const [broken, setBroken] = useState<string | null>(null);
  const body = (
    <>
      {image && broken !== image && (
        // endereço externo escolhido pelo dono: <img> simples, sem passar pelo servidor
        // eslint-disable-next-line @next/next/no-img-element -- imagem do patrocinador, de qualquer site https
        <img
          src={image}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setBroken(image)}
          className="mb-4 aspect-[1.91/1] w-full rounded-xl bg-paper-3 object-cover"
        />
      )}
      <span className="serif block text-[1.25rem] leading-snug text-ink">{ad.title}</span>
      {ad.text && <span className="mt-1 block text-[0.9375rem] leading-relaxed text-ink-2">{ad.text}</span>}
      <span className="link mt-3 inline-block text-[0.875rem] text-ink">{ad.cta} ↗</span>
    </>
  );
  return (
    <>
      <AdLabel />
      {preview ? (
        <div className="mt-3">{body}</div>
      ) : (
        <a href={ad.url} target="_blank" rel="sponsored noopener noreferrer" className="mt-3 block">
          {body}
        </a>
      )}
      {ad.sponsor && <p className="mt-3 text-[0.75rem] text-muted">Anúncio de {ad.sponsor}</p>}
    </>
  );
}

/**
 * Situação do script do Google nesta aba. O next/script avisa o erro uma vez só
 * por carregamento da página: os espaços montados depois (navegação sem
 * recarregar) leem daqui, para não ficar uma moldura vazia escrita “Publicidade”.
 */
export const googleScript = {
  state: "pending" as "pending" | "loaded" | "failed",
  listeners: new Set<() => void>(),
  set(state: "loaded" | "failed") {
    if (this.state === "failed") return;
    this.state = state;
    for (const l of [...this.listeners]) l();
  },
  /** chama `fn` agora e a cada mudança; devolve a função que para de ouvir */
  watch(fn: () => void) {
    this.listeners.add(fn);
    fn();
    return () => void this.listeners.delete(fn);
  },
};

/** Tempo, depois do script carregar, para o Google marcar o bloco como processado. */
const CHECK_AFTER_MS = 4000;

/**
 * Bloco que o Google não vai preencher: escondido (bloqueador de anúncios que
 * esconde .adsbygoogle, ou bloco sem anúncio) ou nunca processado (bloqueador
 * que troca o script do Google por um vazio).
 */
export function adsenseBlocked(el: { offsetHeight: number; getAttribute(name: string): string | null }): boolean {
  return el.offsetHeight === 0 || !el.getAttribute("data-adsbygoogle-status");
}

/** Bloco do Google AdSense: um bloco fixo por página (nunca anúncios automáticos, fixos na tela ou em tela cheia). */
function AdSenseUnit({ client, slot, onFail }: { client: string; slot: string; onFail: () => void }) {
  const ins = useRef<HTMLModElement>(null);
  const pushed = useRef(false);

  useEffect(() => {
    // o script já falhou nesta aba (ex.: bloqueador de anúncios): o espaço some de vez
    if (googleScript.state === "failed") return onFail();
    // pede o anúncio uma vez só (o modo estrito do React roda os efeitos duas vezes)
    const el = ins.current;
    if (!el || pushed.current || el.getAttribute("data-adsbygoogle-status")) return;
    pushed.current = true;
    try {
      const queue = (window.adsbygoogle = window.adsbygoogle || []) as unknown[] & { requestNonPersonalizedAds?: number };
      // anúncios não personalizados (sem perfil de navegação): não precisam de aviso de consentimento
      queue.requestNonPersonalizedAds = 1;
      queue.push({});
    } catch {
      onFail();
    }
  }, [onFail]);

  useEffect(() => {
    // falhou, ou carregou mas o bloco não foi processado nem aparece: o espaço some
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = googleScript.watch(() => {
      if (googleScript.state === "failed") return onFail();
      if (googleScript.state !== "loaded" || timer) return;
      timer = setTimeout(() => {
        if (ins.current?.isConnected && adsenseBlocked(ins.current)) onFail();
      }, CHECK_AFTER_MS);
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [onFail]);

  return (
    <>
      {/* carregado uma vez, quando o navegador está livre; bloqueado (ex.: bloqueador de anúncios) → o espaço some */}
      <Script
        id="adsbygoogle-js"
        src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"
        strategy="lazyOnload"
        crossOrigin="anonymous"
        onLoad={() => googleScript.set("loaded")}
        onError={() => googleScript.set("failed")}
      />
      {/* sem “largura total” no celular: o anúncio fica dentro da moldura, embaixo de “Publicidade” */}
      <ins
        ref={ins}
        className="adsbygoogle mt-3 block min-h-[100px] w-full overflow-hidden"
        data-ad-client={client}
        data-ad-slot={slot}
        data-ad-format="auto"
        data-full-width-responsive="false"
      />
    </>
  );
}

/**
 * Espaço de publicidade de uma página. Sem anúncio configurado, não desenha
 * nada. O bloco do Google que não for preenchido some sozinho (data-ad-status),
 * e o que for bloqueado também (googleScript / adsenseBlocked).
 */
export function AdSlot({ ad, placement, className = "" }: { ad?: AdConfig | null; placement: AdPlacement; className?: string }) {
  const [failed, setFailed] = useState(false);
  const fail = useCallback(() => setFailed(true), []);
  if (!ad || failed) return null;
  return (
    <aside
      aria-label="Publicidade"
      data-placement={placement}
      className={`${ad.kind === "house" ? adFrame : adsenseFrame} has-[ins[data-ad-status=unfilled]]:hidden ${className}`}
    >
      {ad.kind === "house" ? (
        <AdCard ad={ad} />
      ) : (
        <>
          <AdLabel />
          <AdSenseUnit key={`${ad.client}:${ad.slot}`} client={ad.client} slot={ad.slot} onFail={fail} />
        </>
      )}
    </aside>
  );
}
