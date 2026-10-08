#!/usr/bin/env node
/**
 * Créditos do Verso no servidor próprio (enquanto não há pagamentos):
 *
 *   npm run creditos                     mostra plano, saldo e últimos movimentos
 *   npm run creditos -- adicionar 100    credita 100 créditos (ajuste manual)
 *   npm run creditos -- plano plus       muda o plano (free | plus | pro)
 *
 * Só tem efeito com BILLING_MODE=enforce; no modo padrão (preview) nada é descontado.
 * Rode com o site desligado para evitar escrever ao mesmo tempo que ele.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const file = path.join(path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data")), "billing", "wallet.json");
const [cmd, arg] = process.argv.slice(2);

if (!fs.existsSync(file)) {
  console.log("Ainda não há carteira. Abra o site uma vez (Ajustes) para criá-la.");
  process.exit(0);
}
const w = JSON.parse(fs.readFileSync(file, "utf8"));
const save = () => {
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(w, null, 1));
  fs.renameSync(tmp, file);
};
const now = new Date().toISOString();

if (cmd === "adicionar") {
  const credits = Number(arg);
  if (!(credits > 0)) {
    console.log("Informe quantos créditos: npm run creditos -- adicionar 100");
    process.exit(1);
  }
  const milli = Math.round(credits * 1000);
  w.lots.push({ id: `lot_${randomUUID().slice(0, 12)}`, source: "adjust", milli, grantedAt: now });
  w.ledger.push({ id: `le_${randomUUID().slice(0, 12)}`, at: now, kind: "grant", milli, source: "adjust", note: "Ajuste manual" });
  save();
  console.log(`+${credits} créditos.`);
} else if (cmd === "plano") {
  if (!["free", "plus", "pro"].includes(arg)) {
    console.log("Planos: free, plus, pro");
    process.exit(1);
  }
  w.plan = arg;
  w.planSince = now;
  w.monthlyGrantedFor = undefined; // os créditos do novo plano entram na próxima leitura
  save();
  console.log(`Plano: ${arg}.`);
}

const lots = w.lots.reduce((n, l) => n + l.milli, 0);
const held = Object.values(w.reservations).reduce((n, r) => n + r.milli - r.capturedMilli, 0);
console.log(`\nPlano: ${w.plan}`);
console.log(`Saldo: ${Math.floor((lots - held) / 1000)} créditos${held ? ` (+${Math.ceil(held / 1000)} reservados)` : ""}`);
for (const e of w.ledger.slice(-8).reverse()) {
  console.log(`  ${e.at.slice(0, 16).replace("T", " ")}  ${e.kind.padEnd(6)}  ${(e.milli / 1000).toFixed(1).padStart(8)}  ${e.note ?? ""}`);
}
