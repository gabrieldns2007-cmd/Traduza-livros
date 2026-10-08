/**
 * Versão pública (NEXT_PUBLIC_VERSO_MODE=public): login com Google, cada pessoa
 * usa a própria chave gratuita e os livros ficam no aparelho dela — o servidor
 * só entrega as páginas. Sem a variável, o Verso funciona como antes (servidor
 * próprio, livros em DATA_DIR).
 */
export const PUBLIC_MODE = process.env.NEXT_PUBLIC_VERSO_MODE === "public";

/**
 * Endereço do serviço gratuito. O Gemini e o Groq aceitam chamadas diretas do
 * navegador; o GitHub Models não, então no navegador ele passa pelo repasse
 * sem estado (/api/relay/github).
 */
export function freeServiceBase(id: "github" | "groq"): string {
  if (id === "groq") return "https://api.groq.com/openai/v1";
  return typeof window === "undefined" ? "https://models.github.ai/inference" : `${window.location.origin}/api/relay/github`;
}
