/**
 * Registro e controle de uma execução de tradução.
 *
 * Sempre (em qualquer modo): guarda em BookMeta.runs o serviço, o modelo,
 * os tokens, o custo estimado pela tabela de preços, o tempo, as palavras e os
 * capítulos — é o que permite calcular a margem real de cada tradução.
 *
 * Com BILLING_MODE=enforce e um serviço “hosted” (chave do dono do Verso):
 *  - reserva créditos antes de começar;
 *  - antes de cada lote, confere se a reserva cobre as palavras do lote;
 *  - desconta por palavra salva;
 *  - pausa se o custo real passar do que a execução cobrou (proteção de margem).
 */
import type { BookMeta, TranslationRun } from "@/types/book";
import { store } from "@/lib/storage";
import { billingMode } from "@/lib/billing/mode";
import { brlPerUsd, CREDIT, ECONOMICS, minCreditPriceBrl, netFactor, qualityOfModel } from "@/lib/billing/catalog";
import { usageCostUsd } from "@/lib/billing/prices";
import { milliFor } from "@/lib/billing/quote";
import { ProviderError } from "@/services/translation/llm/types";
import { wallet, WalletError } from "./wallet";

export class BillingStop extends ProviderError {
  constructor(message: string, code: "wallet" | "margin") {
    super(message, { fatal: true, code });
    this.name = "BillingStop";
  }
}

export const WALLET_EMPTY_MESSAGE = "Seus créditos acabaram. O que já foi traduzido está salvo — adicione créditos para continuar.";
const MARGIN_MESSAGE = "Pausamos esta tradução: ela está custando mais que o previsto. Nada foi perdido.";

/** Execuções abertas neste processo (para fechar reservas esquecidas após um reinício). */
const openRuns = new Set<string>();

export function activeRunIds() {
  return new Set(openRuns);
}

export class RunLedger {
  private run: TranslationRun;
  private started = Date.now();
  private enforce: boolean;

  private constructor(
    private bookId: string,
    run: TranslationRun,
  ) {
    this.run = run;
    this.enforce = run.credits.mode === "enforce" && run.billing === "hosted" && run.kind === "translation";
  }

  /**
   * Abre uma execução. Em modo enforce com serviço hosted, reserva os créditos
   * das palavras que faltam (ou só o saldo, se `partial`), ou lança BillingStop.
   */
  static async open(
    meta: BookMeta,
    kind: TranslationRun["kind"],
    provider: { id: string; model: string; billing: TranslationRun["billing"] },
    opts: { partial?: boolean } = {},
  ): Promise<RunLedger> {
    const quality = qualityOfModel(provider.model);
    const run: TranslationRun = {
      id: `run_${globalThis.crypto.randomUUID().slice(0, 12)}`,
      kind,
      provider: provider.id,
      model: provider.model,
      billing: provider.billing,
      startedAt: new Date().toISOString(),
      activeMs: 0,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: usageCostUsd(provider.model, 0, 0),
      words: 0,
      segments: 0,
      chapters: 0,
      credits: { quality: quality.id, per1k: quality.creditsPer1k, valueMilli: 0, reservedMilli: 0, chargedMilli: 0, mode: billingMode() },
    };
    const ledger = new RunLedger(meta.id, run);
    if (ledger.enforce) {
      const remaining = Math.max(0, meta.totals.words - meta.progress.translatedWords);
      try {
        run.credits.reservedMilli = await wallet.reserve(run.id, meta.id, milliFor(remaining, quality.creditsPer1k), {
          partial: opts.partial,
          // o suficiente para pelo menos um parágrafo
          minMilli: milliFor(50, quality.creditsPer1k),
        });
      } catch (err) {
        if (err instanceof WalletError) throw new BillingStop(err.message, "wallet");
        throw err;
      }
    }
    openRuns.add(run.id);
    await store.update(meta.id, (m) => {
      m.runs = [...(m.runs ?? []), run].slice(-200);
    });
    return ledger;
  }

  get id() {
    return this.run.id;
  }

  private async save(persist = false) {
    const snapshot = { ...this.run, credits: { ...this.run.credits } };
    await store.update(
      this.bookId,
      (m) => {
        const i = (m.runs ?? []).findIndex((r) => r.id === snapshot.id);
        if (i >= 0) m.runs![i] = snapshot;
      },
      { persist },
    );
  }

  /** Valor líquido (R$) de créditos, no menor preço por crédito do catálogo, já sem taxas e impostos. */
  private netBrl(milli: number) {
    return (milli / CREDIT.milli) * minCreditPriceBrl() * netFactor();
  }

  private costBrl() {
    return (this.run.costUsd ?? 0) * brlPerUsd();
  }

  /** Tokens de um pedido ao modelo. Pode lançar BillingStop se o gasto disparar sem progresso. */
  async usage(u: { inputTokens: number; outputTokens: number }) {
    this.run.requests++;
    this.run.inputTokens += u.inputTokens;
    this.run.outputTokens += u.outputTokens;
    this.run.costUsd = usageCostUsd(this.run.model, this.run.inputTokens, this.run.outputTokens);
    await this.save();
    // nunca gastar mais que o valor de tudo o que foi reservado (ex.: novas tentativas em excesso)
    if (this.enforce && this.costBrl() > this.netBrl(this.run.credits.reservedMilli) * ECONOMICS.runCostCeiling + 0.05) {
      throw new BillingStop(MARGIN_MESSAGE, "margin");
    }
  }

  /** Antes de enviar um lote: a reserva precisa cobrir as palavras dele. */
  async beforeBatch(words: number) {
    if (!this.enforce) return;
    const need = milliFor(words, this.run.credits.per1k);
    if (this.run.credits.reservedMilli - this.run.credits.chargedMilli < need) throw new BillingStop(WALLET_EMPTY_MESSAGE, "wallet");
  }

  /** Palavras salvas: entram no registro e, em modo enforce, são descontadas. */
  async progress(delta: { words: number; segments: number }) {
    this.run.words += delta.words;
    this.run.segments += delta.segments;
    const milli = milliFor(delta.words, this.run.credits.per1k);
    this.run.credits.valueMilli += this.run.billing === "hosted" ? milli : 0;
    if (this.enforce) this.run.credits.chargedMilli += await wallet.capture(this.run.id, milli);
    await this.save();
    // margem: o custo real até aqui não pode passar do que já foi cobrado (com folga de R$ 0,05)
    if (this.enforce && this.costBrl() > this.netBrl(this.run.credits.chargedMilli) * ECONOMICS.runCostCeiling + 0.05) {
      throw new BillingStop(MARGIN_MESSAGE, "margin");
    }
  }

  /** Fecha a execução: tempo total, capítulos concluídos, motivo e devolução do que sobrou da reserva. */
  async close(stopReason: string, chapters = 0) {
    openRuns.delete(this.run.id);
    this.run.chapters = chapters;
    this.run.endedAt = new Date().toISOString();
    this.run.activeMs = Date.now() - this.started;
    this.run.stopReason = stopReason;
    if (this.enforce) await wallet.release(this.run.id, `${this.run.words} palavras`).catch(() => 0);
    if (await store.get(this.bookId)) await this.save(true);
  }
}
