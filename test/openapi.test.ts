// /openapi.json must satisfy the Agentcash Discovery v1 profile that x402scan and AgentCash read:
// required top-level fields; every operation has a summary, an explicit security and responses; every paid route
// has fixed USD x-payment-info matching the menu price and a 402 response; free routes carry no payment info.
import { describe, expect, it } from "vitest";
import { openApi } from "../src/openapi";
import { PRICES } from "../src/policy";
import type { Env } from "../src/env";

const origin = "https://tabularium.example";
const doc = openApi({ NETWORK: "base" } as Env, origin) as any;
const ops = Object.entries(doc.paths).flatMap(([path, methods]: [string, any]) =>
  Object.entries(methods).map(([method, op]: [string, any]) => ({ path, method, op })),
);
const PAID: Record<string, keyof typeof PRICES> = { "post /write": "write", "get /read": "read", "post /renew": "renew", "get /export": "export" };

describe("openapi.json", () => {
  it("has the required top-level fields and points at llms.txt", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("Tabularium");
    expect(typeof doc.info.version).toBe("string");
    expect(doc.servers[0].url).toBe(origin);
    expect(doc["x-agentcash-guidance"].llmsTxtUrl).toBe(`${origin}/llms.txt`);
  });

  it("gives every operation a summary, an explicit security and responses", () => {
    for (const { op } of ops) {
      expect(typeof op.summary).toBe("string");
      expect(op.security).toEqual([]);
      expect(Object.keys(op.responses).length).toBeGreaterThan(0);
    }
  });

  it("prices exactly the four paid calls, as the menu does, each with a 402", () => {
    const paid = ops.filter(({ op }) => op["x-payment-info"]);
    expect(paid.map(({ method, path }) => `${method} ${path}`).sort()).toEqual(Object.keys(PAID).sort());
    for (const { method, path, op } of paid) {
      const info = op["x-payment-info"];
      expect(info.price).toEqual({ mode: "fixed", currency: "USD", amount: PRICES[PAID[`${method} ${path}`]].slice(1) });
      expect(info.protocols).toEqual([{ x402: {} }]);
      expect(op.responses["402"]).toBeTruthy();
    }
  });

  it("describes the testnet when the service runs on it", () => {
    const test = openApi({ NETWORK: "base-sepolia" } as Env, origin) as any;
    expect(test.info.description).toContain("eip155:84532");
    expect(doc.info.description).toContain("eip155:8453)");
  });
});
