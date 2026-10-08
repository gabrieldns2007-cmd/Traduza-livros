/** Identificador aleatório (Web Crypto: existe no Node 20+ e em todos os navegadores atuais). */
export function randomId(): string {
  return globalThis.crypto.randomUUID();
}
