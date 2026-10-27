# Tabularium

A paid, persistent, verifiable workspace for AI agents, sold per call over x402 (USDC).

**Live on Base mainnet** at https://tabularium.matt-3e0.workers.dev (real USDC). Listed on the x402 Bazaar and the
MCP Registry (`io.github.SQLazy/tabularium`, npm `tabularium-mcp`).
Identity is the paying wallet. Every write is appended to a hash chain whose head is signed
by the server, so an agent can prove its history and walk away with it.

## The menu (four calls, fixed prices)

| Call | Price | What |
|---|---|---|
| `POST /write {key,value}` | $0.003 | Append a value. First write opens a 30-day workspace. |
| `GET /read?key=` | $0.002 | Latest value + its chain entry. |
| `POST /renew` | $0.25 | Extend by 30 days (from current expiry, so early renewal wastes nothing). |
| `GET /export?since=` | $0.01 | Entries + values + signed head, verifiable offline. |

Free: `GET /llms.txt` (a plain-text guide for language models: when it fits, when not, exact formats), `GET /` and `/menu` (prices, policy, public signing key), `GET /head?wallet=` (signed seq + hash, no values).
`GET /stats`: public aggregates of settled calls (paying wallets, 14-day return rate, calls, revenue). Wallets appear only
as counts; keys and values are never recorded. Every payment is public on-chain anyway.

Prices were set on 2026-10-26, before launch, to cover the Coinbase facilitator's fee ($0.001 per settled payment
after the first 1,000 a month). A typical session (10 reads, 20 writes) costs about $0.08.

Writes accept an optional `idempotency_key` (same id + same body within 7 days returns the original entry with `replayed: true`; same id + different body is 409). Use it on every retry: x402 settles after the handler runs, so a failed settlement can follow a committed write.

Policy: 30-day term, 90-day grace (reads/export/renew work, writes return 409), then purged.
64KB value cap. One signed payment buys one call: a reused payment gets 409 and is not charged. renew and export
settle before running (a free pre-check rejects a missing workspace first). See [SECURITY.md](SECURITY.md).
 Keys match `^[A-Za-z0-9._:/-]{1,128}$`. 4xx/5xx responses are never charged
(the x402 middleware settles only when status < 400).

## Use it from an agent (MCP)

`mcp/` is a stdio MCP server exposing the menu as tools (the four paid calls plus menu, head, and local verify), and
`tabularium_pay` / `tabularium_ledger`: pay any x402 service and keep a signed receipt of every purchase in the
workspace, so an agent's spending is provable. The agent's wallet pays, with a per-process spend cap. See [mcp/README.md](mcp/README.md).

    claude mcp add tabularium --env TABULARIUM_PRIVATE_KEY=0x... -- node /path/to/mcp/server.mjs

## Verify without trusting the server

    node verifier/verify.mjs export.json <signingPubKeyHex>

Zero dependencies. Checks the chain, the values against value hashes, and the Ed25519 head signature.

Signing keys rotate. `/menu` publishes the current key and every retired one (`signing.retired`); an export
verifies against the key that was current when it was exported. Retired keys:

| Public key | Used until | Note |
|---|---|---|
| `5599f548393f2f2e1e694361a06d76d06fd3dc6cbe2d985d28f3a533025798e3` | 2026-10-26 | Testnet launch key. Its private half was exposed, so treat its signatures as testnet-only. |

## Develop

    npm install
    npm run keygen -- --dev                              # writes .dev.vars
    npx wrangler dev -c wrangler.dev.jsonc --port 8787   # NO paywall, local only
    node scripts/e2e.mjs                                 # 25 checks
    npm test && npm run typecheck

`src/dev-nopay.ts` removes the paywall and adds a 5ms async gap in the write path so the
concurrency test bites. It is referenced only by `wrangler.dev.jsonc`.
Caveat: wrangler hot-reload can serve stale code after a file swap; restart the server before trusting a result.

## Deploy

1. `npm run keygen`, put the public key in `SIGNING_PUBKEY_HEX` (wrangler.jsonc), then
   `npx wrangler secret put SIGNING_KEY_PKCS8`. The Worker refuses to sign if the two don't match.
   To rotate: move the old public key into `RETIRED_SIGNING_KEYS` (src/policy.ts), set the new one, and deploy
   the new secret in the same version: `npx wrangler deploy --secrets-file <json with SIGNING_KEY_PKCS8>`.
2. Set `PAY_TO` to your receiving address.
3. `npx wrangler deploy`. `NETWORK` in wrangler.jsonc picks the chain (`base` in production, `base-sepolia` for
   testing; the free `https://x402.org/facilitator` works on testnet). Local `wrangler dev` runs read `.dev.vars`,
   which keeps them on base-sepolia so local tests never spend real money.
4. Mainnet: set `NETWORK=base` and use a mainnet-capable facilitator (needs its own credentials) via `FACILITATOR_URL`.

## Lessons / known limits

- `blockConcurrencyWhile` is not a mutex. Concurrent writes forked the chain
  (`UNIQUE constraint failed: log.seq`). Mutations now go through an in-isolate promise-chain mutex plus
  `transactionSync`. Disabling the mutex makes e2e fail; enabling it passes.
- Payments use x402 v2 (`@x402/hono` 2.28): 402s carry a `PAYMENT-REQUIRED` header, clients pay with
  `PAYMENT-SIGNATURE`, receipts come back in `PAYMENT-RESPONSE`. Network ids are CAIP-2 (`eip155:84532`, `eip155:8453`);
  `/menu` advertises them under `x402`.
- Payer identity is read only from `PAYMENT-SIGNATURE` (the header the middleware verifies): EVM `exact` via EIP-3009.
  A legacy `X-PAYMENT` header is ignored, so nobody can pay with one wallet and claim another.
- Workers do not let one request await I/O started by another, so the paywall is initialised inside the request
  that needs it and only the finished instance is shared (a shared in-flight init hung every paid call).
- Name: "Tabularium" is Rome's state archive. Earlier names (Omega, Hypomnema) collided with existing AI-memory projects. The protocol tag "omega/v1" in the hash preimage is kept as a stable domain separator.
- Success test: share of wallets that come back within 14 days.

## License

Two licenses, on purpose:

- **The service** (everything except `mcp/` and `verifier/`): [FSL-1.1-MIT](LICENSE.md), the Functional Source
  License. Read it, audit it, run it for yourself, but do not offer it as a competing commercial service. Each version
  becomes MIT two years after it is published.
- **The MCP client** (`mcp/`) and **the offline verifier** (`verifier/`): [MIT](mcp/LICENSE). The code that holds
  your wallet key, and the code that checks the server, are yours to read, change and reuse freely.
