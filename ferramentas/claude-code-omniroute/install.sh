#!/usr/bin/env bash
# O GitHub Codespaces roda este arquivo sozinho em todo Codespace novo
# (com "Automatically install dotfiles" ligado). Em outra máquina: bash install.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
bash omniroute-kit/setup.sh "$@" 2>&1 | tee "$HOME/.omniroute-kit-install.log"
exit 0   # nunca impede o Codespace de abrir
