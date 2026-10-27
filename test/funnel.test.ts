// The funnel's classification rules: what counts as a quote, a paid call or a rejected payment, and how a
// User-Agent is reduced to a coarse family (the raw string is never stored).
import { describe, expect, it } from "vitest";
import { clientFamily, funnelKind } from "../src/core/funnel";
import { SERVICES } from "../src/services";
import { platformRoutes } from "../src/core/platform";
import type { Env } from "../src/env";

describe("funnelKind", () => {
  it("a 402 to a client that sent no payment is a quote", () => {
    expect(funnelKind({ status: 402, hasPayment: false, charged: false })).toBe("quoted");
  });
  it("a payment that was charged is paid; one that was not is rejected", () => {
    expect(funnelKind({ status: 200, hasPayment: true, charged: true })).toBe("paid");
    expect(funnelKind({ status: 402, hasPayment: true, charged: false })).toBe("rejected");
    expect(funnelKind({ status: 409, hasPayment: true, charged: false })).toBe("rejected");
    expect(funnelKind({ status: 400, hasPayment: true, charged: false })).toBe("rejected");
  });
  it("anything else is not a funnel event", () => {
    expect(funnelKind({ status: 400, hasPayment: false, charged: false })).toBeNull();
    expect(funnelKind({ status: 404, hasPayment: false, charged: false })).toBeNull();
  });
});

describe("clientFamily", () => {
  it.each([
    ["agentcash/0.17.1 node/24", "agentcash"],
    ["x402scan-probe/1.0", "x402scan"],
    ["tabularium-mcp/0.4.0", "tabularium-mcp"],
    ["Claude-User (claude-code/2.1)", "anthropic"],
    ["python-httpx/0.28.1", "python"],
    ["node", "node"],
    ["axios/1.7.9", "node"],
    ["curl/8.9.1", "curl"],
    ["Go-http-client/2.0", "go"],
    ["Mozilla/5.0 (compatible; Googlebot/2.1)", "bot"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130", "browser"],
    ["", "none"],
    [undefined, "none"],
    ["something-new/1", "other"],
  ])("%s -> %s", (ua, family) => {
    expect(clientFamily(ua)).toBe(family);
  });
});

describe("services", () => {
  it("ids are unique and every paid route belongs to exactly one service", () => {
    const ids = SERVICES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = SERVICES.flatMap((s) => s.calls.map((c) => `${c.method} ${c.path}`));
    expect(new Set(keys).size).toBe(keys.length);
    expect(Object.keys(platformRoutes({ NETWORK: "base", PAY_TO: "0x951BD91AD61d2D867F21b54D2f717D8FFF4aD28a" } as unknown as Env, SERVICES)).sort()).toEqual([...keys].sort());
  });
  it("memory keeps its original four paid routes at the root", () => {
    const memory = SERVICES.find((s) => s.id === "memory")!;
    expect(memory.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /write", "GET /read", "POST /renew", "GET /export"]);
  });
  it("new services live under their own path prefix", () => {
    for (const s of SERVICES.filter((x) => x.id !== "memory")) {
      for (const c of s.calls) expect(c.path.startsWith(`/${s.id}/`)).toBe(true);
    }
  });
  it("upfront (settle-first) calls always carry a free precheck", () => {
    for (const s of SERVICES) for (const c of s.calls) if (c.upfront) expect(typeof c.precheck).toBe("function");
  });
});
