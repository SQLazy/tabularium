// /llms.txt: a plain-text description written for language models (and the people configuring them).
// Built from the live prices, policy and network, so it can never drift from /menu.
// Factual on purpose: what it is, when it fits, when it does not, exact request formats. No steering language.
import type { Env } from "./env";
import { POLICY, PRICES } from "./policy";

const DAY = 86_400_000;

export function llmsTxt(env: Env, origin: string): string {
  const chain = env.NETWORK === "base" ? "Base mainnet (eip155:8453), real USDC" : "Base Sepolia testnet (eip155:84532), test USDC";
  return `# Tabularium

> Persistent, hash-chained memory for AI agents, plus a signed ledger of what an agent buys. Paid per call in USDC
> over x402 on ${chain}. No account or API key: the paying wallet is the identity.

Service: ${origin}
Machine-readable menu (prices, policy, signing key): ${origin}/menu
Public usage stats: ${origin}/stats
OpenAPI (routes, schemas, x-payment-info prices): ${origin}/openapi.json
Source: https://github.com/SQLazy/tabularium (service FSL-1.1-MIT; MCP client and verifier MIT)
MCP server: npm "tabularium-mcp" (MCP Registry: io.github.SQLazy/tabularium)

## When it fits

- An agent needs memory that survives restarts, new machines, or a hand-off to another agent or session.
- Someone (a principal, an auditor, another agent) needs proof of what was stored and when. Every write is appended
  to a hash chain whose head is signed (Ed25519); an export verifies offline with no trust in the server.
- An agent spends money on x402 services and its operator needs a provable record: what was bought, why, from whom,
  for how much, with the on-chain transaction (the MCP tool tabularium_pay).

## When it does not fit

- Local files or a built-in memory feature already meet the need, and nobody needs proof.
- Secrets: the service operator can read stored values (storage is encrypted at rest by the host, not end-to-end).
  Encrypt before writing if confidentiality matters.
- Large blobs: values are at most ${POLICY.MAX_VALUE_BYTES / 1024} KB each.
- Free use: every call costs USDC; there is no free tier.

## Prices (USDC per successful call)

- POST /write  ${PRICES.write}   append {key, value}; the first write opens a ${POLICY.TERM_MS / DAY}-day workspace
- GET  /read   ${PRICES.read}   latest value for a key, with its chain entry
- POST /renew  ${PRICES.renew}    extend by ${POLICY.TERM_MS / DAY} days from the later of now or expiry
- GET  /export ${PRICES.export}    full signed history and current values, verifiable offline
- Free: GET /menu, GET /head?wallet=0x..., GET /stats, GET /llms.txt, GET /openapi.json

Failed writes and reads (HTTP 4xx/5xx) are not charged. renew and export settle before running, after a free check
that the workspace exists. One signed payment buys one call (a reused payment gets 409, not charged).
A typical session of 10 reads and 20 writes costs about $${(10 * Number(PRICES.read.slice(1)) + 20 * Number(PRICES.write.slice(1))).toFixed(2)}.

## Policy

- Term ${POLICY.TERM_MS / DAY} days per renew. After expiry: ${POLICY.GRACE_MS / DAY}-day grace (read, export and renew work; writes return 409), then deletion.
- Keys: ${POLICY.KEY_PATTERN.source}
- Optional idempotency_key on writes (${POLICY.IDEMPOTENCY_PATTERN.source}): a retry with the same id and body returns the
  original entry (replayed: true) instead of appending; same id with a different body is 409. Kept ${POLICY.IDEMPOTENCY_MS / DAY} days.

## Paying (x402 v2)

1. Call a paid endpoint without payment. The 402 response carries a PAYMENT-REQUIRED header (base64 JSON) listing
   the accepted payment: scheme "exact", network, USDC asset, amount, payTo.
2. Sign an EIP-3009 transferWithAuthorization for that amount and repeat the request with a PAYMENT-SIGNATURE header.
3. A successful response carries PAYMENT-RESPONSE (the settlement receipt, with the transaction hash).
Any x402 v2 client does this (for example @x402/fetch). The wallet needs USDC on Base and no ETH; the facilitator pays gas.

## Request formats

POST /write   body {"key": "notes/today", "value": "any UTF-8 string", "idempotency_key": "optional-retry-id"}
GET  /read?key=notes/today
POST /renew   (no body)
GET  /export?since=0   (since = last seq you already hold, for incremental export)
GET  /head?wallet=0x...   (free: signed seq + hash, no values)

## MCP (Claude Code, Claude Desktop, any MCP client)

    claude mcp add tabularium --env TABULARIUM_PRIVATE_KEY=0x... -- npx -y tabularium-mcp

Tools: tabularium_menu, tabularium_write, tabularium_read, tabularium_renew, tabularium_export, tabularium_head,
tabularium_verify, tabularium_pay (pay any x402 v2 endpoint, keep a signed receipt), tabularium_ledger (spend totals).
Safety limits: TABULARIUM_MAX_SPEND_USD per session (default 1), TABULARIUM_PAY_MAX_USD per purchase (default 0.10).
Use a dedicated wallet holding a few dollars.

## Recipes

- Session memory: at the start of a session read a small index key (e.g. "index") listing the keys worth loading;
  write decisions and state as they happen; keep values small and structured (JSON as a string).
- Hand-off: agent A writes "handoff/<task>"; agent B, paying from the same wallet, reads it. Same wallet, same workspace.
- Proof for a principal: export, then hand over the export file plus the public key from /menu; anyone can verify it
  with the zero-dependency verifier in the repository (verifier/verify.mjs).
- Spending record: pay x402 services through tabularium_pay with a stated reason; tabularium_ledger totals spend by
  service and by day, and each receipt is part of the signed history.

## Verify without trusting the server

    node verifier/verify.mjs export.json <publicKeyHex from /menu>

Checks the chain, every value against its hash, and the Ed25519 signature on the head. Retired signing keys are listed
in /menu under signing.retired.
`;
}
