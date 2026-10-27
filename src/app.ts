import { Hono, type Context, type MiddlewareHandler } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import type { Env } from "./env";
import { POLICY, PRICES } from "./policy";
import { loadSigningKey, sha256Hex, signHead } from "./chain";
import { CDP_FACILITATOR_URL, cdpAuthHeaders } from "./cdp";
import { DISCOVERY, SERVICE } from "./discovery";
import { llmsTxt } from "./llms";
import { openApi } from "./openapi";
import { RETIRED_SIGNING_KEYS } from "./policy";

type C = Context<{ Bindings: Env }>;

let cachedKey: { src: string; pub: string; key: CryptoKey } | null = null;
async function signingKey(env: Env): Promise<CryptoKey> {
  const src = (env.SIGNING_KEY_PKCS8 ?? "").trim();
  const pub = (env.SIGNING_PUBKEY_HEX ?? "").trim();
  if (!cachedKey || cachedKey.src !== src || cachedKey.pub !== pub) {
    cachedKey = { src, pub, key: await loadSigningKey(src, pub) };
  }
  return cachedKey.key;
}

/** x402 v2 names networks by CAIP-2 id. */
export const CAIP2: Record<Env["NETWORK"], `${string}:${string}`> = { "base-sepolia": "eip155:84532", base: "eip155:8453" };

/** The only header the v2 server verifies. Identity must come from this header and nothing else. */
export const PAYMENT_HEADER = "PAYMENT-SIGNATURE";

/**
 * Identity = the wallet that paid. The x402 middleware has verified PAYMENT-SIGNATURE (signature, amount, payee)
 * with the facilitator before any paid handler runs, so the EIP-3009 `from` in it is the verified payer.
 * Never read X-PAYMENT (v1): the v2 server ignores it, so a caller could pay with one wallet and name another there.
 * (In the no-paywall test build the same header is supplied by the test harness.)
 */
