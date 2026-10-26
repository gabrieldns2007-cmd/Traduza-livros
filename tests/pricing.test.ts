/**
 * Preço da tradução em reais: a Grátis é R$ 0 em qualquer tamanho; na
 * Literária, o cliente vê só o valor final, e esse valor cobre o pior custo
 * de processamento com margem — para livros de qualquer tamanho.
 */
import { describe, expect, it, onTestFinished } from "vitest";
import {
  assertPricingProtectsMargin,
  breakdown,
  GUARD_SIZES,
  isFreeLevel,
  OPERATIONS,
  priceFor,
  priceLabel,
  roundTo90,
  SERVICE_LEVELS,
  serviceLevel,
} from "@/lib/billing/pricing";

describe("preço da tradução", () => {
  it("arredonda em ,90 e respeita o mínimo (só nos tipos pagos)", () => {
    expect(roundTo90(19.12)).toBe(19.9);
    expect(roundTo90(19.95)).toBe(20.9);
    expect(roundTo90(19.9)).toBe(19.9);
    expect(priceFor(300, "literaria")).toBe(OPERATIONS.minimumBrl);
    expect(OPERATIONS.minimumBrl).toBe(9.9);
  });

  it("Grátis (id “padrao”): R$ 0 em qualquer tamanho, sem preço mínimo", () => {
    const free = serviceLevel("padrao");
    expect(free.id).toBe("padrao"); // o id fica, para os livros e pedidos já gravados
    expect(free.label).toBe("Grátis");
    expect(free.free).toBe(true);
    expect(free.description).toBe("Tradução completa por IA gratuita. Pode levar mais tempo: depende da disponibilidade dos serviços gratuitos.");
    expect(isFreeLevel("padrao")).toBe(true);
    expect(SERVICE_LEVELS[0].id).toBe("padrao"); // a Grátis aparece primeiro
    for (const words of [0, 1, ...GUARD_SIZES, 5_000_000]) expect(priceFor(words, "padrao")).toBe(0);
    // o mesmo espaço sem quebra de brl() (“R$” nunca fica sozinho no fim da linha)
    expect(priceLabel(0)).toBe("R$\u00a00");
    expect(priceLabel(0).slice(2, 3)).toBe(priceLabel(9.9).slice(2, 3));
    // sem receita e sem custo de IA (só serviços gratuitos): a conta interna é toda zero
    const b = breakdown(210_000, "padrao");
    expect(b).toMatchObject({ priceBrl: 0, netBrl: 0, processingExpectedBrl: 0, processingWorstBrl: 0, fixedCostBrl: 0, marginWorst: 0 });
  });

  it("um tipo desconhecido nunca vira a Grátis sem querer (vale o tipo pago)", () => {
    expect(serviceLevel("premium").free).toBeFalsy();
    expect(serviceLevel(undefined).id).toBe("literaria");
    expect(isFreeLevel("qualquer")).toBe(false);
    expect(isFreeLevel(undefined)).toBe(false);
    expect(priceFor(10_000, "qualquer")).toBe(priceFor(10_000, "literaria"));
  });

  it("Literária não muda: R$ 1,90 + R$ 1,49 por mil palavras, mínimo R$ 9,90", () => {
    const lit = serviceLevel("literaria");
    expect(lit.label).toBe("Literária");
    expect(lit.free).toBeFalsy();
    expect(isFreeLevel("literaria")).toBe(false);
    expect(lit.feeBrl).toBe(1.9);
    expect(lit.per1kBrl).toBe(1.49);
    expect(priceFor(5_000, "literaria")).toBe(9.9);
    expect(priceFor(10_000, "literaria")).toBe(16.9);
    expect(priceFor(44_152, "literaria")).toBe(67.9);
    expect(priceFor(210_000, "literaria")).toBe(314.9);
    expect(priceLabel(priceFor(10_000, "literaria"))).toMatch(/^R\$\s16,90$/);
  });

  it("cobre o pior custo com a margem mínima na Literária em qualquer tamanho de livro", () => {
    expect(() => assertPricingProtectsMargin()).not.toThrow();
    for (const words of GUARD_SIZES) {
      const b = breakdown(words, "literaria");
      expect(b.processingWorstBrl).toBeGreaterThan(b.processingExpectedBrl);
      expect(b.marginWorst).toBeGreaterThanOrEqual(0.5);
    }
  });

  it("a trava continua valendo para os tipos pagos: preço abaixo da margem é recusado", () => {
    const lit = SERVICE_LEVELS.find((l) => l.id === "literaria")!;
    const before = lit.per1kBrl;
    onTestFinished(() => {
      lit.per1kBrl = before;
    });
    lit.per1kBrl = 0.05;
    expect(() => assertPricingProtectsMargin()).toThrow(/Literária, .* palavras: preço R\$ .* margem/);
  });
});
