#!/usr/bin/env bash
# Liga o Claude Code ao OmniRoute nesta máquina. Pode rodar quantas vezes quiser:
# não reinstala, não duplica provedores, não sobrescreve chaves nem combos existentes.
#   bash setup.sh            aplica
#   bash setup.sh --dry-run  só mostra o que faria
set -euo pipefail
KIT_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
. "$KIT_SRC/config.sh"
step() { printf '\n== %s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then echo "[simulação] $*"; else "$@"; fi; }

step "1/7 Node e OmniRoute"
command -v node >/dev/null || { echo "Node não encontrado. Instale o Node 22 ou 24."; exit 1; }
if command -v omniroute >/dev/null; then
  echo "OmniRoute já instalado: $(omniroute --version 2>/dev/null | tail -1) (não reinstalo)"
else
  echo "OmniRoute não encontrado: instalando omniroute@$OMNI_VERSION"
  run npm install -g "omniroute@$OMNI_VERSION"
fi

step "2/7 Arquivos do kit em ~/.omniroute-kit e comandos em ~/.local/bin"
run mkdir -p "$HOME/.omniroute-kit" "$HOME/.local/bin"
for f in config.sh omni-api.mjs claude-settings.mjs; do run cp "$KIT_SRC/$f" "$HOME/.omniroute-kit/$f"; done
for f in "$KIT_SRC"/bin/*; do run install -m 755 "$f" "$HOME/.local/bin/$(basename "$f")"; done

step "3/7 Iniciar o OmniRoute automaticamente ao abrir o terminal"
MARK="# >>> omniroute-kit >>>"
if grep -qF "$MARK" "$HOME/.bashrc" 2>/dev/null; then
  echo "Bloco já existe no ~/.bashrc"
elif [ "$DRY" = 1 ]; then
  echo "[simulação] acrescentar bloco omniroute-kit ao ~/.bashrc"
else
  cat >>"$HOME/.bashrc" <<'EOF'
# >>> omniroute-kit >>>
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac
# liga o OmniRoute e, uma vez por inicialização, conecta provedores de segredos novos
if [ -x "$HOME/.local/bin/omniroute-sync" ] && mkdir "/tmp/.omniroute-kit-sync-$(id -u)-$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)" 2>/dev/null; then
  ( "$HOME/.local/bin/omniroute-sync" --quiet & ) 2>/dev/null
fi
# <<< omniroute-kit <<<
EOF
  echo "Bloco acrescentado ao ~/.bashrc"
fi

if [ "$DRY" = 1 ]; then
  step "4-7 (simulação) provedores, combo, chave e Claude Code"
  for pair in "${PROVIDER_SECRETS[@]}"; do v="${pair%%:*}"; p="${pair##*:}"
    if [ -n "${!v:-}" ]; then echo "conectaria $p (segredo $v presente), se ainda não estiver conectado"; else echo "$p: sem segredo $v"; fi; done
  echo "criaria o combo $COMBO_NAME (se não existir) e uma chave para o Claude Code (se não existir)"
  node "$KIT_SRC/claude-settings.mjs" apply "$OMNI_URL" "$COMBO_NAME" --dry-run
  exit 0
fi

step "4/7 OmniRoute no ar"
"$HOME/.local/bin/omniroute-ensure" --wait

API="node $HOME/.omniroute-kit/omni-api.mjs $OMNI_URL"
step "5-6/7 Provedores (segredos do Codespaces) e combo $COMBO_NAME"
"$HOME/.local/bin/omniroute-sync"

step "7/7 Chave do Claude Code e configuração global"
$API create-key "claude-code-$(hostname -s 2>/dev/null || echo maquina)" "$HOME/.omniroute/claude-code.key"
node "$HOME/.omniroute-kit/claude-settings.mjs" apply "$OMNI_URL" "$COMBO_NAME"

printf '\nPronto. Abra um terminal novo e rode: claude\n'
echo "Voltar ao original: omniroute-desligar   |   Claude normal só desta vez: claude-original"
