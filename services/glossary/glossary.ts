/**
 * Glossário (memória) do livro.
 *
 * Começa com os nomes e termos encontrados na análise inicial e cresce a cada
 * capítulo analisado. Em cada lote enviado ao tradutor, vão apenas as entradas
 * que aparecem naquele trecho — assim o prompt fica curto e a consistência
 * (Jay Gatsby continua Jay Gatsby; “the Valley of Ashes” é sempre o mesmo vale)
 * é mantida do primeiro ao último capítulo. Entradas editadas pelo usuário
 * nunca são sobrescritas.
 */
import { randomUUID } from "node:crypto";
import type { GlossaryEntry } from "@/types/book";
import type { GlossaryCandidate } from "@/services/translation/translation-provider";

const MAX_ENTRIES = 1500;
const STOP = new Set(["the", "and", "of", "mr", "mrs", "miss", "sir", "lady", "lord", "saint", "dear", "old"]);

export function normalizeTerm(term: string): string {
  return term.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Adiciona candidatos que ainda não existem. Retorna quantos foram adicionados. */
export function mergeCandidates(entries: GlossaryEntry[], candidates: GlossaryCandidate[], origin: GlossaryEntry["origin"] = "auto"): number {
  const known = new Set(entries.map((e) => normalizeTerm(e.term)));
  let added = 0;
  for (const c of candidates) {
    if (entries.length >= MAX_ENTRIES) break;
    const key = normalizeTerm(c.term);
    if (!key || known.has(key)) continue;
    known.add(key);
    entries.push({ id: randomUUID().slice(0, 8), term: c.term.trim(), translation: c.translation.trim(), type: c.type, note: c.note, origin });
    added++;
  }
  return added;
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function occurs(text: string, needle: string): boolean {
  if (!needle) return false;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(needle)}(?![\\p{L}\\p{N}])`, "u");
  return re.test(text);
}

/** Entradas do glossário que aparecem no texto (pelo termo completo ou por um nome significativo dele). */
export function relevantEntries(entries: GlossaryEntry[], text: string, limit = 60): GlossaryEntry[] {
  const lower = text.toLowerCase();
  const scored: { e: GlossaryEntry; score: number }[] = [];
  for (const e of entries) {
    let score = 0;
    if (occurs(text, e.term) || occurs(lower, e.term.toLowerCase())) score = 3;
    else {
      const tokens = e.term.split(/[\s\-–]+/).filter((t) => t.length >= 4 && /^\p{Lu}/u.test(t) && !STOP.has(t.toLowerCase()));
      if (tokens.some((t) => occurs(text, t))) score = 2;
    }
    if (score) scored.push({ e, score: score + (e.origin === "user" ? 1 : 0) });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.e);
}

export const GLOSSARY_TYPE_LABELS: Record<GlossaryEntry["type"], string> = {
  character: "Personagens",
  place: "Lugares",
  organization: "Organizações",
  term: "Termos",
  other: "Outros",
};
