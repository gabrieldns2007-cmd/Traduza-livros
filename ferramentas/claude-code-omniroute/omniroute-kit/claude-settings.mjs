// Liga/desliga o OmniRoute no ~/.claude/settings.json sem tocar no resto do arquivo.
// node claude-settings.mjs apply  <omniUrl> <combo> [--dry-run]
// node claude-settings.mjs remove [--dry-run]
// node claude-settings.mjs status
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = os.homedir();
const dir = process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
const file = path.join(dir, "settings.json");
const backupDir = path.join(home, ".claude-backup-omniroute");
const marker = path.join(backupDir, "aplicado.json");
const helper = path.join(home, ".local", "bin", "omniroute-chave");
const [cmd, ...rest] = process.argv.slice(2);
const dry = rest.includes("--dry-run");
const args = rest.filter((a) => a !== "--dry-run");

function read() {
  if (!fs.existsSync(file)) return { exists: false, data: {} };
  const raw = fs.readFileSync(file, "utf8");
  try {
    return { exists: true, data: raw.trim() ? JSON.parse(raw) : {}, raw };
  } catch {
    console.error(`ERRO: ${file} não é um JSON válido. Nada foi alterado.`);
    process.exit(2);
  }
}
function write(data) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + ".tmp-omniroute";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
const show = (o) => console.log(JSON.stringify(o, null, 2));

if (cmd === "apply") {
  const [url, combo] = args;
  if (!url || !combo) { console.error("uso: apply <url> <combo>"); process.exit(1); }
  const cur = read();
  const env = {
    ANTHROPIC_BASE_URL: url,
    ANTHROPIC_MODEL: combo,
    ANTHROPIC_DEFAULT_OPUS_MODEL: combo,
    ANTHROPIC_DEFAULT_SONNET_MODEL: combo,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: combo,
    CLAUDE_CODE_SUBAGENT_MODEL: combo,
    // O Claude Code não sabe o tamanho real dos modelos do combo; resume a conversa
    // antes do limite do menor deles (GLM 4.7 Flash: 200 mil tokens).
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "150000",
  };
  const next = structuredClone(cur.data);
  next.env = { ...(next.env || {}), ...env };
  next.apiKeyHelper = helper;
  console.log(`${dry ? "[simulação] " : ""}Alterações em ${file}:`);
  show({ env, apiKeyHelper: helper });
  if (dry) process.exit(0);
  fs.mkdirSync(backupDir, { recursive: true });
  if (!fs.existsSync(marker)) {
    // primeira vez: guarda o original exatamente como estava
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = path.join(backupDir, `settings.original.${stamp}.json`);
    if (cur.exists) fs.writeFileSync(backup, cur.raw);
    fs.writeFileSync(
      marker,
      JSON.stringify(
        {
          arquivo: file,
          existia: cur.exists,
          copia: cur.exists ? backup : null,
          envAntes: Object.fromEntries(Object.keys(env).map((k) => [k, cur.data.env?.[k] ?? null])),
          apiKeyHelperAntes: cur.data.apiKeyHelper ?? null,
          chavesAdicionadas: Object.keys(env),
          em: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    console.log(`Cópia do original: ${cur.exists ? backup : "(não existia settings.json)"}`);
  }
  write(next);
  console.log("Pronto. Abra o Claude Code de novo para valer.");
} else if (cmd === "remove") {
  if (!fs.existsSync(marker)) { console.log("O OmniRoute não está ligado neste Claude Code (nada a desfazer)."); process.exit(0); }
  const m = JSON.parse(fs.readFileSync(marker, "utf8"));
  const cur = read();
  const next = structuredClone(cur.data);
  next.env = { ...(next.env || {}) };
  for (const k of m.chavesAdicionadas) {
    if (m.envAntes?.[k] == null) delete next.env[k];
    else next.env[k] = m.envAntes[k];
  }
  if (Object.keys(next.env).length === 0) delete next.env;
  if (m.apiKeyHelperAntes == null) delete next.apiKeyHelper;
  else next.apiKeyHelper = m.apiKeyHelperAntes;
  console.log(`${dry ? "[simulação] " : ""}O settings.json volta a ficar assim:`);
  show(next);
  if (dry) process.exit(0);
  if (!m.existia && Object.keys(next).length === 0) fs.rmSync(file, { force: true });
  else write(next);
  fs.renameSync(marker, marker.replace(/\.json$/, `.desfeito.${Date.now()}.json`));
  console.log("Pronto: o Claude Code voltou à configuração original. Abra-o de novo.");
} else if (cmd === "status") {
  const cur = read();
  const on = fs.existsSync(marker) && cur.data.env?.ANTHROPIC_BASE_URL;
  console.log(on ? `LIGADO: ${cur.data.env.ANTHROPIC_BASE_URL} combo ${cur.data.env.ANTHROPIC_MODEL}` : "DESLIGADO");
} else {
  console.error("uso: apply|remove|status");
  process.exit(1);
}
