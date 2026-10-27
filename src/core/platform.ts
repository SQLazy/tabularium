// The platform: everything services share. One paywall, one payee, one signing key, one payer identity, one
// one-payment-one-call guard, one Stats object (per-service totals + the demand funnel), and one set of discovery
// files (/menu, /openapi.json, /llms.txt). A service only supplies its calls (src/core/service.ts).
import { Hono, type MiddlewareHandler } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import type { Env } from "../env";
import { POLICY, RETIRED_SIGNING_KEYS } from "../policy";
import { sha256Hex } from "../chain";
import { CDP_FACILITATOR_URL, cdpAuthHeaders } from "../cdp";
import { openApi } from "../openapi";
import { CAIP2, PAYMENT_HEADER, isExcluded, payerOf, paymentNonce, walletStub, type C } from "./identity";
import { callInput, micro, type PaidCall, type Service } from "./service";
import { TEST_HEADER, clientFamily, funnelKind } from "./funnel";

// Higher-priced calls settle UPFRONT (before the handler): each is worth more than the gas it costs to make a
// settlement fail after the handler ran (drain the wallet, or burn the nonce). A free precheck stops charges for a
// request that would fail anyway. Cheap calls keep the default flow (settle after success, so failures are never
// charged); their residual exposure to that race is below the attacker's own gas cost, and payment reuse is blocked
// by claimPayment.
const UPFRONT = { paymentFlow: "upfront" };

type Paid = { service: string; call: PaidCall };
const routeKey = (method: string, path: string) => `${method} ${path}`;

/** The x402 route table for every paid call on the platform. */
export function platformRoutes(env: Env, services: Service[]) {
  const out: Record<string, Record<string, unknown> & { extensions: Record<string, unknown>; serviceName: string; tags: string[] }> = {};
  for (const s of services) {
    for (const call of s.calls) {
      out[routeKey(call.method, call.path)] = {
        accepts: [{ scheme: "exact", price: call.price, network: CAIP2[env.NETWORK], payTo: env.PAY_TO, maxTimeoutSeconds: 60, ...(call.upfront ? { extra: UPFRONT } : {}) }],
        description: call.description,
        mimeType: "application/json",
        serviceName: s.serviceName,
        tags: s.tags,
        extensions: call.discovery,
      };
    }
  }
  return out;
}

// The paywall must learn the facilitator's supported kinds (a fetch) before it can price a route.
// Workers rule: a promise backed by I/O in one request never resolves in another, so a shared "init in progress"
// promise hangs every other request that awaits it (it did: POST /write hung after GET /menu started the init).
// So each request that finds no ready paywall initializes its own, awaits it itself, and only the finished
// instance (plain data, no pending I/O) is shared. Concurrent cold requests may each fetch once; that is harmless.
// The middleware's own start-up sync is turned off because we did it here.
let paywall: { key: string; mw: MiddlewareHandler } | null = null;
async function paywallFor(env: Env, services: Service[]): Promise<MiddlewareHandler> {
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
  const mw = paymentMiddleware(platformRoutes(env, services) as never, server, undefined, undefined, false) as unknown as MiddlewareHandler;
  paywall = { key, mw };
  return mw;
}

// ---- measurement: who pays, who comes back, and who asked ---------------------------------------
const statsStub = (env: Env) => env.STATS.get(env.STATS.idFromName("global"));
const later = (c: C, p: Promise<void>) => c.executionCtx.waitUntil(p.catch((err) => console.error("stats", String(err))));

/** Records one charged call: hashed wallet id, service, call, price. Never keys or values. Test wallets are skipped. */
async function recordCharge(c: C, paid: Paid, ts: number): Promise<void> {
  const wallet = payerOf(c);
  if (!wallet) return;
  if (isExcluded(c.env, wallet)) return statsStub(c.env).recordExcluded();
  const id = (await sha256Hex(`tabularium/stats\n${wallet}`)).slice(0, 16);
  await statsStub(c.env).record(id, paid.service, paid.call.name, micro(paid.call.price), ts);
}

/** Records one funnel event (quoted / paid / rejected). Our own marked test runs and test wallets are kept out. */
async function recordFunnel(c: C, paid: Paid, status: number, charged: boolean, ts: number): Promise<void> {
  const hasPayment = !!c.req.header(PAYMENT_HEADER);
  const kind = funnelKind({ status, hasPayment, charged });
  if (!kind) return;
  const wallet = hasPayment ? payerOf(c) : null;
  if (c.req.header(TEST_HEADER) || (wallet && isExcluded(c.env, wallet))) return statsStub(c.env).recordExcludedFunnel();
  const ua = c.req.header("user-agent") ?? "";
  const asker = kind === "quoted" ? `${c.req.header("cf-connecting-ip") ?? ""}\n${ua}` : undefined;
  await statsStub(c.env).funnel(paid.service, paid.call.name, kind, clientFamily(ua), ts, asker);
}

