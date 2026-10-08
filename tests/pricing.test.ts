/**
 * Preço da tradução em reais: o cliente vê só o valor final, e esse valor
 * cobre o pior custo de processamento com margem — para livros de qualquer tamanho.
 */
import { describe, expect, it } from "vitest";
import { assertPricingProtectsMargin, breakdown, priceFor, roundTo90 } from "@/lib/billing/pricing";

describe("preço da tradução", () => {
  it("arredonda em ,90 e respeita o mínimo", () => {
    expect(roundTo90(19.12)).toBe(19.9);
    expect(roundTo90(19.95)).toBe(20.9);
    expect(roundTo90(19.9)).toBe(19.9);
    expect(priceFor(300, "padrao")).toBe(9.9);
  });

  it("Devotions (44.152 palavras): preço em reais, sem nada técnico", () => {
    expect(priceFor(44_152, "padrao")).toBe(19.9);
    expect(priceFor(44_152, "literaria")).toBe(67.9);
  });

  it("cobre o pior custo com margem em qualquer tamanho de livro", () => {
    expect(() => assertPricingProtectsMargin()).not.toThrow();
    const b = breakdown(44_152, "padrao");
    expect(b.processingWorstBrl).toBeGreaterThan(b.processingExpectedBrl);
    expect(b.marginWorst).toBeGreaterThanOrEqual(0.5);
  });
});
