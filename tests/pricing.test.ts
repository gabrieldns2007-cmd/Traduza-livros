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

  it("Padrão: R$ 8,90 + R$ 0,10 por mil palavras (210 mil = R$ 29,90)", () => {
    expect(priceFor(10_000, "padrao")).toBe(9.9);
    expect(priceFor(10_001, "padrao")).toBe(10.9);
    expect(priceFor(44_152, "padrao")).toBe(13.9);
    expect(priceFor(80_000, "padrao")).toBe(16.9);
    expect(priceFor(150_000, "padrao")).toBe(23.9);
    expect(priceFor(210_000, "padrao")).toBe(29.9);
    expect(priceFor(300_000, "padrao")).toBe(38.9);
    expect(priceFor(1_000_000, "padrao")).toBe(108.9);
  });

  it("Literária não muda: R$ 1,90 + R$ 1,49 por mil palavras", () => {
    expect(priceFor(10_000, "literaria")).toBe(16.9);
    expect(priceFor(44_152, "literaria")).toBe(67.9);
    expect(priceFor(210_000, "literaria")).toBe(314.9);
  });

  it("cobre o pior custo com a margem mínima do tipo em qualquer tamanho de livro", () => {
    expect(() => assertPricingProtectsMargin()).not.toThrow();
    // Padrão: mesmo se a IA fosse paga (Flash-Lite, pior caso), nenhum livro dá prejuízo
    for (const words of [44_152, 210_000, 1_000_000]) {
      const b = breakdown(words, "padrao");
      expect(b.processingWorstBrl).toBeGreaterThan(b.processingExpectedBrl);
      expect(b.marginWorst).toBeGreaterThanOrEqual(0.15);
    }
    expect(breakdown(44_152, "literaria").marginWorst).toBeGreaterThanOrEqual(0.5);
  });
});
