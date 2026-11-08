// /allyourbase "who comes back": per-seller wallet counts from one window of payments.
import { describe, expect, it } from "vitest";
import { sellerDemand, walletConcentration } from "../scripts/ayb/demand.mjs";

const seller = (usd, from) => ({ usd, payments: Object.values(from).reduce((n, c) => n + c, 0), from: new Map(Object.entries(from)) });

const bySeller = new Map([
  // one wallet, many payments: one customer
  ["0xwhale", seller(50, { a: 900 })],
  // a swarm that pays once each: robots checking the paywall
  ["0xprobed", seller(3, Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`p${i}`, 1])))],
  // a few wallets that come back
  ["0xloved", seller(2, { a: 3, b: 2, c: 5, d: 1 })],
]);
const label = (p) => ({ "0xwhale": "Whale Co", "0xprobed": "Probed", "0xloved": "Loved" })[p];

describe("sellerDemand", () => {
  it("ranks by wallets that came back, not by payers or dollars", () => {
    const rows = sellerDemand(bySeller, label);
    expect(rows.map((r) => r.seller)).toEqual(["Loved", "Whale Co", "Probed"]);
    expect(rows[0]).toEqual({ seller: "Loved", usd: 2, payments: 11, wallets: 4, cameBack: 3, topWalletShare: 0.455 });
    expect(rows[1]).toMatchObject({ wallets: 1, cameBack: 1, topWalletShare: 1 });
    expect(rows[2]).toMatchObject({ wallets: 300, cameBack: 0, topWalletShare: 0.003 });
  });

  it("keeps the top n and never puts a wallet address in a row", () => {
    const rows = sellerDemand(bySeller, label, 2);
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toMatch(/"(a|b|c|d|p\d+)"/);
  });
});

describe("walletConcentration", () => {
  it("counts wallets once across sellers, the one-time payers, and the 10 busiest wallets' share", () => {
    const w = walletConcentration(bySeller);
    expect(w.wallets).toBe(304); // a (paid two sellers), b, c, d, 300 probes
    expect(w.paidOnce).toBe(301); // d and the 300 probes
    expect(w.top10Share).toBeCloseTo((903 + 5 + 2 + 7 * 1) / 1211, 3);
  });

  it("an empty window is all zeros", () => {
    expect(walletConcentration(new Map())).toEqual({ wallets: 0, paidOnce: 0, top10Share: 0 });
  });
});
