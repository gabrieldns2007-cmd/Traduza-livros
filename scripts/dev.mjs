#!/usr/bin/env node
/**
 * `npm run dev`: inicia o Next em modo de desenvolvimento e, assim que ele
 * fica pronto, abre sozinho as páginas principais (e a de cada livro) para
 * que sejam compiladas antes do primeiro toque. Em máquinas lentas (como o
 * Codespace básico) isso evita esperar a cada página aberta pela primeira vez.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const port = Number(process.env.PORT) || 3000;
const base = `http://127.0.0.1:${port}`;
const nextBin = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");

const child = spawn(process.execPath, [nextBin, "dev", "-H", "0.0.0.0", "-p", String(port)], { stdio: ["inherit", "pipe", "inherit"] });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));

let warmed = false;
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  if (!warmed && /Ready in/.test(chunk.toString())) {
    warmed = true;
    warmUp().catch(() => {});
  }
});

function bookIds() {
  const dir = path.join(path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data")), "books");
  try {
    return fs.readdirSync(dir).filter((id) => fs.existsSync(path.join(dir, id, "book.json")));
  } catch {
    return [];
  }
}

async function warmUp() {
  const ids = bookIds();
  const first = ids[0];
  const routes = [
    "/",
    "/livros",
    "/configuracoes",
    "/api/settings",
    "/api/books",
    ...(first ? [`/livros/${first}`, `/api/books/${first}`, `/api/books/${first}/providers`, `/api/books/${first}/glossary`] : []),
    ...ids.slice(1).map((id) => `/livros/${id}`),
  ];
  console.log("\n  Preparando as páginas (só na primeira vez; pode levar alguns minutos)…");
  for (const r of routes) {
    try {
      await fetch(base + r, { redirect: "manual", signal: AbortSignal.timeout(5 * 60_000) });
    } catch {
      /* segue para a próxima */
    }
  }
  console.log(`\n  ✓ Site pronto. Abra a porta ${port} (aba Portas → globo).\n`);
}
