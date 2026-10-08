import { PUBLIC_MODE } from "@/lib/mode";
import { settingsRoutes } from "@/services/settings-routes";

/** Ajustes do cliente: só preferências de tradução (na versão pública, também a chave da própria pessoa). */
const routes = settingsRoutes({ secrets: PUBLIC_MODE });
export const GET = routes.GET;
export const PUT = routes.PUT;
export const POST = routes.POST;
