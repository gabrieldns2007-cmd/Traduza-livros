"use client";

import { useState } from "react";
import { api } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { AdCard, adFrame } from "@/components/ads/ad-slot";
import { AD_PLACEMENT_INFO, AD_PLACEMENTS, placementOn, type AdPlacement, type AdsSettings } from "@/lib/ads";

// o mesmo campo de texto das outras seções do painel
const input =
  "mt-2 w-full rounded-xl border border-rule bg-transparent px-4 py-3 text-[1rem] text-ink placeholder:text-muted/80 focus:border-ink-2 focus:outline-none";
const hint = "mt-1.5 block text-[0.8125rem] leading-relaxed text-muted";

type Source = "adsense" | "house";

const SOURCES: { id: Source; title: string; text: string }[] = [
  {
    id: "adsense",
    title: "Google AdSense",
    text: "O Google escolhe os anúncios e paga a você pelas visualizações e cliques. Precisa de uma conta aprovada no AdSense.",
  },
  {
    id: "house",
    title: "Patrocinador direto",
    text: "Você combina com uma empresa (uma livraria, uma escola de idiomas…), recebe dela e escreve o anúncio aqui. Sem o Google; se tiver imagem, ela vem do site do patrocinador.",
  },
];

function slotsOf(ads: AdsSettings) {
  return Object.fromEntries(AD_PLACEMENTS.map((p) => [p, ads.adsense?.slots?.[p] ?? ""])) as Record<AdPlacement, string>;
}

/**
 * Painel → Anúncios. Desligado por padrão: nada muda no site até o dono ligar.
 * Tudo pelo painel, sem editar arquivos: o ads.txt, a verificação do Google e
 * o aviso nos termos e na privacidade são criados sozinhos.
 */
