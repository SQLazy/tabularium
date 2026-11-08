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
  [/tabularium-remote-mcp/, "remote-mcp"],
  [/tabularium-mcp/, "tabularium-mcp"],
  [/claude|anthropic/, "anthropic"],
  [/openai|chatgpt|gptbot/, "openai"],
  [/coinbase|\bcdp\b|bazaar/, "coinbase"],
  // Robots that list, rank or watch x402 services: they ask for a price and never mean to pay. Seen in a live
  // sample on 2026-11-07 (every request in 6 minutes): x402-router-crawler, x402station, KertivoStatus, mcpbeat,
  // AgentRankProbe, SettledProbe, agent-collector. Checked before the language families, so a monitor written in
  // Python still counts as a robot.
  [/crawl|spider|probe|monitor|uptime|status|heartbeat|beat\/|collector|indexer|checker|station\//, "bot"],
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

/** Robots (family "bot") still count as quotes, under their family, but never as askers. */
export const ROBOT_FAMILY = "bot";

/** Our own test runs mark their requests with this header so they never count as demand. */
export const TEST_HEADER = "x-tabularium-test";

/**
 * Whether a quoted request carried a real request: what an agent sends when it means to use the call, as opposed to
 * a probe checking the paywall. Robots that list x402 services send nothing, an empty body, or the call's own
 * published example (from /openapi.json or the Bazaar listing), so those do not count. This is the number that
 * tells "agents saw the price and left" apart from "nobody came": see docs/PRICING.md.
 */
export function carriesRequest(r: { method: string; query: string; body: unknown; example?: unknown }): boolean {
  if (r.method === "GET" || r.method === "HEAD") {
    const params = new URLSearchParams(r.query);
    const real = [...params.values()].some((v) => v.trim() !== "");
    if (!real) return false;
    const ex = r.example && typeof r.example === "object" ? (r.example as Record<string, unknown>) : null;
    return !ex || [...params.entries()].some(([k, v]) => String(ex[k] ?? "") !== v);
  }
  if (!r.body || typeof r.body !== "object" || Array.isArray(r.body)) return false;
  const filled = Object.values(r.body as Record<string, unknown>).some(
    (v) => (typeof v === "string" && v.trim() !== "") || typeof v === "number" || (typeof v === "object" && v !== null),
  );
  if (!filled) return false;
  return r.example === undefined || stableJson(r.body) !== stableJson(r.example);
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}
