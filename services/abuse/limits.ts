/**
 * Freio contra abuso nos envios: sem contas, o limite é por navegador (cookie de dono)
 * e por endereço de rede. A contagem fica na memória (zera quando o servidor reinicia),
 * o que basta para impedir que alguém lote a fila ou o disco em minutos.
 * O administrador (painel) não tem limite.
 */

const HOUR = 60 * 60_000;

function num(name: string, fallback: number) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const LIMITS = {
  /** envios por navegador por hora */
  perOwnerHour: () => num("UPLOAD_LIMIT_PER_HOUR", 10),
  /** envios por endereço de rede por hora (vários navegadores na mesma rede) */
  perIpHour: () => num("UPLOAD_LIMIT_PER_IP_HOUR", 30),
  /** livros enviados e ainda sem pedido, por navegador */
  pendingPerOwner: () => num("UPLOAD_PENDING_LIMIT", 15),
};

const hits = new Map<string, number[]>();

function recent(key: string, now: number): number[] {
  const list = (hits.get(key) ?? []).filter((t) => now - t < HOUR);
  if (list.length) hits.set(key, list);
  else hits.delete(key);
  return list;
}

export function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "local";
}

/**
 * Pode enviar mais um livro agora? Devolve a mensagem para o cliente quando não pode.
 * `pending` = livros deste navegador ainda sem pedido.
 */
export function checkUpload(owner: string | undefined, ip: string, pending: number, now = Date.now()): string | null {
  if (owner && pending >= LIMITS.pendingPerOwner()) {
    return `Você já tem ${pending} livros enviados sem pedido. Peça a tradução de algum deles ou apague os que não vai usar antes de enviar outro.`;
  }
  const byOwner = owner ? recent(`o:${owner}`, now) : [];
  const byIp = recent(`i:${ip}`, now);
  if (byOwner.length >= LIMITS.perOwnerHour() || byIp.length >= LIMITS.perIpHour()) {
    const oldest = Math.min(...[...byOwner, ...byIp].filter((t) => t !== undefined));
    const minutes = Math.max(1, Math.ceil((oldest + HOUR - now) / 60_000));
    return `Muitos envios em pouco tempo. Tente de novo em ${minutes} min.`;
  }
  return null;
}

/** Conta um envio aceito. */
export function recordUpload(owner: string | undefined, ip: string, now = Date.now()) {
  if (owner) hits.set(`o:${owner}`, [...recent(`o:${owner}`, now), now]);
  hits.set(`i:${ip}`, [...recent(`i:${ip}`, now), now]);
}

/** Só para testes. */
export function resetLimits() {
  hits.clear();
}
