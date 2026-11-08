// Who comes back: from one window of x402 payments, how many wallets paid each seller, how many of them paid more
// than once, and how much of the seller's volume its single busiest wallet made. Robots that check a paywall pay
// once; a seller whose volume is one wallet has one customer (or pays itself). Counts only: no wallet address
// leaves this module.
//
// bySeller: Map<payee, { usd: number, payments: number, from: Map<wallet, payments> }>

const round = (n, d) => Number(n.toFixed(d));

/** Sellers ranked by wallets that paid more than once, then by USD. */
export function sellerDemand(bySeller, label, top = 10) {
  const rows = [...bySeller.entries()].map(([payee, s]) => {
    const counts = [...s.from.values()].sort((a, b) => b - a);
    return {
      seller: label(payee),
      usd: round(s.usd, 2),
      payments: s.payments,
      wallets: counts.length,
      cameBack: counts.filter((c) => c > 1).length,
      topWalletShare: s.payments ? round((counts[0] ?? 0) / s.payments, 3) : 0,
    };
  });
  rows.sort((a, b) => b.cameBack - a.cameBack || b.usd - a.usd || a.seller.localeCompare(b.seller));
  return rows.slice(0, top);
}

/** The whole window: paying wallets, how many paid once, and the share of payments the 10 busiest wallets made. */
export function walletConcentration(bySeller) {
  const perWallet = new Map();
  for (const s of bySeller.values()) for (const [w, n] of s.from) perWallet.set(w, (perWallet.get(w) ?? 0) + n);
  const counts = [...perWallet.values()].sort((a, b) => b - a);
  const total = counts.reduce((n, c) => n + c, 0);
  return {
    wallets: counts.length,
    paidOnce: counts.filter((c) => c === 1).length,
    top10Share: total ? round(counts.slice(0, 10).reduce((n, c) => n + c, 0) / total, 3) : 0,
  };
}
