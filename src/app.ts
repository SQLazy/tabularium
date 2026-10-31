// The Worker app: the platform (src/core) with every registered service (src/services).
import type { Env } from "./env";
import { createPlatform, platformRoutes } from "./core/platform";
import { SERVICES } from "./services";
import { registerAyb } from "./pages/ayb";
import { MCP_PATH, handleMcp, mcpTools } from "./mcp";

export { CAIP2, PAYMENT_HEADER, payerOf, paymentNonce } from "./core/identity";

/** The x402 route table (used by the Bazaar validation test). */
export const routes = (env: Env) => platformRoutes(env, SERVICES);

export const createApp = (opts: { paywall: boolean }) => {
  const app = createPlatform(SERVICES, opts);
  registerAyb(app); // free page: /allyourbase
  // Remote MCP (free to connect; paid tools take x402 in _meta). Each tool call re-enters this same app, so the
  // paywall and every per-route rule run exactly as they do for a plain HTTP client.
  const tools = mcpTools(SERVICES);
  app.on(["POST", "GET", "DELETE", "OPTIONS"], MCP_PATH, (c) =>
    handleMcp(c.req.raw, { tools, forward: async (req) => app.fetch(req, c.env, c.executionCtx) }),
  );
  return app;
};
