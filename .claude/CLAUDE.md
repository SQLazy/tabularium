# Tabularium

x402 pay-per-call memory and services for AI agents. Cloudflare Worker + Durable Objects (TypeScript, Hono),
plus `tabularium-mcp` in `mcp/` and the offline verifier in `verifier/`. Live on Base mainnet with real USDC.

@workflow.md
@lessons.md

## Commands

```bash
npm ci && (cd mcp && npm ci)
npm run typecheck                 # tsc --noEmit
npm test                          # Worker unit tests (vitest), 107 at last count
(cd mcp && npm test)              # MCP offline tests (node --test), 38 at last count
```

End-to-end, against a local Worker with no paywall:

```bash
npm run keygen -- --dev                              # writes .dev.vars (gitignored, throwaway key)
npx wrangler dev -c wrangler.dev.jsonc --port 8787   # NO paywall, local only
node scripts/e2e.mjs                                 # snapshot checks fetch example.com and httpbin.org
```

The e2e snapshot checks need outbound internet from the Worker. In a sandbox without it they crash at the
first snapshot check; that's the network, not the code. Restart `wrangler dev` after file swaps before trusting a
result (hot reload can serve stale code).

Run typecheck and both test suites before every push. CI (`test.yml`) runs the same plus e2e on every branch and PR.

## How shipping works

- **Merging to `main` deploys to production on mainnet.** `deploy.yml` runs the full tests plus a testnet payment
  test, then `wrangler deploy` if `src/`, `wrangler.jsonc`, `package*.json` or `tsconfig.json` changed.
- So: work on a branch, open a draft PR, and stop. Merging is Teo's.
- The MCP package ships from a `mcp-vX.Y.Z` tag made by `scripts/release-mcp.mjs` (npm + MCP Registry).
  See `docs/RELEASING.md`.

## Never without Teo's explicit go-ahead

- Push to or merge into `main`, or run `wrangler deploy` / `npm run deploy`.
- Run `scripts/release-mcp.mjs`, push an `mcp-v*` tag, `npm publish` or `mcp-publisher`.
- Change `NETWORK`, `PAY_TO`, `FACILITATOR_URL`, `SIGNING_PUBKEY_HEX` or `EXCLUDE_WALLETS` in `wrangler.jsonc`,
  or `RETIRED_SIGNING_KEYS` in `src/policy.ts`.
- `wrangler secret put`, key rotation, or anything that reads or writes a wallet key or the signing key.
- Any paid call against production: `scripts/pay-test.mjs` against the live URL, or `scripts/remote-mcp-check.mjs --pay`.
  `scripts/live-check.mjs` and `remote-mcp-check.mjs` without `--pay` are free and fine.

Local runs stay on base-sepolia through `.dev.vars`; keep it that way. `.dev.vars`, `.secrets/` and
`.testnet-wallets.json` are gitignored and must stay out of commits.

## Repo notes

- `src/core/` is the shared paywall/identity/stats core; each service is one module in `src/services/`.
- `src/dev-nopay.ts` is wired only through `wrangler.dev.jsonc`. Never import it from production code.
- `mcp/verify.mjs` is a copy of `verifier/verify.mjs`; `test/mcp-verifier-sync.test.mjs` fails if they drift.
- README's "Lessons / known limits" is product history. Agent lessons go in `.claude/lessons.md`.
- A gitignored root `CLAUDE.md` is for private local notes; this file is the shared one.