export function payerOf(c: C): string | null {
  const h = c.req.header(PAYMENT_HEADER);
  if (!h) return null;
  try {
    const p = JSON.parse(atob(h));
    if (p?.x402Version !== 2) return null;
    const from = p?.payload?.authorization?.from;
    return typeof from === "string" && /^0x[0-9a-fA-F]{40}$/.test(from) ? from.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The EIP-3009 nonce of the payment in PAYMENT-SIGNATURE (unique per signed payment), or null. */
export function paymentNonce(c: C): string | null {
  try {
    const n = JSON.parse(atob(c.req.header(PAYMENT_HEADER) ?? ""))?.payload?.authorization?.nonce;
    return typeof n === "string" && /^0x[0-9a-fA-F]{64}$/.test(n) ? n.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** One signed payment buys one call. Returns a 409 (never settled) if this payment was already used. */
async function reusedPayment(c: C, wallet: string): Promise<Response | null> {
  const nonce = paymentNonce(c);
  if (nonce && !(await stub(c, wallet).claimPayment(nonce))) return c.json({ error: "payment_reused" }, 409);
  return null;
}

function stub(c: C, wallet: string) {
  return c.env.WORKSPACE.get(c.env.WORKSPACE.idFromName(wallet));
}

// renew and export settle UPFRONT (before the handler): each is worth more than the gas it costs to make a settlement
// fail after the handler ran (drain the wallet, or burn the nonce). A free pre-check stops charges for a missing
// workspace. write and read keep the default flow (settle after success, so failures are never charged); their
// residual exposure to that race is below the attacker's own gas cost, and payment reuse is blocked by claimPayment.
const UPFRONT = { paymentFlow: "upfront" };

export function routes(env: Env) {
  const mk = (price: string, description: string, extensions: Record<string, unknown>, extra?: Record<string, unknown>) => ({
    accepts: [{ scheme: "exact", price, network: CAIP2[env.NETWORK], payTo: env.PAY_TO, maxTimeoutSeconds: 60, ...(extra ? { extra } : {}) }],
    description,
    mimeType: "application/json",
    ...SERVICE,
    extensions,
  });
  return {
    "POST /write": mk(PRICES.write, "Append a value to a private, hash-chained workspace owned by the paying wallet.", DISCOVERY.write),
    "GET /read": mk(PRICES.read, "Latest value for a key in the paying wallet's workspace, with its chain entry.", DISCOVERY.read),
    "POST /renew": mk(PRICES.renew, "Extends the paying wallet's workspace by 30 days from the later of now or its expiry.", DISCOVERY.renew, UPFRONT),
    "GET /export": mk(PRICES.export, "Full signed history and current values of the paying wallet's workspace, verifiable offline.", DISCOVERY.export, UPFRONT),
  };
}

// The paywall must learn the facilitator's supported kinds (a fetch) before it can price a route.
// Workers rule: a promise backed by I/O in one request never resolves in another, so a shared "init in progress"
// promise hangs every other request that awaits it (it did: POST /write hung after GET /menu started the init).
// So each request that finds no ready paywall initializes its own, awaits it itself, and only the finished
// instance (plain data, no pending I/O) is shared. Concurrent cold requests may each fetch once; that is harmless.
// The middleware's own start-up sync is turned off because we did it here.
let paywall: { key: string; mw: MiddlewareHandler } | null = null;
async function paywallFor(env: Env): Promise<MiddlewareHandler> {
  const facilitator = env.FACILITATOR_URL || "https://x402.org/facilitator";
  const key = `${env.NETWORK}|${env.PAY_TO}|${facilitator}`;
  if (paywall?.key === key) return paywall.mw;
  let createAuthHeaders: ReturnType<typeof cdpAuthHeaders> | undefined;
  if (facilitator === CDP_FACILITATOR_URL) {
    if (!env.CDP_API_KEY_ID || !env.CDP_API_KEY_SECRET) throw new Error("CDP facilitator selected but CDP_API_KEY_ID/CDP_API_KEY_SECRET are not set");
    createAuthHeaders = cdpAuthHeaders(env.CDP_API_KEY_ID.trim(), env.CDP_API_KEY_SECRET);
  }
  const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitator, createAuthHeaders })).register(
    CAIP2[env.NETWORK],
    new ExactEvmScheme(),
  );
  await server.initialize();
  const mw = paymentMiddleware(routes(env), server, undefined, undefined, false) as unknown as MiddlewareHandler;
  paywall = { key, mw };
  return mw;
}

// Free routes never touch the facilitator.
const FREE = new Set(["/", "/menu", "/head", "/stats", "/llms.txt", "/openapi.json"]);

// ---- success metric: who pays, and who comes back --------------------------------------------------
const PAID_CALLS: Record<string, keyof typeof PRICES> = { "POST /write": "write", "GET /read": "read", "POST /renew": "renew", "GET /export": "export" };
const micro = (price: string) => Math.round(Number(price.replace(/^\$/, "")) * 1e6);
const statsStub = (env: Env) => env.STATS.get(env.STATS.idFromName("global"));

/** Records one charged call: hashed wallet id, call name, price. Never keys or values. Test wallets are skipped. */
async function recordCharge(c: C, ts: number): Promise<void> {
  const call = PAID_CALLS[`${c.req.method} ${c.req.path}`];
  const wallet = payerOf(c);
  if (!call || !wallet) return;
  const excluded = (c.env.EXCLUDE_WALLETS ?? "").toLowerCase().split(",").map((w) => w.trim());
  if (excluded.includes(wallet)) return statsStub(c.env).recordExcluded();
  const id = (await sha256Hex(`tabularium/stats\n${wallet}`)).slice(0, 16);
  await statsStub(c.env).record(id, call, micro(PRICES[call]), ts);
}
const later = (c: C, p: Promise<void>) => c.executionCtx.waitUntil(p.catch((err) => console.error("stats", String(err))));

export function createApp(opts: { paywall: boolean }) {
  const app = new Hono<{ Bindings: Env }>();

  if (opts.paywall) {
    // Pre-check for the upfront routes, on the paid retry (which carries PAYMENT-SIGNATURE), before anything settles:
    // a missing workspace must 404 for free, not after taking $0.25. The header is not verified yet, so this reveals
    // only what the public /head already does (whether a wallet has a live workspace).
    app.use("*", async (c, next) => {
      const upfront = (c.req.method === "POST" && c.req.path === "/renew") || (c.req.method === "GET" && c.req.path === "/export");
      const wallet = upfront ? payerOf(c) : null;
      if (!wallet) return next();
      if (c.req.path === "/export") {
        const since = Number(c.req.query("since") ?? "0");
        if (!Number.isInteger(since) || since < 0) return c.json({ error: "bad_since" }, 400);
      }
      const h = await stub(c, wallet).head();
      if (!h.ok) return c.json({ error: h.error }, h.status);
      return next();
    });
    app.use("*", async (c, next) => {
      if (FREE.has(c.req.path)) return next();
      // The middleware either returns its own response (402, errors) or sets c.res after settling: pass both through.
      const out = await (await paywallFor(c.env))(c, next);
      const res = out instanceof Response ? out : c.res;
      // Charged = success status plus the settlement receipt the x402 middleware adds after settling.
      if (res.status < 400 && res.headers.get("PAYMENT-RESPONSE")) later(c, recordCharge(c, Date.now()));
      return out;
    });
  } else {
    // Defense in depth: the no-paywall build trusts the payment header blindly, so it serves localhost only.
    app.use("*", async (c, next) => {
      const host = new URL(c.req.url).hostname;
      if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") return c.json({ error: "dev_build_local_only" }, 403);
      return next();
    });
    // No-paywall test build: every successful paid-route call counts as charged. X-Test-Now lets the e2e
    // script record calls on past days to exercise the 14-day return metric.
    app.use("*", async (c, next) => {
      await next();
      if (!FREE.has(c.req.path) && c.res.status < 400) {
        const now = Number(c.req.header("X-Test-Now") ?? Date.now());
        later(c, recordCharge(c, now));
      }
    });
  }

  // ---- free: the menu is the contract ------------------------------------------------------
  const menu = (c: C) =>
    c.json({
      name: "tabularium",
      pitch: "Four calls. Fixed prices. Your wallet is your account. Every write is hash-chained and signed.",
      network: c.env.NETWORK,
      payTo: c.env.PAY_TO,
      x402: { version: 2, network: CAIP2[c.env.NETWORK], scheme: "exact", asset: "USDC", header: PAYMENT_HEADER },
      calls: [
        { call: "POST /write", price: PRICES.write, body: { key: "string", value: "string", idempotency_key: "string, optional: a retry with the same id and body returns the original entry instead of appending again" } },
        { call: "GET /read?key=", price: PRICES.read },
        { call: "POST /renew", price: PRICES.renew },
        { call: "GET /export?since=", price: PRICES.export },
      ],
      free: ["GET /menu", "GET /head?wallet=0x...", "GET /stats", "GET /llms.txt", "GET /openapi.json"],
      policy: {
        termDays: POLICY.TERM_MS / 86_400_000,
        graceDays: POLICY.GRACE_MS / 86_400_000,
        maxValueBytes: POLICY.MAX_VALUE_BYTES,
        keyPattern: POLICY.KEY_PATTERN.source,
        billing:
          "write and read are charged only if they succeed (HTTP < 400). renew and export settle before running; a free pre-check rejects a missing workspace first. " +
          "One signed payment buys one call: a reused payment gets 409 and is not charged. A replayed idempotent write succeeds and is charged like any call.",
        idempotencyDays: POLICY.IDEMPOTENCY_MS / 86_400_000,
        lapse: "After the term: read, export and renew still work for the grace period; writes do not. Data is deleted only after grace ends.",
      },
      signing: {
        alg: "Ed25519",
        publicKeyHex: c.env.SIGNING_PUBKEY_HEX,
        headMessage: "omega/v1/head\\n<wallet>\\n<seq>\\n<hash>",
        // Earlier keys, kept forever so exports signed before a rotation still verify.
        retired: RETIRED_SIGNING_KEYS,
      },
    });
  app.get("/", menu);
  app.get("/menu", menu);

  // Plain-text description for language models: what it is, when it fits and when not, exact formats.
  app.get("/llms.txt", (c) => {
    c.header("Cache-Control", "public, max-age=300");
    return c.text(llmsTxt(c.env, new URL(c.req.url).origin));
  });

  // OpenAPI discovery for agent wallets and x402 explorers (x402scan, AgentCash): routes, prices, schemas.
  app.get("/openapi.json", (c) => {
    c.header("Cache-Control", "public, max-age=300");
    c.header("Access-Control-Allow-Origin", "*");
    return c.json(openApi(c.env, new URL(c.req.url).origin));
  });

  // Public aggregates. Every payment is public on-chain anyway; wallets appear only as counts.
  app.get("/stats", async (c) => {
    // The test build may pass ?now= (time travel, uncached); production always reads the cached live summary.
    const testNow = !opts.paywall && c.req.query("now") ? Number(c.req.query("now")) : null;
    return c.json(await statsStub(c.env).summary(testNow ?? Date.now(), testNow === null));
  });

  // Public by design: lets third parties check a head you hand them. Reveals only seq + hash.
  app.get("/head", async (c) => {
    const wallet = (c.req.query("wallet") ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(wallet)) return c.json({ error: "bad_wallet" }, 400);
    const r = await stub(c, wallet).head();
    if (!r.ok) return c.json({ error: r.error }, r.status);
    const sig = await signHead(await signingKey(c.env), wallet, r.head.seq, r.head.hash);
    return c.json({ wallet, ...r.head, state: r.state, expiresAt: r.expiresAt, sig });
  });

  // ---- paid ---------------------------------------------------------------------------------
  // Errors below return 4xx, which x402-hono does not settle. Bad requests cost nothing.

  app.post("/write", async (c) => {
    const wallet = payerOf(c);
    if (!wallet) return c.json({ error: "evm_payer_required" }, 400);
    const reused = await reusedPayment(c, wallet);
    if (reused) return reused;
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
    const r = await stub(c, wallet).write(body.key, body.value, idem);
    if (!r.ok) return c.json({ error: r.error, expiresAt: r.expiresAt, graceEndsAt: r.graceEndsAt }, r.status);
    const sig = await signHead(sk, wallet, r.entry.seq, r.entry.hash);
    return c.json({ ok: true, wallet, entry: r.entry, expiresAt: r.expiresAt, ...(r.replayed ? { replayed: true } : {}), head: { seq: r.entry.seq, hash: r.entry.hash, sig } });
  });

  app.get("/read", async (c) => {
    const wallet = payerOf(c);
    if (!wallet) return c.json({ error: "evm_payer_required" }, 400);
    const reused = await reusedPayment(c, wallet);
    if (reused) return reused;
    const key = c.req.query("key") ?? "";
    if (!POLICY.KEY_PATTERN.test(key)) return c.json({ error: "bad_key", pattern: POLICY.KEY_PATTERN.source }, 400);
    const r = await stub(c, wallet).read(key);
    if (!r.ok) return c.json({ error: r.error }, r.status);
    return c.json({ ok: true, wallet, key: r.key, value: r.value, entry: r.entry, state: r.state, expiresAt: r.expiresAt });
  });

  app.post("/renew", async (c) => {
    const wallet = payerOf(c);
    if (!wallet) return c.json({ error: "evm_payer_required" }, 400);
    const reused = await reusedPayment(c, wallet);
    if (reused) return reused;
    const sk = await signingKey(c.env);
    const r = await stub(c, wallet).renew();
    if (!r.ok) return c.json({ error: r.error }, r.status);
    const sig = await signHead(sk, wallet, r.entry.seq, r.entry.hash);
    return c.json({ ok: true, wallet, entry: r.entry, expiresAt: r.expiresAt, head: { seq: r.entry.seq, hash: r.entry.hash, sig } });
  });

  app.get("/export", async (c) => {
    const wallet = payerOf(c);
    if (!wallet) return c.json({ error: "evm_payer_required" }, 400);
    const reused = await reusedPayment(c, wallet);
    if (reused) return reused;
    const since = Number(c.req.query("since") ?? "0");
    if (!Number.isInteger(since) || since < 0) return c.json({ error: "bad_since" }, 400);
    const r = await stub(c, wallet).export(since);
    if (!r.ok) return c.json({ error: r.error }, r.status);
    const sig = await signHead(await signingKey(c.env), wallet, r.head.seq, r.head.hash);
    const { ok: _ok, head, ...rest } = r;
    return c.json({ ok: true, wallet, ...rest, head: { ...head, sig } });
  });

  app.onError((err, c) => {
    console.error("unhandled", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    return c.json({ error: "internal" }, 500);
  });

  app.notFound((c) => c.json({ error: "not_found", see: "/menu" }, 404));
  return app;
}
