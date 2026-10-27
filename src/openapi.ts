// /openapi.json: machine-readable discovery for agent wallets and x402 explorers (x402scan, AgentCash).
// Follows the Agentcash Discovery v1 profile: OpenAPI 3.1, `security: []` (no API key), and `x-payment-info`
// on each paid operation. Built from the live prices and policy, so it cannot drift from /menu or /llms.txt.
// Discovery metadata is advisory; the 402 challenge on each paid route is the authority.
import type { Env } from "./env";
import { POLICY, PRICES } from "./policy";

const DAY = 86_400_000;
const usd = (price: string) => price.replace(/^\$/, "");
const paid = (price: string) => ({
  security: [],
  "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: usd(price) }, protocols: [{ x402: {} }] },
});

const KEY = { type: "string", pattern: POLICY.KEY_PATTERN.source, description: "Key, e.g. notes/today" };
const ENTRY = {
  type: "object",
  description: "One hash-chained log entry",
  properties: {
    seq: { type: "integer" },
    ts: { type: "integer", description: "Unix ms" },
    op: { type: "string", enum: ["write", "renew"] },
    key: { type: "string" },
    valueHash: { type: "string", description: "sha256 hex of the value" },
    prev: { type: "string", description: "Hash of the previous entry" },
    hash: { type: "string", description: "sha256 hex of this entry" },
  },
};
const HEAD = {
  type: "object",
  description: "Signed head of the wallet's history (Ed25519, key published in /menu)",
  properties: { seq: { type: "integer" }, hash: { type: "string" }, sig: { type: "string", description: "base64" } },
};
const json = (schema: object, description: string) => ({ description, content: { "application/json": { schema } } });
const PAYMENT_REQUIRED = {
  description: "Payment required (x402 v2). The PAYMENT-REQUIRED header lists the accepted USDC payment; repeat the request with PAYMENT-SIGNATURE.",
};
const ERR = (description: string) => json({ type: "object", properties: { error: { type: "string" } } }, description);

