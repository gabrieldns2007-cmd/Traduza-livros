import { settingsRoutes } from "@/services/settings-routes";

/** Ajustes do administrador: chaves, modelos e ordem dos serviços (protegido por ADMIN_PASSWORD). */
const routes = settingsRoutes({ secrets: true });
export const GET = routes.GET;
export const PUT = routes.PUT;
export const POST = routes.POST;
