# Directory listing kit

Copy-paste text for MCP directories. Keep every listing identical to this file.

## Fields

**Name:** Tabularium

**One-liner (≤ 100 chars):** Agent memory and a signed spending ledger: pay any x402 API, keep a provable receipt.

**Short description (≤ 300 chars):**
Persistent, hash-chained memory for AI agents, paid per call in USDC over x402 on Base. No sign-up or API key:
the agent's wallet is the account. `tabularium_pay` pays any x402 service and writes a signed receipt, so an
agent's spending is provable and exportable.

**Long description:**
Tabularium gives an agent a workspace that survives restarts, machines and hand-offs, and a record it can prove.
Every write is appended to a hash chain whose head is signed by the server; an export can be verified offline with
zero dependencies.

- **Memory:** write, read, renew, export. Values up to 64 KB, 30-day term, renewable.
- **Spending ledger:** `tabularium_pay` pays any x402 v2 endpoint in USDC and records what was bought, why, from
  whom, for how much, with the on-chain transaction and a hash of the response. `tabularium_ledger` totals spend
  by service and by day.
- **Safety:** spend cap per session, per-purchase maximum, USDC only, networks allow-list, no redirects on paid
  requests, receipts that are never written twice.
- **Pricing:** write $0.003, read $0.002, export $0.01, renew $0.25 per 30 days. Failed writes and reads are free.

**Category / tags:** memory, storage, payments, x402, blockchain, agent-tools, verifiable

**Links:**
- npm: https://www.npmjs.com/package/tabularium-mcp
- GitHub: https://github.com/SQLazy/tabularium (MCP package in `mcp/`)
- MCP Registry: `io.github.SQLazy/tabularium`
- Service: https://tabularium.matt-3e0.workers.dev (free `/menu`, public `/stats`)

**Install (Claude Code):**

    claude mcp add tabularium --env TABULARIUM_PRIVATE_KEY=0x... -- npx -y tabularium-mcp

**Install (JSON config):**

```json
{
  "mcpServers": {
    "tabularium": {
      "command": "npx",
      "args": ["-y", "tabularium-mcp"],
      "env": { "TABULARIUM_PRIVATE_KEY": "0x...", "TABULARIUM_MAX_SPEND_USD": "1" }
    }
  }
}
```

**Requirements:** an EVM wallet with a few dollars of USDC on Base (no ETH needed). Use a dedicated wallet.

**Transport:** stdio (runs locally; the wallet key never leaves the user's machine).

## Where, and status

| Directory | How | Status |
|---|---|---|
| MCP Registry | `mcp-publisher publish` | listed (0.3.1) |
| x402 Bazaar | automatic after settled CDP payments | listed (4 routes) |
| Glama (glama.ai/mcp/servers) | Indexes GitHub; claim the listing (glama.json in repo root names SQLazy) | to claim |
| mcp.so | /submit, login | skipped: listing costs $39 (2026-10-26); revisit once /stats shows paying wallets |
| Smithery (smithery.ai/new) | GitHub login; check it accepts local stdio (npx) servers | to check |
| PulseMCP | reportedly syncs from the MCP Registry | check in a few days |