export function openApi(env: Env, origin: string) {
  const chain = env.NETWORK === "base" ? "Base mainnet (eip155:8453)" : "Base Sepolia testnet (eip155:84532)";
  return {
    openapi: "3.1.0",
    info: {
      title: "Tabularium",
      version: "1.0.0",
      summary: "Persistent, hash-chained memory for AI agents, plus a signed ledger of what an agent buys.",
      description:
        `Pay-per-call agent memory over x402 v2, in USDC on ${chain}. No account or API key: the paying wallet is the ` +
        `identity and owns one workspace. Every write is appended to a hash chain whose head is signed (Ed25519), so an ` +
        `export verifies offline without trusting the server. Values up to ${POLICY.MAX_VALUE_BYTES / 1024} KB; the ` +
        `operator can read stored values, so encrypt secrets first. Failed calls (4xx/5xx) are not charged.`,
      "x-guidance":
        `First write opens a ${POLICY.TERM_MS / DAY}-day workspace; renew adds ${POLICY.TERM_MS / DAY} days. ` +
        `Pass idempotency_key on writes so a retry never appends twice. Full guide: ${origin}/llms.txt`,
      license: { name: "FSL-1.1-MIT (service); MIT (MCP client, verifier)", url: "https://github.com/SQLazy/tabularium#license" },
    },
    externalDocs: { description: "Source, verifier and MCP client", url: "https://github.com/SQLazy/tabularium" },
    "x-agentcash-guidance": { llmsTxtUrl: `${origin}/llms.txt` },
    servers: [{ url: origin }],
    paths: {
      "/write": {
        post: {
          operationId: "write",
          summary: "Append a value under a key in the paying wallet's workspace",
          description: "Hash-chained and signed. The first write opens the workspace. A repeat with the same idempotency_key and body returns the original entry (replayed: true).",
          ...paid(PRICES.write),
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["key", "value"],
                  properties: {
                    key: KEY,
                    value: { type: "string", maxLength: POLICY.MAX_VALUE_BYTES, description: "UTF-8 string; store JSON as a string" },
                    idempotency_key: { type: "string", pattern: POLICY.IDEMPOTENCY_PATTERN.source, description: `Optional retry id, kept ${POLICY.IDEMPOTENCY_MS / DAY} days` },
                  },
                },
                example: { key: "notes/today", value: "Met the supplier; follow up Friday.", idempotency_key: "retry-7f3a" },
              },
            },
          },
          responses: {
            "200": json({ type: "object", properties: { ok: { type: "boolean" }, wallet: { type: "string" }, entry: ENTRY, expiresAt: { type: "integer" }, head: HEAD, replayed: { type: "boolean" } } }, "Written"),
            "400": ERR("Bad key or value (not charged)"),
            "402": PAYMENT_REQUIRED,
            "409": ERR("Workspace lapsed, idempotency conflict, or payment reused (not charged)"),
            "413": ERR("Value over the size limit (not charged)"),
          },
        },
      },
      "/read": {
        get: {
          operationId: "read",
          summary: "Latest value for a key, with its chain entry",
          ...paid(PRICES.read),
          parameters: [{ name: "key", in: "query", required: true, schema: KEY }],
          responses: {
            "200": json({ type: "object", properties: { ok: { type: "boolean" }, key: { type: "string" }, value: { type: "string" }, entry: ENTRY, state: { type: "string" }, expiresAt: { type: "integer" } } }, "The value"),
            "402": PAYMENT_REQUIRED,
            "404": ERR("No such key or workspace (not charged)"),
          },
        },
      },
      "/renew": {
        post: {
          operationId: "renew",
          summary: `Extend the workspace by ${POLICY.TERM_MS / DAY} days from the later of now or its expiry`,
          description: "Settles before it runs; a free pre-check rejects a missing workspace first.",
          ...paid(PRICES.renew),
          responses: {
            "200": json({ type: "object", properties: { ok: { type: "boolean" }, entry: ENTRY, expiresAt: { type: "integer" }, head: HEAD } }, "Renewed"),
            "402": PAYMENT_REQUIRED,
            "404": ERR("No workspace for this wallet (not charged)"),
          },
        },
      },
      "/export": {
        get: {
          operationId: "export",
          summary: "Full signed history and current values, verifiable offline",
          description: "Settles before it runs; a free pre-check rejects a missing workspace first. Verify with verifier/verify.mjs from the repository.",
          ...paid(PRICES.export),
          parameters: [{ name: "since", in: "query", required: false, schema: { type: "integer", minimum: 0 }, description: "Only entries after this seq" }],
          responses: {
            "200": json({ type: "object", properties: { ok: { type: "boolean" }, anchor: { type: "string" }, entries: { type: "array", items: ENTRY }, values: { type: "object" }, head: HEAD } }, "The export"),
            "402": PAYMENT_REQUIRED,
            "404": ERR("No workspace for this wallet (not charged)"),
          },
        },
      },
      "/head": {
        get: {
          operationId: "head",
          summary: "Free: signed head (seq + hash, no values), state and expiry for a wallet's workspace",
          security: [],
          parameters: [{ name: "wallet", in: "query", required: true, schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } }],
          responses: { "200": json(HEAD, "The signed head"), "404": ERR("No workspace") },
        },
      },
      "/menu": { get: { operationId: "menu", summary: "Free: prices, policy, network, payee and the public signing key", security: [], responses: { "200": { description: "The menu (JSON)" } } } },
      "/stats": { get: { operationId: "stats", summary: "Free: public aggregates of settled calls (paying wallets, 14-day return rate)", security: [], responses: { "200": { description: "Stats (JSON)" } } } },
      "/llms.txt": { get: { operationId: "llmsTxt", summary: "Free: plain-text guide for language models", security: [], responses: { "200": { description: "text/plain" } } } },
    },
  };
}
