# dotfiles: Claude Code + OmniRoute

Configuração pessoal que liga o **Claude Code** ao **OmniRoute** em qualquer Codespace,
de qualquer projeto, sem refazer nada. O GitHub aplica este repositório sozinho em todo
Codespace novo.

## O que acontece

- O OmniRoute liga sozinho quando o terminal abre, ou quando o Claude Code precisa dele.
- O Claude Code sempre pede o combo `claude-code`. A ordem de troca automática fica no OmniRoute:
  1. Gemini 3.8 Flash
  2. Z.AI GLM-4.7-Flash
  3. Gemini 3.1 Flash-Lite
  4. OpenRouter (modelos grátis)
- Quando um provedor esgota a cota ou cai, o próximo assume.
- Entram só os provedores cujo segredo você cadastrou, e o combo se atualiza quando chega um novo.
- O kit nunca duplica um provedor, nunca sobrescreve uma chave, e não mexe num combo `claude-code` criado por você.

Fora de propósito, porque ficam com o Verso ou os termos não permitem:
- Cloudflare;
- Groq;
- revendas e logins de assinatura (Claude Pro, ChatGPT, Gemini CLI etc.).

## Configurar (uma vez só, pelo celular)

1. **Segredos:** no GitHub, abra o menu da foto e vá em **Settings → Codespaces → Codespaces secrets → New secret**.
   - `GEMINI_API_KEY`: chave do Google AI Studio.
   - `ZAI_API_KEY` (opcional): chave grátis da Z.AI.
   - `OPENROUTER_API_KEY` (opcional): chave do OpenRouter.

   Em "Repository access", marque os repositórios onde você usa o Claude Code. Repita isso quando criar um projeto novo.
2. **Dotfiles:** na mesma página, em **Dotfiles**, ligue **Automatically install dotfiles** e escolha este repositório.
3. Pronto. Todo Codespace novo já abre com tudo ligado.

## Num Codespace que já existe

```bash
git clone https://github.com/<seu-usuario>/dotfiles ~/dotfiles
bash ~/dotfiles/install.sh --dry-run   # só mostra o que faria
bash ~/dotfiles/install.sh             # aplica
```

Segredo novo só aparece depois de parar e abrir o Codespace de novo.

## Comandos

| Comando | Para quê |
|---|---|
| `claude` | Claude Code pelo OmniRoute (modelos grátis, troca automática) |
| `claude-original` | Claude Code normal, com a sua conta da Anthropic (pede login na 1ª vez) |
| `omniroute-desligar` | Volta o `~/.claude/settings.json` ao original (`--dry-run` para ver antes) |
| `omniroute-religar` | Liga de novo |
| `omniroute-sync` | Conecta provedores de segredos novos e atualiza o combo |
| `omniroute-ensure` | Liga o OmniRoute se estiver parado |

## O que o kit altera (e só isso)

- `~/.claude/settings.json`: acrescenta o endereço do OmniRoute, o combo e o `apiKeyHelper`.
  - O original fica copiado em `~/.claude-backup-omniroute/`.
  - O resto do arquivo é mantido.
- `~/.bashrc`: um bloco marcado `omniroute-kit`.
- `~/.local/bin/`: os comandos acima.
- `~/.omniroute-kit/`: os arquivos do kit.
- `~/.omniroute/claude-code.key`: a chave do Claude Code no OmniRoute. Só você lê, e ela nunca vai para o repositório.

## Limites conhecidos

- Os modelos grátis são bem mais fracos que o Claude. Para tarefas difíceis, use `claude-original`.
- Cada Codespace tem o próprio OmniRoute e conta as cotas separadamente.
- No Gemini grátis, o Google pode usar o que você envia, e revisores humanos podem ler. Não abra arquivos com segredos nesse modo.
- Não funciona nas sessões do Claude Code na nuvem do claude.ai: lá, quem escolhe o modelo é a Anthropic.
- Personalizar só numa máquina: crie `~/.omniroute-kit/local.sh` (veja `omniroute-kit/config.sh`).
