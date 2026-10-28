// The memory service: Tabularium's original four calls, at their original root paths (they never move).
// A private, hash-chained workspace per paying wallet, with Ed25519-signed heads that verify offline.
import { POLICY, PRICES } from "../policy";
import { signHead } from "../chain";
import { DISCOVERY, SERVICE } from "../discovery";
import { walletStub, type C } from "../core/identity";
import { signingKey } from "../core/signing";
import type { Service } from "../core/service";
import { memoryLlms } from "../llms";

const DAY = 86_400_000;

// ---- OpenAPI pieces --------------------------------------------------------------------------
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
const ERR = (description: string) => json({ type: "object", properties: { error: { type: "string" } } }, description);

// A missing workspace must 404 for free on the upfront routes, not after taking the payment. The header is not
// verified yet at this point, so this reveals only what the public /head already does.
async function workspaceExists(c: C, wallet: string): Promise<Response | null> {
  const h = await walletStub(c.env, wallet).head();
  return h.ok ? null : c.json({ error: h.error }, h.status);
}

const badSince = (c: C) => {
  const since = Number(c.req.query("since") ?? "0");
  return Number.isInteger(since) && since >= 0 ? null : since;
};

export const memory: Service = {
  id: "memory",
  ...SERVICE,
  summary: "Persistent, hash-chained memory per paying wallet, with signed heads that verify offline.",
  llms: memoryLlms,
  calls: [
    {
      name: "write",
      method: "POST",
      path: "/write",
      price: PRICES.write,
      description: "Agent memory: save a value under a key in a persistent key-value store owned by the paying wallet. The first write opens a 30-day workspace. Memory survives restarts, new machines and hand-offs between agents. Every write is hash-chained and signed (Ed25519), so the history verifies offline. Values up to 64 KB; failed writes are not charged.",
      discovery: DISCOVERY.write,
      menu: { call: "POST /write", price: PRICES.write, body: { key: "string", value: "string", idempotency_key: "string, optional: a retry with the same id and body returns the original entry instead of appending again" } },
      openapi: {
        operationId: "write",
        summary: "Append a value under a key in the paying wallet's workspace",
        description: "Hash-chained and signed. The first write opens the workspace. A repeat with the same idempotency_key and body returns the original entry (replayed: true).",
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
          "409": ERR("Workspace lapsed, idempotency conflict, or payment reused (not charged)"),
          "413": ERR("Value over the size limit (not charged)"),
        },
      },
      handler: async (c, wallet) => {
        const body = (await c.req.json().catch(() => null)) as { key?: unknown; value?: unknown; idempotency_key?: unknown } | null;
        if (!body || typeof body.key !== "string" || typeof body.value !== "string") {
          return c.json({ error: "body_must_be_{key:string,value:string,idempotency_key?:string}" }, 400);
        }
        if (!POLICY.KEY_PATTERN.test(body.key)) return c.json({ error: "bad_key", pattern: POLICY.KEY_PATTERN.source }, 400);
        let idem: string | undefined;
        if (body.idempotency_key !== undefined) {
          if (typeof body.idempotency_key !== "string" || !POLICY.IDEMPOTENCY_PATTERN.test(body.idempotency_key)) {
            return c.json({ error: "bad_idempotency_key", pattern: POLICY.IDEMPOTENCY_PATTERN.source }, 400);
          }
          idem = body.idempotency_key;
        }
        const sk = await signingKey(c.env); // before any state change: a bad key must fail without writing
        const r = await walletStub(c.env, wallet).write(body.key, body.value, idem);
        if (!r.ok) return c.json({ error: r.error, expiresAt: r.expiresAt, graceEndsAt: r.graceEndsAt }, r.status);
        const sig = await signHead(sk, wallet, r.entry.seq, r.entry.hash);
        return c.json({ ok: true, wallet, entry: r.entry, expiresAt: r.expiresAt, ...(r.replayed ? { replayed: true } : {}), head: { seq: r.entry.seq, hash: r.entry.hash, sig } });
      },
    },
    {
      name: "read",
      method: "GET",
      path: "/read",
      price: PRICES.read,
      description: "Agent memory: read the latest value for a key from the paying wallet's persistent key-value store, with its signed hash-chain entry. Reads keep working through the 90-day grace period after the term ends. A missing key returns 404 and is not charged.",
      discovery: DISCOVERY.read,
      menu: { call: "GET /read?key=", price: PRICES.read },
      openapi: {
        operationId: "read",
        summary: "Latest value for a key, with its chain entry",
        parameters: [{ name: "key", in: "query", required: true, schema: KEY }],
        responses: {
          "200": json({ type: "object", properties: { ok: { type: "boolean" }, key: { type: "string" }, value: { type: "string" }, entry: ENTRY, state: { type: "string" }, expiresAt: { type: "integer" } } }, "The value"),
          "404": ERR("No such key or workspace (not charged)"),
        },
      },
      handler: async (c, wallet) => {
        const key = c.req.query("key") ?? "";
        if (!POLICY.KEY_PATTERN.test(key)) return c.json({ error: "bad_key", pattern: POLICY.KEY_PATTERN.source }, 400);
        const r = await walletStub(c.env, wallet).read(key);
        if (!r.ok) return c.json({ error: r.error }, r.status);
        return c.json({ ok: true, wallet, key: r.key, value: r.value, entry: r.entry, state: r.state, expiresAt: r.expiresAt });
      },
    },
    {
      name: "renew",
      method: "POST",
      path: "/renew",
      price: PRICES.renew,
      description: "Agent memory: keep the paying wallet's persistent key-value store for 30 more days, counted from the later of now or its current expiry. A free pre-check rejects a wallet with no workspace before any charge.",
      discovery: DISCOVERY.renew,
      upfront: true,
      precheck: workspaceExists,
      menu: { call: "POST /renew", price: PRICES.renew },
      openapi: {
        operationId: "renew",
        summary: `Extend the workspace by ${POLICY.TERM_MS / DAY} days from the later of now or its expiry`,
        description: "Settles before it runs; a free pre-check rejects a missing workspace first.",
        responses: {
          "200": json({ type: "object", properties: { ok: { type: "boolean" }, entry: ENTRY, expiresAt: { type: "integer" }, head: HEAD } }, "Renewed"),
          "404": ERR("No workspace for this wallet (not charged)"),
        },
      },
      handler: async (c, wallet) => {
        const sk = await signingKey(c.env);
        const r = await walletStub(c.env, wallet).renew();
        if (!r.ok) return c.json({ error: r.error }, r.status);
        const sig = await signHead(sk, wallet, r.entry.seq, r.entry.hash);
        return c.json({ ok: true, wallet, entry: r.entry, expiresAt: r.expiresAt, head: { seq: r.entry.seq, hash: r.entry.hash, sig } });
      },
    },
    {
      name: "export",
      method: "GET",
      path: "/export",
      price: PRICES.export,
      description: "Agent memory: export the full signed history and current values of the paying wallet's persistent key-value store, for backup or proof. The export verifies offline against the public key in /menu, with no trust in the server. The optional since parameter returns only newer entries.",
      discovery: DISCOVERY.export,
      upfront: true,
      precheck: async (c, wallet) => (badSince(c) !== null ? c.json({ error: "bad_since" }, 400) : workspaceExists(c, wallet)),
      menu: { call: "GET /export?since=", price: PRICES.export },
      openapi: {
        operationId: "export",
        summary: "Full signed history and current values, verifiable offline",
        description: "Settles before it runs; a free pre-check rejects a missing workspace first. Verify with verifier/verify.mjs from the repository.",
        parameters: [{ name: "since", in: "query", required: false, schema: { type: "integer", minimum: 0 }, description: "Only entries after this seq" }],
        responses: {
          "200": json({ type: "object", properties: { ok: { type: "boolean" }, anchor: { type: "string" }, entries: { type: "array", items: ENTRY }, values: { type: "object" }, head: HEAD } }, "The export"),
          "404": ERR("No workspace for this wallet (not charged)"),
        },
      },
      handler: async (c, wallet) => {
        if (badSince(c) !== null) return c.json({ error: "bad_since" }, 400);
        const r = await walletStub(c.env, wallet).export(Number(c.req.query("since") ?? "0"));
        if (!r.ok) return c.json({ error: r.error }, r.status);
        const sig = await signHead(await signingKey(c.env), wallet, r.head.seq, r.head.hash);
        const { ok: _ok, head, ...rest } = r;
        return c.json({ ok: true, wallet, ...rest, head: { ...head, sig } });
      },
    },
  ],
  free: [
    {
      // Public by design: lets third parties check a head you hand them. Reveals only seq + hash.
      method: "GET",
      path: "/head",
      menu: "GET /head?wallet=0x...",
      openapi: {
        operationId: "head",
        summary: "Free: signed head (seq + hash, no values), state and expiry for a wallet's workspace",
        parameters: [{ name: "wallet", in: "query", required: true, schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } }],
        responses: { "200": json(HEAD, "The signed head"), "404": ERR("No workspace") },
      },
      handler: async (c) => {
        const wallet = (c.req.query("wallet") ?? "").toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(wallet)) return c.json({ error: "bad_wallet" }, 400);
        const r = await walletStub(c.env, wallet).head();
        if (!r.ok) return c.json({ error: r.error }, r.status);
        const sig = await signHead(await signingKey(c.env), wallet, r.head.seq, r.head.hash);
        return c.json({ wallet, ...r.head, state: r.state, expiresAt: r.expiresAt, sig });
      },
    },
  ],
};
