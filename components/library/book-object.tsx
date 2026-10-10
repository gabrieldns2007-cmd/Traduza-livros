"use client";

import { useState, type CSSProperties, type Ref } from "react";
import type { BookSummary } from "@/types/book";
import { languageLabel } from "@/lib/languages";
import { Plus } from "@/components/ui/icons";
import { coverTitle, displayTitle, edgeTone, shapeOf, thicknessOf, titleFit, type Binding, type EdgeTone } from "./book-look";
import s from "./bookshelf.module.css";

/* ---------- cor da lombada tirada da própria capa ---------- */

/** Tom já calculado por livro (vale para a estante, o voo e o painel). */
const edges = new Map<string, EdgeTone>();

/**
 * Lê a faixa esquerda (5%) da <img> que JÁ carregou, num canvas minúsculo, e
 * tira a média. Nada de baixar a capa de novo: sem `new Image()` e sem
 * `background-image`.
 */
function sampleEdge(img: HTMLImageElement): EdgeTone | null {
  try {
    if (!img.complete || !img.naturalWidth) return null;
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 16;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, Math.max(1, img.naturalWidth * 0.05), img.naturalHeight, 0, 0, 2, 16);
    const d = ctx.getImageData(0, 0, 2, 16).data;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i];
      g += d[i + 1];
      b += d[i + 2];
    }
    const n = d.length / 4;
    return edgeTone(r / n, g / n, b / n);
  } catch {
    return null;
  }
}

/** Tom neutro se a leitura da capa falhar. */
const NEUTRAL_EDGE: EdgeTone = { spine: "#3b3732", ink: "#efe8dc", rule: "#cdb27e", light: false };

export type BookVariant = "shelf" | "hero";

/**
 * O livro como objeto: capa, lombada (à esquerda, com filetes e, no destaque,
 * o título na vertical), o bloco de páginas visto de cima e uma sombra suave.
 *
 * Nitidez: em repouso NÃO há `transform-style: preserve-3d`. Capa, lombada e
 * topo são camadas irmãs, cada uma com a transformação completa em torno do
 * centro do livro, no mesmo espaço de perspectiva — o texto da capa fica
 * nítido. Só o livro que voa (`rig`) usa preserve-3d, e só durante o voo.
 */
