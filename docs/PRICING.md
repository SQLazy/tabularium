# Pricing: when snapshot's price moves

Snapshot stays at **$0.005** while it proves it is worth more than the $0.001-0.002 page readers on the x402
Bazaar. The price only moves when the numbers below say price is what stops buyers. Decided 2026-11-07; any
change is still the owner's call, made in its own PR.

## Why not just match the cheapest

The busiest page readers on the Bazaar (7 Nov 2026 crawl, 30-day numbers) charge less:

| Seller | Price | Calls (30 days) |
|---|---|---|
| oneshotagent `web-read` | $0.002 | 9,946 |
| clawfetch `fetch` | $0.001 | 3,084 |
| Tabularium snapshot | $0.005 | 2 |

What snapshot does that they don't:

- **Reads the page as a person sees it.** Text hidden from people (inline `display:none`, zero-size, off-screen,
  invisible Unicode) is kept out of the text and reported, with a prompt-injection verdict (#4).
- **Reads PDF, Word, Excel and OpenDocument files** as markdown (#5).
- **Signs every read.** An Ed25519 record of what was served, from which final URL and when, verifies offline.
- **Charges only for a page it could read.** Refused URLs, the site's own errors and empty documents cost nothing.

Cutting the price first would throw that margin away before anyone has seen it.

## What decides it

`/stats` → `services.snapshot.funnel`:

- **`quotedWithRequest` (A):** quotes whose request carried a real URL. Probes that send nothing, or the
  listing's own example URL, are left out, and so are robots. These are agents that wanted a page read, saw
  the price, and either paid or left. Counted from 2026-11-08.
- **`paid` (P):** paid snapshot calls. Our own test runs are excluded.

Raw `quoted` is no use here: on 7 Nov it was about 2,150 a week with 0 paid, and most of it is listers and
rankers checking the paywall.

## The rule, read on 2026-11-22 (14 days of data)

1. **A < 20: nobody real is asking.** That is a problem of being found, not of price. Keep $0.005. Work on
   reach first: refresh the Bazaar listing with a paid call (it still shows the old description until one
   settles), get into the MCP directories, and write a post about hidden prompt injection in fetched pages.
2. **A ≥ 20 and P/A < 5%: agents ask and leave.** Propose a 14-day test at **$0.003**: still a premium over the
   leaders, with the extras as the reason. Keep it if conversion at least doubles; otherwise go back to $0.005,
   since price was not the reason.
3. **P/A ≥ 5%: price is not the barrier.** Keep $0.005. Once paid calls pass 50, consider testing higher.

Branch `snapshot-price-0002` (closed PR #6) holds a ready $0.002 change if the numbers ever argue for it.
