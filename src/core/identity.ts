// Who paid, and with which payment. Shared by every service on the platform.
import type { Context } from "hono";
import type { Env } from "../env";

export type C = Context<{ Bindings: Env }>;

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

/**
 * The wallet's own partition: one Durable Object per paying wallet. It holds the memory service's data and the
 * payment nonces every service claims, so one signed payment buys one call across the whole platform (an EIP-3009
 * authorization names a payee and an amount, not a route, so the claim must be shared by all routes).
 */
export const walletStub = (env: Env, wallet: string) => env.WORKSPACE.get(env.WORKSPACE.idFromName(wallet));

export const isExcluded = (env: Env, wallet: string) =>
  (env.EXCLUDE_WALLETS ?? "").toLowerCase().split(",").map((w) => w.trim()).includes(wallet);
