// Workers forbid runtime code generation, so the Bazaar validator (ajv) cannot run inside the Worker and only logs a
// warning there. Run the same validation here, in Node, so an invalid listing fails the build instead.
import { describe, expect, it, vi } from "vitest";
import { validateBazaarRouteExtensions, validateDiscoveryExtension } from "@x402/extensions/bazaar";
import { routes } from "../src/app.ts";

const env = { NETWORK: "base-sepolia", PAY_TO: "0x951BD91AD61d2D867F21b54D2f717D8FFF4aD28a" };

describe("Bazaar listing", () => {
  it("every paid route declares a valid discovery extension", () => {
    const r = routes(env);
    expect(Object.keys(r).sort()).toEqual(["GET /export", "GET /read", "POST /renew", "POST /write"]);
    for (const [route, cfg] of Object.entries(r)) {
      // The server adds the HTTP method per request (seen in the live 402); validate that completed form.
      const ext = cfg.extensions.bazaar;
      const sent = { ...ext, info: { ...ext.info, input: { ...ext.info.input, method: route.split(" ")[0] } } };
      const v = validateDiscoveryExtension(sent);
      expect(v, route + ": " + (v.errors ?? []).join("; ")).toMatchObject({ valid: true });
    }
  });

  it("the route-level check the middleware runs finds nothing to warn about", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    validateBazaarRouteExtensions(routes(env));
    expect([...warn.mock.calls, ...error.mock.calls]).toEqual([]);
    vi.restoreAllMocks();
  });

  it("service metadata fits the Bazaar limits (name <= 32 ASCII chars, <= 5 tags of <= 32)", () => {
    const cfg = routes(env)["POST /write"];
    expect(cfg.serviceName).toMatch(/^[\x20-\x7e]{1,32}$/);
    expect(cfg.tags.length).toBeLessThanOrEqual(5);
    for (const t of cfg.tags) expect(t).toMatch(/^[\x20-\x7e]{1,32}$/);
  });
});