export function createPlatform(services: Service[], opts: { paywall: boolean }) {
  const app = new Hono<{ Bindings: Env }>();
  const PAID = new Map<string, Paid>();
  for (const s of services) for (const call of s.calls) PAID.set(routeKey(call.method, call.path), { service: s.id, call });
  const paidOf = (c: C) => PAID.get(routeKey(c.req.method, c.req.path));
  const memory = services.find((s) => s.id === "memory");

  if (opts.paywall) {
    app.use("*", async (c, next) => {
      const paid = paidOf(c);
      if (!paid) return next(); // free routes never touch the facilitator
      // Precheck for upfront calls, on the paid attempt (which carries PAYMENT-SIGNATURE), before anything settles.
      const wallet = paid.call.upfront && paid.call.precheck ? payerOf(c) : null;
      const refused = wallet ? await paid.call.precheck!(c, wallet) : null;
      if (refused) {
        later(c, recordFunnel(c, paid, refused.status, false, Date.now()));
        return refused;
      }
      // The middleware either returns its own response (402, errors) or sets c.res after settling: pass both through.
      const out = await (await paywallFor(c.env, services))(c, next);
      const res = out instanceof Response ? out : c.res;
      // Charged = success status plus the settlement receipt the x402 middleware adds after settling.
      const charged = res.status < 400 && !!res.headers.get("PAYMENT-RESPONSE");
      const now = Date.now();
      if (charged) later(c, recordCharge(c, paid, now));
      later(c, recordFunnel(c, paid, res.status, charged, now));
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
      const paid = paidOf(c);
      if (!paid) return;
      const now = Number(c.req.header("X-Test-Now") ?? Date.now());
      const charged = c.res.status < 400;
      if (charged) later(c, recordCharge(c, paid, now));
      later(c, recordFunnel(c, paid, c.res.status, charged, now));
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
      // The memory service's calls, in the shape tabularium-mcp <= 0.3 reads. Other services are under `services`.
      calls: (memory?.calls ?? []).map((x) => x.menu),
      free: ["GET /menu", ...services.flatMap((s) => (s.free ?? []).map((f) => f.menu ?? `${f.method} ${f.path}`)), "GET /stats", "GET /llms.txt", "GET /openapi.json"],
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
      // Every service on the platform. One wallet pays for all of them; one signed payment buys one call.
      services: services.map((s) => ({
        id: s.id,
        name: s.serviceName,
        summary: s.summary,
        tags: s.tags,
        calls: s.calls.map((x) => ({
          name: x.name,
          call: routeKey(x.method, x.path),
          price: x.price,
          settles: x.upfront ? "before running" : "after success",
          summary: (x.openapi as { summary?: string }).summary ?? "",
          description: x.description,
          input: callInput(x),
        })),
      })),
    });
  app.get("/", menu);
  app.get("/menu", menu);

  // Plain-text description for language models: what it is, when it fits and when not, exact formats.
  app.get("/llms.txt", (c) => {
    c.header("Cache-Control", "public, max-age=300");
    const origin = new URL(c.req.url).origin;
    return c.text(services.map((s) => s.llms(c.env, origin)).join("\n\n---\n\n"));
  });

  // OpenAPI discovery for agent wallets and x402 explorers (x402scan, AgentCash): routes, prices, schemas.
  app.get("/openapi.json", (c) => {
    c.header("Cache-Control", "public, max-age=300");
    c.header("Access-Control-Allow-Origin", "*");
    return c.json(openApi(c.env, new URL(c.req.url).origin, services));
  });

  // Public aggregates. Every payment is public on-chain anyway; wallets appear only as counts.
  app.get("/stats", async (c) => {
    // The test build may pass ?now= (time travel, uncached); production always reads the cached live summary.
    const testNow = !opts.paywall && c.req.query("now") ? Number(c.req.query("now")) : null;
    return c.json(await statsStub(c.env).summary(testNow ?? Date.now(), testNow === null, services.map((s) => s.id)));
  });

  for (const s of services) for (const f of s.free ?? []) app.on(f.method, f.path, (c) => f.handler(c));

  // ---- paid: identity and one-payment-one-call are enforced here, for every service ------------
  // Errors return 4xx, which the x402 middleware does not settle. Bad requests cost nothing.
  for (const s of services) {
    for (const call of s.calls) {
      app.on(call.method, call.path, async (c) => {
        const wallet = payerOf(c);
        if (!wallet) return c.json({ error: "evm_payer_required" }, 400);
        // One signed payment buys one call. A reused payment gets 409 (never settled).
        const nonce = paymentNonce(c);
        if (nonce && !(await walletStub(c.env, wallet).claimPayment(nonce))) return c.json({ error: "payment_reused" }, 409);
        return call.handler(c, wallet);
      });
    }
  }

  app.onError((err, c) => {
    console.error("unhandled", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    return c.json({ error: "internal" }, 500);
  });

  app.notFound((c) => c.json({ error: "not_found", see: "/menu" }, 404));
  return app;
}
