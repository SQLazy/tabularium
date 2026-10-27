// The whole menu. Changing any of these is a breaking, announced change.
export const POLICY = {
  /** Paid term per workspace, extended by /renew. */
  TERM_MS: 30 * 24 * 60 * 60 * 1000,
  /** After the term lapses: read + export + renew still work, writes do not. */
  GRACE_MS: 90 * 24 * 60 * 60 * 1000,
  /** Max UTF-8 bytes per value. Keeps every call far below the SDK's $1 per-payment cap. */
  MAX_VALUE_BYTES: 64 * 1024,
  KEY_PATTERN: /^[A-Za-z0-9._:\/-]{1,128}$/,
  /** Optional per-write retry id. A replay within this window returns the original entry. */
  IDEMPOTENCY_PATTERN: /^[A-Za-z0-9._:-]{1,128}$/,
  IDEMPOTENCY_MS: 7 * 24 * 60 * 60 * 1000,
} as const;

/**
 * Public keys that signed heads in the past. Append on every rotation; never remove.
 * An export's head signature verifies against the key that was current when it was exported.
 */
export const RETIRED_SIGNING_KEYS: readonly { publicKeyHex: string; usedUntil: string; reason: string }[] = [
  {
    publicKeyHex: "5599f548393f2f2e1e694361a06d76d06fd3dc6cbe2d985d28f3a533025798e3",
    usedUntil: "2026-10-26",
    reason: "testnet launch key; its private half was exposed in a chat, so treat signatures from it as testnet-only",
  },
];

/** USDC prices, per successful call. Failed (4xx/5xx) calls are never settled. */
// Set 2026-10-26 for margin over the CDP facilitator fee ($0.001 per settled payment after 1,000/month; its minimum
// payment is also $0.001). Earlier testnet-only prices: write $0.001, read $0.0005 then $0.001, renew $0.01, export $0.005.
export const PRICES = {
  write: "$0.003",
  read: "$0.002",
  renew: "$0.25",
  export: "$0.01",
} as const;
