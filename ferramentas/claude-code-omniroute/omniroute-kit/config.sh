# Configuração única do kit. Vale para todo Codespace e toda instalação.
# Nada aqui é segredo: as chaves vêm de variáveis de ambiente (segredos do Codespaces).

OMNI_VERSION="3.8.54"          # versão do OmniRoute instalada quando ele não existir
OMNI_PORT="${OMNI_PORT:-20128}"
OMNI_URL="http://127.0.0.1:${OMNI_PORT}"
COMBO_NAME="claude-code"       # o Claude Code sempre pede este combo; a ordem fica no OmniRoute

# Segredo (variável de ambiente) -> provedor do OmniRoute.
# Só provedores oficiais com cota grátis legítima e termos verificados.
PROVIDER_SECRETS=(
  "GEMINI_API_KEY:gemini"
  "ZAI_API_KEY:zai"
  "OPENROUTER_API_KEY:openrouter"
)

# Ordem de troca automática (estratégia "priority").
# Um modelo só entra no combo se o provedor dele estiver conectado.
# No Gemini, cada modelo tem a própria cota diária, então dois modelos = mais continuidade.
COMBO_MODELS=(
  "gemini/gemini-3.8-flash"
  "zai/glm-4.7-flash"
  "gemini/gemini-3.1-flash-lite"
  "openrouter/openrouter/free"
)
# Fora de propósito:
#  - cloudflare-ai: a cota grátis é a mesma que traduz os livros do Verso.
#  - groq: limite de 8 mil tokens por minuto, menor que um pedido típico do Claude Code.
#  - revendas, logins de assinatura e provedores marcados "avoid": termos proíbem ou arriscados.

# Personalizações desta máquina (opcional, fora do repositório): ~/.omniroute-kit/local.sh
# Ex.: acrescentar um provedor ou mudar a ordem do combo só aqui.
if [ -f "$HOME/.omniroute-kit/local.sh" ]; then . "$HOME/.omniroute-kit/local.sh"; fi
