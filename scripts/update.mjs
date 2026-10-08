#!/usr/bin/env node
/**
 * `npm run atualizar`: traz a versão mais nova do Verso e abre o site.
 *
 * Seguro para os seus livros: a pasta data/ e o .env.local nunca são tocados.
 *  1. guarda alterações locais nos arquivos do projeto (git stash) — nada se perde;
 *  2. baixa a versão nova;
 *  3. instala as dependências, se mudaram;
 *  4. reinicia o site (as traduções em andamento continuam de onde pararam).
 *
 *   npm run atualizar              atualiza e abre o site
 *   npm run atualizar -- --sem-site  só atualiza
 */
import { execSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";

const BRANCH = "claude/book-translation-webapp-qahww8";
const sh = (cmd) => execSync(cmd, { stdio: "pipe", encoding: "utf8" }).trim();
const say = (msg) => console.log(`\n  ${msg}`);

const before = sh("git rev-parse HEAD");
if (sh("git status --porcelain --untracked-files=no")) {
  say("Guardando alterações locais (git stash)…");
  sh('git stash push -m "verso: antes de atualizar"');
}

say("Baixando a versão nova…");
const pull = spawnSync("git", ["pull", "--no-edit", "origin", BRANCH], { stdio: "inherit" });
if (pull.status !== 0) {
  say("✗ Não consegui baixar a versão nova (veja a mensagem acima). Seus livros não foram alterados.");
  process.exit(1);
}

const after = sh("git rev-parse HEAD");
const changed = before === after ? [] : sh(`git diff --name-only ${before} ${after}`).split("\n").filter(Boolean);
// dependências: instala se faltam ou se a lista mudou desde a última instalação
const lockChanged = () => {
  try {
    return fs.statSync("package-lock.json").mtimeMs > fs.statSync("node_modules/.package-lock.json").mtimeMs;
  } catch {
    return true;
  }
};
if (!fs.existsSync("node_modules") || changed.includes("package-lock.json") || lockChanged()) {
  say("Instalando as dependências (pode levar alguns minutos)…");
  if (spawnSync("npm", ["install"], { stdio: "inherit" }).status !== 0) {
    say("✗ A instalação falhou (veja a mensagem acima).");
    process.exit(1);
  }
}
say(before === after ? "✓ Já estava na versão mais nova." : `✓ Atualizado (${changed.length} arquivos).`);

if (process.argv.includes("--sem-site")) process.exit(0);

// fecha o site antigo, se estiver aberto em outro terminal
for (const pattern of ["next-server", "next/dist/bin/next", "scripts/dev.mjs"]) spawnSync("pkill", ["-f", pattern], { stdio: "ignore" });

say("Abrindo o site…");
const child = spawn(process.execPath, ["scripts/dev.mjs"], { stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
