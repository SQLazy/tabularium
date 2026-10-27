// Bazaar listing details for the four paid routes. The CDP facilitator catalogs a route after its first settled
// payment. Descriptions describe the endpoint; the Bazaar content policy bars text that instructs an agent.
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

const entry = {
  seq: 3,
  ts: 1790000000000,
  op: "write",
  key: "notes/today",
  valueHash: "<sha256 hex of the value>",
  prev: "<hash of entry 2>",
  hash: "<sha256 hex of this entry>",
};
const head = { seq: 3, hash: "<entry hash>", sig: "<base64 Ed25519 signature over the head>" };

export const SERVICE = {
  serviceName: "Tabularium",
  tags: ["agent-memory", "storage", "verifiable", "hash-chain", "key-value"],
};

export const DISCOVERY = {
  write: declareDiscoveryExtension({
    bodyType: "json",
    input: { key: "notes/today", value: "Met the supplier; follow up Friday.", idempotency_key: "retry-7f3a" },
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", pattern: "^[A-Za-z0-9._:/-]{1,128}$", description: "Key to append under" },
        value: { type: "string", maxLength: 65536, description: "UTF-8 value, up to 64 KB" },
        idempotency_key: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$", description: "Optional retry id; a repeat returns the original entry" },
      },
      required: ["key", "value"],
    },
    output: { example: { ok: true, wallet: "0x...", entry, expiresAt: 1792592000000, head } },
  }),
  read: declareDiscoveryExtension({
    input: { key: "notes/today" },
    inputSchema: { type: "object", properties: { key: { type: "string", pattern: "^[A-Za-z0-9._:/-]{1,128}$" } }, required: ["key"] },
    output: { example: { ok: true, wallet: "0x...", key: "notes/today", value: "Met the supplier; follow up Friday.", entry, state: "active", expiresAt: 1792592000000 } },
  }),
  renew: declareDiscoveryExtension({
    bodyType: "json",
    input: {},
    inputSchema: { type: "object", properties: {} },
    output: { example: { ok: true, wallet: "0x...", entry: { ...entry, op: "renew", key: "" }, expiresAt: 1795184000000, head } },
  }),
  export: declareDiscoveryExtension({
    input: { since: 0 },
    inputSchema: { type: "object", properties: { since: { type: "integer", minimum: 0, description: "Only entries after this seq" } } },
    output: {
      example: { ok: true, wallet: "0x...", anchor: "0".repeat(64), entries: [entry], values: { "notes/today": { seq: 3, value: "Met the supplier; follow up Friday." } }, head },
    },
  }),
};
