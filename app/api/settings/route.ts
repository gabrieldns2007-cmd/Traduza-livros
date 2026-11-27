import { fail } from "@/lib/api";
import { PUBLIC_MODE } from "@/lib/mode";
import { settingsRoutes } from "@/services/settings-routes";

/**
 * Ajustes do cliente. No servidor próprio, o arquivo de ajustes vale para a loja
 * inteira (idioma padrão, instruções do tradutor): só o painel muda. O cliente lê
 * os padrões e escolhe as preferências de cada livro no pedido.
 * Na versão pública, cada pessoa ajusta o próprio navegador (com a própria chave).
 */
const routes = settingsRoutes({ secrets: PUBLIC_MODE });
const readOnly = async () => fail("Os ajustes da loja ficam no painel. As preferências de cada livro são escolhidas no pedido.", 403);

export const GET = routes.GET;
export const PUT = PUBLIC_MODE ? routes.PUT : readOnly;
export const POST = PUBLIC_MODE ? routes.POST : readOnly;
