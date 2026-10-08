#!/usr/bin/env node
/**
 * Custo REAL das traduções (sem alterar nada): lê BookMeta.runs de cada livro
 * e mostra tokens, custo pela tabela de preços, custo por mil palavras e — para
 * serviços com a chave do Verso — o que foi cobrado em créditos e a margem.
 *
 *   npm run custos
 *
 * Use o “custo por mil palavras” observado para recalibrar lib/billing/cost-model.ts
 * e os créditos por mil palavras de cada qualidade em lib/billing/catalog.ts.
 */
import fs from "node:fs";
import path from "node:path";

// mesmos valores de lib/billing/catalog.ts (ECONOMICS e o piso por crédito)
const BRL_PER_USD = 5.6 * 1.1;
const NET = 1 - 0.05 - 0.1;
const MIN_CREDIT_PRICE_BRL = 0.177;

const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data"));
const booksDir = path.join(dataDir, "books");
if (!fs.existsSync(booksDir)) {
  console.log(`Nenhum livro em ${booksDir}`);
  process.exit(0);
}

const usd = (v) => `US$ ${v.toFixed(v < 1 ? 4 : 2)}`;
const byModel = new Map();
let anyRun = false;

for (const id of fs.readdirSync(booksDir).sort()) {
  const f = path.join(booksDir, id, "book.json");
  if (!fs.existsSync(f)) continue;
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    continue;
  }
  const runs = meta.runs ?? [];
  if (!runs.length) continue;
  anyRun = true;
  console.log(`\n${meta.title}  (${id})`);
  for (const r of runs) {
    const cost = r.costUsd ?? 0;
    const per1k = r.words ? (cost / r.words) * 1000 : 0;
    const charged = (r.credits?.chargedMilli ?? 0) / 1000;
    const revenueBrl = charged * MIN_CREDIT_PRICE_BRL * NET;
    const margin = revenueBrl > 0 ? 1 - (cost * BRL_PER_USD) / revenueBrl : null;
    console.log(
      `  ${r.kind === "preview" ? "prévia   " : "tradução "} ${r.provider}/${r.model}  ${r.words} palavras  ` +
        `${r.inputTokens}+${r.outputTokens} tokens  ${r.costUsd === null ? "sem preço" : usd(cost)}  ` +
        `(${usd(per1k)}/mil)  ${Math.round(r.activeMs / 1000)}s  ${r.chapters} cap.` +
        (r.billing === "hosted"
          ? `  cobrado: ${charged.toFixed(1)} créd.${margin !== null ? `  margem ≈ ${(margin * 100).toFixed(0)}%` : ""}`
          : `  [${r.billing}]`),
    );
    if (r.costUsd !== null && r.words > 0) {
      const m = byModel.get(r.model) ?? { words: 0, cost: 0, runs: 0, per1k: [] };
      m.words += r.words;
      m.cost += cost;
      m.runs++;
      m.per1k.push(per1k);
      byModel.set(r.model, m);
    }
  }
}

if (!anyRun) {
  console.log("Ainda não há execuções registradas (elas passam a ser gravadas a partir desta versão).");
  process.exit(0);
}

console.log("\nPor modelo (observado)");
for (const [model, m] of byModel) {
  const sorted = m.per1k.sort((a, b) => a - b);
  const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
  // créditos por mil palavras que manteriam 50% de margem no pior caso observado
  const need = (p90 * BRL_PER_USD) / (MIN_CREDIT_PRICE_BRL * NET * 0.5);
  console.log(
    `  ${model.padEnd(26)} ${m.runs} execuções  ${m.words} palavras  média ${usd((m.cost / m.words) * 1000)}/mil  p90 ${usd(p90)}/mil  → mínimo ${need.toFixed(2)} créd./mil`,
  );
}
