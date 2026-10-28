// The browser half of /allyourbase, kept as plain functions so tests can run them in Node (see test/ayb.test.ts).
// It reads public chain data straight from a public Base node: one wallet's last 7 days of x402 payments.

export const AYB_CLIENT = String.raw`
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const AUTH_USED = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const DAY_BLOCKS = 43200;

/** Joins a wallet's EIP-3009 authorizations with its USDC transfers in the same transactions: its x402 payments. */
function x402Payments(authLogs, transferLogs, headBlock, headTs) {
  const authTx = new Set(authLogs.map((a) => a.transactionHash));
  return transferLogs
    .filter((l) => authTx.has(l.transactionHash))
    .map((l) => ({
      to: "0x" + l.topics[2].slice(26).toLowerCase(),
      usd: Number(BigInt(l.data)) / 1e6,
      ts: headTs - (headBlock - Number(BigInt(l.blockNumber))) * 2000,
    }));
}

function summarize(payments, names) {
  const bySeller = new Map();
  const byDay = new Map();
  let usd = 0;
  let biggest = null;
  for (const p of payments) {
    usd += p.usd;
    const s = bySeller.get(p.to) || { usd: 0, n: 0 };
    s.usd += p.usd;
    s.n++;
    bySeller.set(p.to, s);
    const day = new Date(p.ts).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
    byDay.set(day, (byDay.get(day) || 0) + 1);
    if (!biggest || p.usd > biggest.usd) biggest = p;
  }
  const label = (a) => (names && names[a]) || a.slice(0, 6) + "…" + a.slice(-4);
  const top = [...bySeller.entries()].sort((a, b) => b[1].n - a[1].n || b[1].usd - a[1].usd).map(([a, s]) => ({ seller: label(a), n: s.n, usd: s.usd }));
  const busiest = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    n: payments.length,
    usd,
    sellers: bySeller.size,
    top: top.slice(0, 3),
    biggest: biggest ? { usd: biggest.usd, seller: label(biggest.to) } : null,
    busiestDay: busiest ? busiest[0] : null,
    personality: personality(payments.length, usd, top, biggest),
  };
}

function personality(n, usd, top, biggest) {
  if (!n) return { title: "THE PACIFIST", line: "YOUR AGENT HAS NOT JOINED THE WAR. YET." };
  if (biggest && biggest.usd >= 1) return { title: "THE BIG SPENDER", line: "ONE PURCHASE OVER A DOLLAR. FOR GREAT JUSTICE." };
  if (n >= 100) return { title: "THE SPEEDRUNNER", line: "MOVE 'ZIG'. MOVE 'ZIG'. MOVE 'ZIG'." };
  if (top[0] && top[0].n / n >= 0.6 && top.length > 1) return { title: "THE LOYAL CUSTOMER", line: "IT HAS A FAVOURITE. IT KNOWS WHAT IT LIKES." };
  if (top.length === 1) return { title: "THE MONOGAMIST", line: "ONE SELLER. ONLY ONE. ALWAYS." };
  if (usd / n < 0.005) return { title: "THE PENNY PINCHER", line: "TENTHS OF A CENT AT A TIME. RELENTLESS." };
  if (top.length >= 5) return { title: "THE EXPLORER", line: "IT HAS TRIED EVERYTHING ON THE MENU." };
  return { title: "THE OPERATOR", line: "STEADY. PURPOSEFUL. PAYING ITS WAY." };
}

async function rpc(url, method, params) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc error");
  return j.result;
}

async function logsAdaptive(url, filter, from, to) {
  try {
    return await rpc(url, "eth_getLogs", [{ ...filter, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }]);
  } catch (e) {
    if (from >= to || !/exceed|too many|range|limit/i.test(e.message)) throw e;
    const mid = Math.floor((from + to) / 2);
    return [...(await logsAdaptive(url, filter, from, mid)), ...(await logsAdaptive(url, filter, mid + 1, to))];
  }
}

/** A wallet's x402 payments over the last 'days' days, read from a public node. */
async function walletPayments(url, wallet, days) {
  const who = "0x" + wallet.toLowerCase().slice(2).padStart(64, "0");
  const head = Number(BigInt(await rpc(url, "eth_blockNumber", [])));
  const headTs = Number(BigInt((await rpc(url, "eth_getBlockByNumber", ["0x" + head.toString(16), false])).timestamp)) * 1000;
  const from = head - days * DAY_BLOCKS + 1;
  const auth = [];
  const transfers = [];
  for (let s = from; s <= head; s += 50000) {
    const e = Math.min(s + 49999, head);
    auth.push(...(await logsAdaptive(url, { address: USDC, topics: [AUTH_USED, who] }, s, e)));
    transfers.push(...(await logsAdaptive(url, { address: USDC, topics: [TRANSFER, who] }, s, e)));
  }
  return x402Payments(auth, transfers, head, headTs);
}
`;
