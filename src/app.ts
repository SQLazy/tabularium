// The Worker app: the platform (src/core) with every registered service (src/services).
import type { Env } from "./env";
import { createPlatform, platformRoutes } from "./core/platform";
import { SERVICES } from "./services";

export { CAIP2, PAYMENT_HEADER, payerOf, paymentNonce } from "./core/identity";

/** The x402 route table (used by the Bazaar validation test). */
export const routes = (env: Env) => platformRoutes(env, SERVICES);

export const createApp = (opts: { paywall: boolean }) => createPlatform(SERVICES, opts);
