// Workers forbid runtime code generation, so the Bazaar validator (ajv) cannot run inside the Worker and only logs a
// warning there. Run the same validation here, in Node, so an invalid listing fails the build instead.
import { describe, expect, it, vi } from "vitest";
import { validateBazaarRouteExtensions, validateDiscoveryExtension } from "@x402/extensions/bazaar";
import { routes } from "../src/app.ts";

const env = { NETWORK: "base-sepolia", PAY_TO: "0x951BD91AD61d2D867F21b54D2f717D8FFF4aD28a" };

describe("Bazaar listing", () => {
  it("every paid route declares a valid discovery extension", () => {
    const r = routes(env);
    expect(Object.keys(r).sort()).toEqual([
      "GET /export", "GET /mcp/tabularium_export", "GET /mcp/tabularium_read", "GET /read",
      "POST /mcp/tabularium_renew", "POST /mcp/tabularium_snapshot_fetch", "POST /mcp/tabularium_write",
      "POST /renew", "POST /snapshot/fetch", "POST /write",
    ]);
    for (const [route, cfg] of Object.entries(r)) {
      // HTTP routes: the server adds the HTTP method per request (seen in the live 402); validate that completed form.
      // MCP tool routes (/mcp/<tool>): sent as declared, with no method (type "mcp" allows no extra input fields).
      const ext = cfg.extensions.bazaar;
      const mcp = route.includes(" /mcp/");
      expect(ext.info.input.type, route).toBe(mcp ? "mcp" : "http");
      const sent = mcp ? ext : { ...ext, info: { ...ext.info, input: { ...ext.info.input, method: route.split(" ")[0] } } };
      const v = validateDiscoveryExtension(sent);
      expect(v, route + ": " + (v.errors ?? []).join("; ")).toMatchObject({ valid: true });
    }
  });

  it("the route-level check the middleware runs finds nothing to warn about", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    validateBazaarRouteExtensions(routes(env));
    // The helper adds an HTTP method to every declaration before validating, which a type "mcp" input forbids, so it
    // flags the MCP tool routes; the declarations as sent are validated in the test above. Nothing else may warn.
    const msgs = [...warn.mock.calls, ...error.mock.calls].map((a) => a.join(" "));
    const mcpQuirk = new RegExp('Route "(GET|POST) /mcp/tabularium_[a-z_]+" has an invalid bazaar extension: /input: must NOT have additional properties$');
    expect(msgs.filter((m) => !mcpQuirk.test(m))).toEqual([]);
    vi.restoreAllMocks();
  });

  it("service metadata fits the Bazaar limits (name <= 32 ASCII chars, <= 5 tags of <= 32)", () => {
    for (const cfg of Object.values(routes(env))) {
    expect(cfg.serviceName).toMatch(/^[\x20-\x7e]{1,32}$/);
    expect(cfg.tags.length).toBeLessThanOrEqual(5);
    for (const t of cfg.tags) expect(t).toMatch(/^[\x20-\x7e]{1,32}$/);
    }
  });
});