export function AdsPanel({
  ads,
  siteLocked,
  passwordSet,
  onSaved,
}: {
  ads: AdsSettings;
  siteLocked: boolean;
  /** senha do painel criada: sem ela, os anúncios não podem ser ligados */
  passwordSet: boolean;
  onSaved: () => void;
}) {
  // estado local criado uma vez: a atualização automática do painel não apaga o que está sendo digitado
  const [enabled, setEnabledState] = useState(Boolean(ads.enabled));
  const [source, setSourceState] = useState<Source>(ads.source ?? "adsense");
  const [publisherId, setPublisherIdState] = useState(ads.adsense?.publisherId ?? "");
  const [slotId, setSlotIdState] = useState(ads.adsense?.slotId ?? "");
  const [slots, setSlotsState] = useState(() => slotsOf(ads));
  const [house, setHouseState] = useState({
    sponsor: ads.house?.sponsor ?? "",
    title: ads.house?.title ?? "",
    text: ads.house?.text ?? "",
    url: ads.house?.url ?? "",
    imageUrl: ads.house?.imageUrl ?? "",
    cta: ads.house?.cta ?? "",
  });
  const [placements, setPlacementsState] = useState(
    () => Object.fromEntries(AD_PLACEMENTS.map((p) => [p, placementOn(ads, p)])) as Record<AdPlacement, boolean>,
  );
  const [state, setState] = useState<"" | "saving" | "saved" | string>("");

  // qualquer mudança apaga o “Salvo.” (ou o erro) do último salvamento: o botão fica longe, lá embaixo
  const changed =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setState((s) => (s === "saving" ? s : ""));
    };
  const setEnabled = changed(setEnabledState);
  const setSource = changed(setSourceState);
  const setPublisherId = changed(setPublisherIdState);
  const setSlotId = changed(setSlotIdState);
  const setSlots = changed(setSlotsState);
  const setHouse = changed(setHouseState);
  const setPlacements = changed(setPlacementsState);
  // blocos por lugar: abertos de início só se já houver algum salvo (depois, quem abre e fecha é o dono)
  const [slotsOpen] = useState(() => AD_PLACEMENTS.some((p) => ads.adsense?.slots?.[p]));

  const edit = (field: keyof typeof house) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setHouse((h) => ({ ...h, [field]: e.target.value }));

  const save = async () => {
    setState("saving");
    try {
      // só os campos de quem fornece os anúncios agora: os do outro (escondidos) não são conferidos nem
      // mudados — o que já estava salvo deles continua
      const provider = source === "adsense" ? { adsense: { publisherId, slotId, slots } } : { house };
      const res = await api<{ settings: { ads?: AdsSettings } }>("/api/admin/settings", {
        method: "PUT",
        json: { ads: { enabled, source, ...provider, placements } },
      });
      // mostra como ficou salvo (ex.: “pub-…” vira “ca-pub-…”; o código colado vira só o número)
      const saved = res.settings.ads ?? {};
      if (source === "adsense") {
        setPublisherIdState(saved.adsense?.publisherId ?? "");
        setSlotIdState(saved.adsense?.slotId ?? "");
        setSlotsState(slotsOf(saved));
      }
      setState("saved");
      onSaved();
    } catch (err) {
      setState((err as Error).message);
    }
  };

  return (
    <section className="mt-16">
      <h2 className="label">Anúncios</h2>
      <p className="mt-2 text-[0.8125rem] leading-relaxed text-muted">
        Ganhe com espaços de publicidade discretos, sempre identificados como “Publicidade”. Desligado, o site fica exatamente como está.
      </p>

      <div className="mt-5">
        <Switch
          checked={enabled}
          onChange={setEnabled}
          label="Mostrar anúncios no site"
          description="No máximo um por página. Nunca no pagamento, na leitura do livro, no painel, nos termos nem na privacidade."
        />
      </div>

      {!passwordSet && (
        <p className="mt-5 rounded-[1.25rem] border border-accent/50 px-5 py-4 text-[0.875rem] leading-relaxed text-ink-2" role="note">
          <strong className="font-medium text-ink">Crie a senha do painel antes de ligar os anúncios</strong> (no topo desta página). Sem ela,
          qualquer pessoa com o endereço do painel poderia trocar o anúncio que os seus clientes veem.
        </p>
      )}

      {siteLocked && (
        <p className="mt-5 rounded-[1.25rem] border border-accent/50 px-5 py-4 text-[0.875rem] leading-relaxed text-ink-2" role="note">
          <strong className="font-medium text-ink">O site está protegido por senha (APP_PASSWORD).</strong> O Google não consegue ver as páginas,
          então não aprova o site nem mostra anúncios do AdSense. O patrocinador direto aparece normalmente para quem tem a senha.
        </p>
      )}

      {/* ---------- quem fornece ---------- */}
      <p className="mt-8 text-[1rem] font-medium text-ink">Quem fornece os anúncios</p>
      <div className="mt-3 space-y-2.5" role="radiogroup" aria-label="Quem fornece os anúncios">
        {SOURCES.map((o) => {
          const sel = o.id === source;
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={sel}
              onClick={() => setSource(o.id)}
              className={`flex w-full items-start gap-3 rounded-2xl border px-4 py-4 text-left transition-colors ${sel ? "border-ink" : "border-rule hover:border-rule-strong"}`}
            >
              <span
                className={`mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${sel ? "border-ink bg-ink" : "border-rule-strong"}`}
              >
                {sel && <span className="h-1.5 w-1.5 rounded-full bg-paper" />}
              </span>
              <span>
                <span className="block text-[0.9375rem] font-medium text-ink">{o.title}</span>
                <span className="mt-0.5 block text-[0.8125rem] leading-relaxed text-muted">{o.text}</span>
              </span>
            </button>
          );
        })}
      </div>

      {source === "adsense" ? (
        <div className="mt-6">
          <label className="block">
            <span className="label">Código do editor</span>
            <input
              value={publisherId}
              onChange={(e) => setPublisherId(e.target.value)}
              placeholder="ca-pub-0000000000000000"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={4000}
              className={input}
            />
            <span className={hint}>
              No AdSense, em Conta → Informações da conta. Pode colar o trecho de código inteiro: o Verso encontra o número.
            </span>
          </label>
          <label className="mt-5 block">
            <span className="label">Número do bloco de anúncio</span>
            <input
              value={slotId}
              onChange={(e) => setSlotId(e.target.value)}
              placeholder="1234567890"
              inputMode="numeric"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={4000}
              className={input}
            />
            <span className={hint}>
              No AdSense, em Anúncios → Por bloco de anúncio → Anúncio de display. É o número em data-ad-slot (ou cole o código do bloco).
            </span>
          </label>

          <details className="mt-5" open={slotsOpen}>
            <summary className="link cursor-pointer text-[0.875rem] text-ink-2">Usar um bloco diferente em cada lugar (opcional)</summary>
            <p className={hint}>Assim o AdSense mostra quanto cada lugar rende. Em branco, vale o número acima.</p>
            {AD_PLACEMENTS.map((p) => (
              <label key={p} className="mt-4 block">
                <span className="label">{AD_PLACEMENT_INFO[p].label}</span>
                <input
                  value={slots[p]}
                  onChange={(e) => setSlots((s) => ({ ...s, [p]: e.target.value }))}
                  placeholder={slotId || "1234567890"}
                  inputMode="numeric"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={4000}
                  className={input}
                />
              </label>
            ))}
          </details>

          <div className="mt-7 rounded-2xl bg-paper-2 px-5 py-5 text-[0.875rem] leading-relaxed text-ink-2">
            <p className="font-medium text-ink">Como começar com o AdSense</p>
            <ol className="mt-2 list-decimal space-y-1.5 pl-5">
              <li>O site precisa estar aberto ao público, sem a senha do site (APP_PASSWORD): o Google visita as páginas para aprovar.</li>
              <li>
                Crie a conta em{" "}
                <a href="https://adsense.google.com" target="_blank" rel="noreferrer" className="link text-ink">
                  adsense.google.com
                </a>{" "}
                com o endereço do site, cole aqui o código do editor e salve. A verificação do site e o arquivo{" "}
                <a href="/ads.txt" target="_blank" className="link text-ink">
                  ads.txt
                </a>{" "}
                são criados sozinhos, mesmo com os anúncios desligados.
              </li>
              <li>Depois da aprovação (pode levar alguns dias), crie um bloco de anúncio de display e cole o número dele aqui.</li>
              <li>
                No AdSense, deixe os <strong className="font-medium text-ink">Anúncios automáticos desligados</strong>: eles colocariam anúncios em
                qualquer página, até no pagamento, e em tela cheia.
              </li>
              <li>Em Controle de bloqueio, bloqueie anúncios de outros serviços de tradução, para não mandar clientes para a concorrência.</li>
              <li>
                “Livro sendo traduzido” começa desligado: o Google é rigoroso com anúncios em telas de espera. Se ligar e ele reclamar, desligue de
                novo (ou use um patrocinador direto).
              </li>
              <li>
                Os anúncios pedidos ao Google são <strong className="font-medium text-ink">não personalizados</strong> (sem o histórico de navegação
                de quem visita). Rendem um pouco menos, mas não exigem o aviso de cookies que os personalizados pedem.
              </li>
            </ol>
            <p className="mt-3 text-[0.8125rem] text-muted">
              Com a senha do painel criada, você não vê os anúncios do Google neste navegador enquanto estiver logado no painel — clicar no próprio
              anúncio é proibido pelo Google.
            </p>
          </div>
        </div>
      ) : (
        <div className="mt-6">
          <label className="block">
            <span className="label">Nome do patrocinador</span>
            <input value={house.sponsor} onChange={edit("sponsor")} maxLength={60} placeholder="Ex.: Livraria Aurora" className={input} />
          </label>
          <label className="mt-5 block">
            <span className="label">Título</span>
            <input value={house.title} onChange={edit("title")} maxLength={80} placeholder="Ex.: Clássicos com 20% de desconto" className={input} />
          </label>
          <label className="mt-5 block">
            <span className="label">Texto (opcional)</span>
            <textarea
              value={house.text}
              onChange={edit("text")}
              maxLength={240}
              rows={3}
              placeholder="Uma ou duas frases sobre a oferta."
              className={`${input} resize-none`}
            />
          </label>
          <label className="mt-5 block">
            <span className="label">Link</span>
            <input
              type="url"
              inputMode="url"
              value={house.url}
              onChange={edit("url")}
              maxLength={500}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="https://"
              className={input}
            />
            <span className={hint}>Abre numa nova aba. O endereço completo, começando com https://.</span>
          </label>
          <label className="mt-5 block">
            <span className="label">Imagem (opcional)</span>
            <input
              type="url"
              inputMode="url"
              value={house.imageUrl}
              onChange={edit("imageUrl")}
              maxLength={500}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="https://…/imagem.jpg"
              className={input}
            />
            <span className={hint}>Endereço de uma imagem já publicada na internet (https://), de preferência larga, como 1200 × 628.</span>
          </label>
          <label className="mt-5 block">
            <span className="label">Texto do link</span>
            <input value={house.cta} onChange={edit("cta")} maxLength={30} placeholder="Saiba mais" className={input} />
          </label>

          <p className="mt-7 label">Prévia</p>
          <div className={`mt-2 ${adFrame}`}>
            <AdCard
              preview
              ad={{
                title: house.title || "Título do anúncio",
                text: house.text || undefined,
                url: house.url,
                imageUrl: house.imageUrl || undefined,
                cta: house.cta || "Saiba mais",
                sponsor: house.sponsor || undefined,
              }}
            />
          </div>
        </div>
      )}

      {/* ---------- onde ---------- */}
      <p className="mt-8 text-[1rem] font-medium text-ink">Onde aparecem</p>
      <div className="mt-3 divide-y divide-rule rounded-2xl border border-rule px-4">
        {AD_PLACEMENTS.map((p) => (
          <div key={p} className="py-3">
            <Switch
              checked={placements[p]}
              onChange={(v) => setPlacements((s) => ({ ...s, [p]: v }))}
              label={AD_PLACEMENT_INFO[p].label}
              description={AD_PLACEMENT_INFO[p].where}
            />
          </div>
        ))}
      </div>
      <p className="mt-3 text-[0.8125rem] leading-relaxed text-muted">
        Nunca aparecem no pedido, no pagamento, na leitura e revisão do livro, no painel, na entrada, nos termos nem na privacidade. Com os anúncios
        ligados, os{" "}
        <a href="/termos" target="_blank" className="link text-ink-2">
          Termos de uso
        </a>{" "}
        e a{" "}
        <a href="/privacidade" target="_blank" className="link text-ink-2">
          Política de privacidade
        </a>{" "}
        avisam sozinhos sobre a publicidade.
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-4">
        <Button variant="secondary" onClick={save} disabled={state === "saving"} className="w-full sm:w-auto">
          {state === "saving" ? "Salvando…" : "Salvar anúncios"}
        </Button>
        {state === "saved" && <span className="text-[0.875rem] text-ok">Salvo.</span>}
        {state && state !== "saving" && state !== "saved" && (
          <span className="text-[0.875rem] text-accent" role="alert">
            {state}
          </span>
        )}
      </div>
    </section>
  );
}