export function BookObject({
  book,
  binding,
  variant,
  eager = false,
  priority = false,
  rigRef,
}: {
  book: BookSummary;
  binding: Binding;
  variant: BookVariant;
  /** capas da primeira prateleira: carregam já */
  eager?: boolean;
  /** e com prioridade alta (as que aparecem primeiro na tela) */
  priority?: boolean;
  /** só no livro que voa: a armação 3D que gira durante o voo */
  rigRef?: Ref<HTMLSpanElement>;
}) {
  const [failed, setFailed] = useState(false);
  const [edge, setEdge] = useState<EdgeTone | null>(() => edges.get(book.id) ?? null);
  const withImage = book.hasCover && !failed;
  // até ler a cor da capa, lombada e topo ficam invisíveis (nunca uma cor errada que depois troca)
  const edgePending = withImage && !edge;
  const title = displayTitle(book);
  const shape = shapeOf(book);
  const thick = thicknessOf(book.words);
  const tone = withImage ? (edge ?? NEUTRAL_EDGE) : { spine: binding.spine, ink: binding.ink, rule: binding.rule, light: binding.name === "linho" };

  const style = {
    "--scale": variant === "shelf" ? shape.scale : 1,
    "--ratio": shape.ratio,
    "--thick": thick,
    "--cloth": withImage ? tone.spine : binding.cloth,
    "--spine": tone.spine,
    "--ink": tone.ink,
    "--rule": tone.rule,
  } as CSSProperties;

  const read = (img: HTMLImageElement | null) => {
    if (!img) return;
    const known = edges.get(book.id);
    if (known) {
      if (known !== edge) setEdge(known);
      return;
    }
    if (!img.complete || !img.naturalWidth) return; // ainda carregando: o onLoad chama de novo
    const tone = sampleEdge(img) ?? NEUTRAL_EDGE;
    edges.set(book.id, tone);
    setEdge(tone);
  };

  // título na lombada só no livro em destaque, e só quando a lombada tem largura para ele
  const spineTitle = variant === "hero" && thick >= 0.13;

  const faces = (
    <>
      <span className={`${s.face} ${s.top}`} />
      <span className={`${s.face} ${s.spine} ${tone.light ? s.spineLight : ""}`}>
        <span className={s.bands} />
        {spineTitle && <span className={`${s.spineTitle} serif`}>{title}</span>}
      </span>
      <span className={`${s.face} ${s.front}`}>
        {withImage ? (
          // eslint-disable-next-line @next/next/no-img-element -- capa servida pela própria API
          <img
            ref={read}
            src={`/api/books/${book.id}/cover`}
            alt={`Capa de ${title}`}
            loading={eager ? "eager" : "lazy"}
            fetchPriority={priority ? "high" : undefined}
            draggable={false}
            onLoad={(e) => read(e.currentTarget)}
            onError={() => setFailed(true)}
          />
        ) : (
          <TypeCover book={book} title={title} shelf={variant === "shelf"} />
        )}
      </span>
    </>
  );

  return (
    <span
      className={`${s.scene} ${variant === "hero" ? s.sceneHero : s.sceneShelf}`}
      style={style}
      data-book-scene={book.id}
      data-edge-pending={edgePending ? "" : undefined}
    >
      <span className={s.cast} aria-hidden />
      {rigRef ? (
        <span ref={rigRef} className={s.rig}>
          {faces}
        </span>
      ) : (
        faces
      )}
    </span>
  );
}

/**
 * Capa tipográfica da casa: moldura fina, título em serifa, filete e autor em
 * itálico. No pé, o selo “Verso.” só na nova edição (livro pronto); o
 * original leva o idioma em versalete, como o cartão do original em Preços.
 */
function TypeCover({ book, title, shelf }: { book: BookSummary; title: string; shelf: boolean }) {
  const source = book.sourceLanguage ?? book.detectedLanguage ?? undefined;
  const edition = book.status === "done";
  const lang = edition && book.translatedTitle ? book.targetLanguage : source;
  // na estante a capa é pequena: título mais curto (o completo fica no painel)
  const text = coverTitle(title, shelf ? 48 : 78);
  const origin = edition ? "" : languageLabel(source, "");
  return (
    <span className={s.typo} aria-hidden>
      <span className={s.typoTitle} data-fit={titleFit(text)} lang={lang}>
        {text}
      </span>
      <span className={s.typoRule} />
      {book.author && <span className={s.typoAuthor}>{book.author}</span>}
      {edition ? (
        <span className={s.typoMark}>
          Verso<span>.</span>
        </span>
      ) : (
        origin && <span className={s.typoLang}>{origin}</span>
      )}
    </span>
  );
}

/**
 * O livro desenhado em linhas finas: o lugar do primeiro livro na estante
 * vazia e, com `plus`, o lugar livre no fim da estante (“Novo livro”).
 */
export function WireBook({ plus = false }: { plus?: boolean }) {
  const style = { "--scale": 1, "--ratio": 1.5, "--thick": 0.16 } as CSSProperties;
  return (
    <span className={`${s.scene} ${s.sceneShelf} ${s.wire}`} style={style} aria-hidden>
      <span className={`${s.face} ${s.top}`} />
      <span className={`${s.face} ${s.spine}`} />
      <span className={`${s.face} ${s.front}`}>
        {plus ? (
          <span className={s.wirePlus}>
            <Plus className="h-full w-full" />
          </span>
        ) : (
          <span className={s.wireLines}>
            <span />
            <span />
            <span />
          </span>
        )}
      </span>
    </span>
  );
}
