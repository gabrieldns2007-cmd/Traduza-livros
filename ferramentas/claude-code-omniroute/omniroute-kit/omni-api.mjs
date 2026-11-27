// Fala com o OmniRoute local pela API de gerenciamento, com o mesmo token de máquina
// que o próprio CLI `omniroute` usa (só funciona de dentro desta máquina).
// Nunca imprime chaves: respostas passam por mask() antes de aparecer.
//
// node omni-api.mjs <url> providers            -> lista provedores conectados (sem chaves)
// node omni-api.mjs <url> add-provider <id> <ENV_VAR>
// node omni-api.mjs <url> combos
// node omni-api.mjs <url> ensure-combo <nome> <modelo1,modelo2,...>
// node omni-api.mjs <url> create-key <nome> <arquivo-destino>
// node omni-api.mjs <url> test-combo <nome>
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const [url, cmd, ...args] = process.argv.slice(2);

function packageRoot() {
  const bin = execSync("command -v omniroute", { shell: "/bin/bash" }).toString().trim();
  return path.resolve(path.dirname(fs.realpathSync(bin)), "..");
}
async function token() {
  const mod = await import(pathToFileURL(path.join(packageRoot(), "bin/cli/utils/cliToken.mjs")).href);
  return mod.getCliToken();
}
const mask = (s) =>
  String(s).replace(/(sk-|oma_|AIza|gsk_|sk-or-)[A-Za-z0-9_\-]{4,}/g, "$1***").replace(/("(?:apiKey|key|token|credential|accessToken|refreshToken)"\s*:\s*")[^"]+"/gi, '$1***"');

async function call(method, p, body) {
  const headers = { "content-type": "application/json", "x-omniroute-cli-token": await token() };
  const res = await fetch(url + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`${method} ${p} -> HTTP ${res.status}: ${mask(text).slice(0, 400)}`);
  return json ?? text;
}
const list = (x, k) => (Array.isArray(x) ? x : x?.[k] ?? x?.data ?? []);

async function providers() {
  return list(await call("GET", "/api/providers"), "connections").map((c) => ({
    id: c.id, provider: c.provider, name: c.name, active: c.isActive !== false,
  }));
}

try {
  if (cmd === "providers") {
    console.log(JSON.stringify(await providers()));
  } else if (cmd === "add-provider") {
    const [provider, envVar] = args;
    const existing = (await providers()).filter((c) => c.provider === provider);
    if (existing.length) { console.log(`já conectado: ${provider} (não duplico nem sobrescrevo)`); process.exit(0); }
    const apiKey = process.env[envVar];
    if (!apiKey) { console.log(`sem segredo ${envVar}: ${provider} fica de fora`); process.exit(0); }
    await call("POST", "/api/providers", { provider, name: `${provider} (kit)`, apiKey });
    console.log(`conectado: ${provider}`);
  } else if (cmd === "combos") {
    console.log(JSON.stringify(list(await call("GET", "/api/combos"), "combos").map((c) => ({ name: c.name, strategy: c.strategy, models: (c.models || []).map((m) => m.model ?? m) }))));
  } else if (cmd === "ensure-combo") {
    const [name, csv] = args;
    const models = csv.split(",").filter(Boolean);
    const description = "Claude Code: troca automática entre provedores grátis (kit)";
    const combos = list(await call("GET", "/api/combos"), "combos");
    const existing = combos.find((c) => c.name === name);
    if (existing) {
      const ownedByKit = String(existing.description || "").includes("(kit)");
      const current = (existing.models || []).map((m) => m.model ?? m);
      if (!ownedByKit) { console.log(`combo ${name} já existe e foi criado por você (mantido como está)`); process.exit(0); }
      if (!models.length || current.join(",") === models.join(",")) { console.log(`combo ${name} já está em dia: ${current.join(" -> ")}`); process.exit(0); }
      await call("PUT", `/api/combos/${existing.id}`, { name, strategy: existing.strategy || "priority", models, description, config: existing.config || {} });
      console.log(`combo ${name} atualizado: ${models.join(" -> ")}`);
      process.exit(0);
    }
    if (!models.length) { console.log(`nenhum provedor conectado: combo ${name} não criado`); process.exit(3); }
    await call("POST", "/api/combos", { name, strategy: "priority", models, description });
    console.log(`combo ${name} criado: ${models.join(" -> ")}`);
  } else if (cmd === "create-key") {
    const [name, dest] = args;
    if (fs.existsSync(dest) && fs.readFileSync(dest, "utf8").trim()) { console.log("chave do Claude Code já existe (mantida)"); process.exit(0); }
    const out = await call("POST", "/api/keys", { name });
    const key = out?.key;
    if (!key) throw new Error("o OmniRoute não devolveu a chave");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, key, { mode: 0o600 });
    console.log(`chave "${name}" criada e guardada em ${dest} (só você lê)`);
  } else {
    console.error("comando desconhecido");
    process.exit(1);
  }
} catch (e) {
  console.error("ERRO:", mask(e.message));
  process.exit(2);
}
