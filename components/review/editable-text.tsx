"use client";

import { useEffect, useRef } from "react";
import type { EditedNode } from "@/lib/markup";

/** Converte o DOM editado de volta numa árvore simples (texto, tags conhecidas, ênfases novas). */
export function serializeEditable(root: Node): EditedNode[] {
  const out: EditedNode[] = [];
  root.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      const x = child.textContent ?? "";
      if (x) out.push({ x });
      return;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return;
    const el = child as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const k = el.dataset.k ? Number(el.dataset.k) : undefined;
    if (tag === "br") {
      out.push(k !== undefined ? { k } : { br: true });
      return;
    }
    if (el.dataset.v && k !== undefined) {
      out.push({ k });
      return;
    }
    const c = serializeEditable(el);
    const weight = Number(el.style.fontWeight) || (el.style.fontWeight === "bold" ? 700 : 0);
    if (k !== undefined) out.push({ k, c });
    else if (tag === "b" || tag === "strong" || weight >= 600) out.push({ f: "strong", c });
    else if (tag === "i" || tag === "em" || el.style.fontStyle === "italic") out.push({ f: "em", c });
    else out.push(...c);
  });
  return out;
}

/**
 * Parágrafo editável sem barra de ferramentas: digita-se direto no texto.
 * Enter não cria parágrafos (a estrutura do livro é preservada); colar
 * insere só texto; ⌘/Ctrl+I e ⌘/Ctrl+B funcionam para itálico e negrito.
 */
export function EditableText({
  html,
  editable,
  className,
  as: Tag = "p",
  onDirty,
  onCommit,
  lang,
}: {
  html: string;
  editable: boolean;
  className?: string;
  as?: "p" | "h2" | "h3" | "div" | "li";
  /** chamado a cada alteração; recebe uma função que lê o conteúdo atual */
  onDirty: (read: () => EditedNode[]) => void;
  onCommit: (nodes: EditedNode[]) => void;
  lang?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const lastHtml = useRef<string | null>(null);

  // só reescreve o conteúdo quando ele muda de fora (nunca durante a digitação)
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (document.activeElement === el) return;
    if (lastHtml.current !== html) {
      el.innerHTML = html;
      lastHtml.current = html;
    }
  }, [html]);

  return (
    <Tag
      ref={ref as never}
      lang={lang}
      className={className}
      contentEditable={editable}
      suppressContentEditableWarning
      spellCheck={editable}
      onInput={() => ref.current && onDirty(() => serializeEditable(ref.current!))}
      onBlur={() => {
        if (!editable || !ref.current) return;
        lastHtml.current = ref.current.innerHTML;
        onCommit(serializeEditable(ref.current));
      }}
      onKeyDown={(e) => {
        if (!editable) return;
        if (e.key === "Enter") {
          e.preventDefault();
          if (e.shiftKey) document.execCommand("insertLineBreak");
          else (e.currentTarget as HTMLElement).blur();
        }
        if (e.key === "Escape") (e.currentTarget as HTMLElement).blur();
      }}
      onPaste={(e) => {
        if (!editable) return;
        e.preventDefault();
        const text = e.clipboardData.getData("text/plain").replace(/\s*\n\s*/g, " ");
        document.execCommand("insertText", false, text);
      }}
    />
  );
}
