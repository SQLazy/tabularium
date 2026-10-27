# Security

## Reporting

Open a private security advisory on GitHub (Security → Report a vulnerability) rather than a public issue.

## Payment-path review, 2026-10-26 (before mainnet)

Scope: payer identity, the order of settlement and writes, idempotency, payment reuse, facilitator credentials,
`/stats`, the no-paywall build, and the MCP client's `tabularium_pay`. Each fix has a test, and each test was
checked by breaking the fix and watching the test fail.

| # | Finding | Severity | Fix | Test |
|---|---|---|---|---|
| 1 | **One payment, many calls.** With settle-after-handler, the same signed `PAYMENT-SIGNATURE` sent N times at once passed verification N times and ran N handlers, but settled once. | High | Each workspace (one per paying wallet) records the payment's EIP-3009 nonce; a reused payment gets `409 payment_reused` and is never settled (`Workspace.claimPayment`). | e2e: sequential reuse, 8 concurrent, reads. Live: one real payment sent 5× at once is served once. |
| 2 | **Free renew/export by failing settlement.** A payer could empty the wallet, or burn the nonce, between verify and settle; the handler had already run. renew ($0.25) and export ($0.01) are worth more than that gas. | Medium | renew and export use the `upfront` payment flow (settle, then run). A free pre-check rejects a missing workspace before anything settles; it reveals only what the public `/head` does. | Live: an unfunded new wallet asking to renew gets a free 404. |
| 3 | **`/stats` load.** Public endpoint; cohort queries scan every wallet on one global object. | Low | Cohort-style figures cached for 60 s; cheap totals stay live. | e2e + live recording checks. |
| 4 | **No-paywall build trusts the header.** If ever deployed, anyone could act as any wallet. | Low (defence in depth) | It answers only on localhost (`dev_build_local_only` otherwise). It is a separate Worker name and config, never the production entry point. | Manual: a foreign `Host` gets 403. |
| 5 | **MCP pay followed redirects.** Payment and receipt could go to a different host than requested, and the signed header could be forwarded to another origin. | Medium | Paid requests use `redirect: "manual"`; a 3xx is returned unpaid. | Offline: both requests use manual redirects. |
| 6 | **MCP pay: long-lived authorizations.** A seller could ask for a long `maxTimeoutSeconds`, answer with an error, and settle later. | Low | Authorization window capped at 10 minutes; the error message no longer claims "nothing was charged" and returns the nonce to check on-chain. | Offline: a 30-day request gets ≤ 10 minutes. |

Confirmed sound (no change): identity comes only from `PAYMENT-SIGNATURE` (the header the v2 server verifies;
`X-PAYMENT` and v1 payloads are refused); the signing key is checked against the published key before any state
change; writes are serialized per workspace and committed in one transaction; idempotency keys are bound to the
exact key and value; CDP tokens are minted per request, live 120 s and are bound to one method and path; secrets
live only in Cloudflare.

## Known residual risks

- **write/read settle after the handler.** A payer who makes settlement fail after the handler ran (drain the
  wallet in the gap) gets that call free. The gas this costs is above the $0.002–0.003 price, so it is not
  profitable; reuse of one payment (the cheap version) is blocked by finding 1.
- **renew/export settle before the handler.** If the handler then fails (a 5xx), the payer was charged for nothing.
  Expected to be rare; there is no automatic refund.
- **Facilitator dependency.** Coinbase verifies and settles. If it is down, paid calls fail (and are not charged).
- **No per-wallet storage quota** beyond price (64 KB per value, $0.003 per write).
- **One global Stats object.** Fine at current volume; shard it before heavy traffic.
- **`@x402/core` pins zod 3** (GHSA-mrhx-c7xc-m3w5: memory on oversized collections). Inputs it parses are
  header-sized; revisit when @x402 moves to zod 4. The MCP package does not use it.
- **`tabularium_pay` pays whoever a seller names**, by design, bounded by `TABULARIUM_PAY_MAX_USD`, the session
  spend cap and the networks allow-list (mainnet is opt-in). Seller responses are untrusted content.
- **Signing key.** Held only as a Cloudflare secret; anyone with Worker-admin access could sign heads. Rotation
  keeps old public keys in `/menu` (`signing.retired`).
