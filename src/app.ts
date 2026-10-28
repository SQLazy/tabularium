// The Worker app: the platform (src/core) with every registered service (src/services).
import type { Env } from "./env";
import { createPlatform, platformRoutes } from "./core/platform";
import { SERVICES } from "./services";
import { registerAyb } from "./pages/ayb";

export { CAIP2, PAYMENT_HEADER, payerOf, paymentNonce } from "./core/identity";

/** The x402 route table (used by the Bazaar validation test). */
export const routes = (env: Env) => platformRoutes(env, SERVICES);

export const createApp = (opts: { paywall: boolean }) => {
  const app = createPlatform(SERVICES, opts);
  registerAyb(app); // free page: /allyourbase
  return app;
};
