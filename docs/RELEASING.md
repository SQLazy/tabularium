# Releasing

Everything ships from GitHub Actions. Nobody runs `wrangler deploy`, `npm publish` or `mcp-publisher` by hand.

| What | How it starts | What runs |
|---|---|---|
| Tests | any push to a branch other than `main`, any pull request | typecheck, Worker unit tests, MCP offline tests, end-to-end against a local no-paywall Worker ([test.yml](../.github/workflows/test.yml)) |
| Worker | push to `main` | the tests above plus the real x402 paywall locally on Base Sepolia (payment test, MCP smoke test); if Worker files changed, `wrangler deploy`, then free live checks against production ([deploy.yml](../.github/workflows/deploy.yml)) |
| MCP package | `node scripts/release-mcp.mjs X.Y.Z` (bumps `mcp/package.json` and `mcp/server.json`, tests, tags `mcp-vX.Y.Z`, pushes) | version check, full tests, `npm publish` with trusted publishing, wait for npm, MCP Registry publish with GitHub OIDC, then a smoke test of the published package from a clean install ([release-mcp.yml](../.github/workflows/release-mcp.yml)) |

`node scripts/live-check.mjs [url]` runs the free production checks by hand: every paid route answers 402 with the
menu price and payee, and `/openapi.json`, `/llms.txt` and `/stats` agree with `/menu`.

## One-time setup

1. **GitHub secrets** (repository Settings > Secrets and variables > Actions > New repository secret):
   - `CLOUDFLARE_API_TOKEN`: Cloudflare dashboard > My Profile > API Tokens > Create Token > "Edit Cloudflare
     Workers" template, limited to this account.
   - `CLOUDFLARE_ACCOUNT_ID`: the account id (`npx wrangler whoami` shows it).
   - `TESTNET_PAYER_KEY`: the private key of a throwaway Base Sepolia wallet holding test USDC (Circle faucet). Each
     main push or release spends about 0.3 test USDC. Never a mainnet key.
2. **npm trusted publisher**: npmjs.com > package `tabularium-mcp` > Settings > Trusted Publisher > GitHub Actions:
   user `SQLazy`, repository `tabularium`, workflow `release-mcp.yml`, environment `npm`. A new connection must publish
   once within 2 days. Afterwards, Settings > Publishing access > "Require two-factor authentication and disallow
   tokens" leaves trusted publishing as the only way to publish.
3. **Optional approval gate**: repository Settings > Environments > `production` (and `npm`) > Required reviewers.
   Deploys and publishes then wait for a click.

The Worker's own secrets (`SIGNING_KEY_PKCS8`, `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`) stay in Cloudflare; deploys do
not touch them. Rotating the signing key is still a manual `wrangler deploy --secrets-file` (see the README).
