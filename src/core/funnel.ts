// The funnel: quoted -> paid -> came back. A 402 quote is the earliest demand signal we get: some client looked at a
// paid call and was told its price. Pure functions here; the counting lives in the Stats object.
//
// Privacy: the raw User-Agent is reduced to one of the coarse families below and never stored. Unique askers are
// counted per day as sha256(daily random salt + IP + User-Agent); the salt is deleted when the day ends, after
// which the stored hashes cannot be linked to anyone, not even by us.

export type FunnelKind = "quoted" | "paid" | "rejected";

/**
 * quoted: no payment sent, the paywall answered 402 with a price.
 * paid: a payment was sent and the call was charged.
 * rejected: a payment was sent but the call was not charged (bad payment, reused payment, invalid request).
 * Anything else (no payment and not a 402, e.g. the no-paywall test build) is not a funnel event.
 */
export function funnelKind(r: { status: number; hasPayment: boolean; charged: boolean }): FunnelKind | null {
  if (r.hasPayment) return r.charged ? "paid" : "rejected";
  return r.status === 402 ? "quoted" : null;
}

const FAMILIES: [RegExp, string][] = [
  [/agentcash/, "agentcash"],
  [/x402scan/, "x402scan"],
  [/tabularium-mcp/, "tabularium-mcp"],
  [/claude|anthropic/, "anthropic"],
  [/openai|chatgpt|gptbot/, "openai"],
  [/coinbase|\bcdp\b|bazaar/, "coinbase"],
  [/python|aiohttp|httpx|urllib/, "python"],
  [/axios|node|undici|deno|\bbun\b/, "node"],
  [/curl|wget/, "curl"],
  [/go-http-client|\bgo\//, "go"],
  [/okhttp|java/, "java"],
  [/bot|crawl|spider|scan/, "bot"],
  [/mozilla/, "browser"],
];

/** Coarse client family from a User-Agent. The raw string is never stored. */
export function clientFamily(ua: string | undefined | null): string {
  const s = (ua ?? "").toLowerCase().trim();
  if (!s) return "none";
  for (const [re, family] of FAMILIES) if (re.test(s)) return family;
  return "other";
}

/** Our own test runs mark their requests with this header so they never count as demand. */
export const TEST_HEADER = "x-tabularium-test";
