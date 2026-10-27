# tabularium-mcp

MCP server for [Tabularium](https://github.com/SQLazy/tabularium#readme): a paid, persistent, hash-chained workspace for AI agents.
Your agent's EVM wallet pays each call in USDC over x402, and that wallet is the account. There is no sign-up and no API key.

## Tools

| Tool | Cost | What |
|---|---|---|
| `tabularium_menu` | free | Prices, policy, network, public signing key. |
| `tabularium_write` | $0.003 | Append `{key, value}`. Retries reuse one idempotency key, so a retry never writes twice. |
| `tabularium_read` | $0.002 | Latest value for a key, with its chain entry. |
| `tabularium_renew` | $0.25 | Extend the workspace 30 days. |
| `tabularium_export` | $0.01 | Full signed history, verified offline before it is returned. `save_to` writes it to a file. |
| `tabularium_head` | free | Signed head (seq + hash, no values) for any wallet; defaults to yours. |
| `tabularium_verify` | free, local | Re-verify a saved export without trusting the server. |
| `tabularium_pay` | the endpoint's price + one write | Pay **any** x402 v2 endpoint in USDC and write a signed receipt (reason, the full accepted terms, amount, payee, network, transaction, response hash, and an intent the wallet signed before paying) to `ledger/<date>/...`. `purchase_id` makes retries safe: the same id never pays twice. |
| `tabularium_ledger` | one export | Verify the workspace and total the receipts: spend by service and by day, latest receipts; checks every payer-signed intent against its receipt. |
| `tabularium_reconcile` | one export | Compare receipts with the USDC payments the wallet actually settled on-chain (last 1-30 days): purchases with no receipt, receipts with no settlement, and receipts that differ from the chain. |

Failed calls (4xx/5xx) are never charged.

### More Tabularium services

Tabularium is a platform: the same wallet pays for every service it offers, and memory is the first. When the server
starts, it reads the live menu and turns each paid call of every other service into its own tool, named
`tabularium_<service>_<call>`, with the input fields and price the menu lists. A new service therefore shows up the
next time your MCP client starts, without a new version of this package. These tools follow the same rules as the
memory tools: the payee must be the menu's, the price at most the menu price (and never above $0.50), the session
spend cap applies, and redirects are never followed. A call that settles after it runs is not retried after a failed
payment, because it may already have run. Menu entries that do not fit these rules are skipped, not guessed at.

## Prompts

Ready-made starting points your MCP client lists (in Claude Code, type `/` to see them):

| Prompt | What |
|---|---|
| `load_memory` | Start a session from what was stored before: read an index key (default `index`), then the entries it lists. |
| `spending_report` | What has my agent spent? Totals by service and day, and the largest purchases with their reasons. |

The server also tells the model, when it connects, which tools are free and which cost money, plus a simple memory
pattern: keep an `index` key, read it at the start, write decisions as they happen.

### The spending ledger

`tabularium_pay` answers the question every operator asks: *what did my agent buy, from whom, for how much, and why?*
Each settled purchase becomes one entry in the agent's hash-chained, server-signed workspace, so the record can be
exported and verified offline, with the on-chain transaction hash alongside. Safety rules: USDC via EIP-3009 only,
allowed networks only, a per-purchase maximum, and the session spend cap is checked against the real price plus the
receipt before anything is signed. A receipt's idempotency key is its payment nonce, so a retry never records twice;
if a receipt write fails after a purchase settled, the tool still returns the purchase and the receipt to re-record.
Paid requests never follow redirects (payment and receipt stay with the URL asked for), and a signed authorization
is valid for at most 10 minutes whatever the seller asks.

Since 0.5 (from review on Moltbook's m/agentfinance):

- **The reason is a commitment, not a note.** Before the payment is signed, the wallet signs (EIP-191) an intent:
  the request, the exact terms accepted, the payment nonce, and the reason. The receipt keeps it, so the payer cannot
  later edit the reason and the server cannot invent one. It is still a claim, and the receipt says so
  (`reasonStatus`). Check one with any EIP-191 verifier, or let `tabularium_ledger` check them all.
- **The promise is in the record.** The receipt holds the full `accepts[]` entry the payer accepted and its hash, next
  to the payment (transaction) and the delivery (response hash).
- **Retries cannot pay twice.** With `purchase_id`, the signed authorization is kept (in `TABULARIUM_STATE_DIR`) until
  the purchase is known to have settled. Calling again sends that same authorization, which can settle at most once;
  a purchase that settled while its response was lost is found on-chain and recorded once.
- **Completeness is checkable.** A hash chain shows rows were not edited, not that none are missing.
  `tabularium_reconcile` counts the wallet's on-chain settlements against its receipts.

## Configure

| Env | Required | Meaning |
|---|---|---|
| `TABULARIUM_PRIVATE_KEY` | for paid tools | 0x-prefixed EVM private key that pays. Use a dedicated wallet with a small balance. |
| `TABULARIUM_URL` | no | Service URL. Default: the public deployment (Base mainnet). |
| `TABULARIUM_PUBKEY` | no | Pin the server's Ed25519 key (hex). Exports are verified against it, and a mismatch with the published key is reported. |
| `TABULARIUM_MAX_SPEND_USD` | no | Spend cap for this server process, across all tools. Default `1`. |
| `TABULARIUM_PAY_MAX_USD` | no | `tabularium_pay`: most one purchase may cost. Default `0.10`, ceiling `0.50`. |
| `TABULARIUM_TEST` | no | Marks this process's requests to the service as test traffic, kept out of its public demand stats. For the service's own test runs. |
| `TABULARIUM_RPC_URL` | no | JSON-RPC for the service's network, used by `tabularium_reconcile` and to check whether an unconfirmed payment settled. Default: a public Base node. |
| `TABULARIUM_STATE_DIR` | no | Where `purchase_id` records are kept. Default `~/.tabularium-mcp`. |
| `TABULARIUM_PAY_NETWORKS` | no | `tabularium_pay`: networks it may pay on (comma-separated CAIP-2). Default: the service's own network, which for the public service is Base mainnet (`eip155:8453`): purchases spend real USDC, within `TABULARIUM_PAY_MAX_USD` and the spend cap. Set `eip155:84532` to keep purchases on testnet. |

The public service runs on **Base mainnet**: the paying wallet needs real USDC on Base. It needs no ETH, because
the facilitator pays the transaction fees. Use a dedicated wallet holding only a few dollars.

Claude Code:

    claude mcp add tabularium --env TABULARIUM_PRIVATE_KEY=0x... -- npx -y tabularium-mcp

Claude Desktop / other clients (`mcpServers` JSON):

```json
{
  "tabularium": {
    "command": "npx",
    "args": ["-y", "tabularium-mcp"],
    "env": { "TABULARIUM_PRIVATE_KEY": "0x...", "TABULARIUM_MAX_SPEND_USD": "0.50" }
  }
}
```

Speaks x402 v2. Three dependencies (MCP SDK, viem, zod). Payments are signed locally (EIP-3009 USDC authorization);
the server refuses to sign anything other than USDC to the payee and price the service's own menu lists.
Versions before 0.2.0 spoke x402 v1 and no longer work against the service.

## Develop

    npm install
    cp ../verifier/verify.mjs verify.mjs   # also runs on prepack; a root test fails if the copy drifts
    npm test                               # offline: payment guards (wrong asset/payee/price/network refused), service tools
    node smoke.mjs                         # 30 checks over stdio against the live service (PAYER_FILE picks the wallet)
    node smoke.mjs --npx tabularium-mcp@X  # same checks against a published version
