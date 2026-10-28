// ALL YOUR BASE: counts what machines paid over x402 on Base in the last 24 hours, from public data only.
//   node scripts/ayb/collect.mjs <outDir>
// "x402 payment" here = a USDC transfer on Base that (a) went to a payee listed on Coinbase's x402 Bazaar and
// (b) was made with an EIP-3009 authorization (the scheme x402 "exact" uses), i.e. the same transaction emitted
// USDC's AuthorizationUsed event. Writes <outDir>/ticker.json and <outDir>/sellers.json (payee -> name).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const OUT = process.argv[2] ?? "ayb-out";
const RPC = process.env.AYB_RPC ?? "https://base-rpc.publicnode.com";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const AUTH_USED = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const BLOCKS_24H = 43_200; // Base: one block every 2 s
const SELLERS_MAX_AGE_MS = 24 * 3600_000;

mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(method, params, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(60_000) });
      const j = await r.json();
      if (j.error) throw Object.assign(new Error(j.error.message ?? JSON.stringify(j.error)), { rpc: true });
      return j.result;
    } catch (err) {
      if (err.rpc || i >= tries - 1) throw err;
      await sleep(2000 * (i + 1));
    }
  }
}

/** eth_getLogs over [from, to], halving the range whenever the node says it is too wide or returns too much. */
async function logs(filter, from, to) {
  try {
    return await rpc("eth_getLogs", [{ ...filter, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }]);
  } catch (err) {
    if (!/exceed|too many|range|limit/i.test(err.message) || from >= to) throw err;
    const mid = Math.floor((from + to) / 2);
    return [...(await logs(filter, from, mid)), ...(await logs(filter, mid + 1, to))];
  }
}

// ---- 1. Bazaar payees (refreshed once a day; the full list is ~90k resources) --------------------------------
async function sellers() {
  const path = `${OUT}/sellers.json`;
  const cached = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  if (cached && Date.now() - Date.parse(cached.asOf) < SELLERS_MAX_AGE_MS) return cached;
  const payees = {};
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    let page;
    for (let i = 0; i < 4; i++) {
      try {
        page = await (await fetch(`https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=100&offset=${offset}`, { signal: AbortSignal.timeout(60_000) })).json();
        break;
      } catch {
        await sleep(3000 * (i + 1));
      }
    }
    const items = page?.items ?? [];
    total = page?.pagination?.total ?? offset + items.length;
    if (!items.length) break;
    for (const it of items) {
      let host = null;
      try {
        host = new URL(it.resource).host;
      } catch {}
      const name = it.extensions?.bazaar?.info?.serviceName ?? it.serviceName ?? null;
      for (const a of it.accepts ?? []) {
        if (a.network !== "eip155:8453" || String(a.asset).toLowerCase() !== USDC || !/^0x[0-9a-fA-F]{40}$/.test(a.payTo ?? "")) continue;
        const k = a.payTo.toLowerCase();
        const s = (payees[k] ??= { host, name, resources: 0 });
        s.resources++;
        if (!s.name && name) s.name = name;
        if (!s.host && host) s.host = host;
      }
    }
    offset += items.length;
  }
  const out = { asOf: new Date().toISOString(), resources: offset, payees };
  writeFileSync(path, JSON.stringify(out));
  return out;
}

// ---- 2. the last 24 hours -------------------------------------------------------------------------------------
const t0 = Date.now();
const bazaar = await sellers();
const payeeList = Object.keys(bazaar.payees);
console.log(`bazaar: ${bazaar.resources} resources, ${payeeList.length} Base USDC payees (as of ${bazaar.asOf})`);

const head = Number(BigInt(await rpc("eth_blockNumber", [])));
const from = head - BLOCKS_24H + 1;
const headBlock = await rpc("eth_getBlockByNumber", ["0x" + head.toString(16), false]);
const headTs = Number(BigInt(headBlock.timestamp)) * 1000;

const auth = await logs({ address: USDC, topics: [AUTH_USED] }, from, head);
const authTx = new Set(auth.map((a) => a.transactionHash));
console.log(`EIP-3009 authorizations used in 24h: ${auth.length}`);

const transfers = [];
for (let i = 0; i < payeeList.length; i += 200) {
  const chunk = payeeList.slice(i, i + 200).map((p) => "0x" + p.slice(2).padStart(64, "0"));
  transfers.push(...(await logs({ address: USDC, topics: [TRANSFER, null, chunk] }, from, head)));
}

let usd = 0;
const payers = new Set();
const bySeller = new Map();
const byHour = new Array(24).fill(0);
let biggest = null;
for (const l of transfers) {
  if (!authTx.has(l.transactionHash)) continue;
  const amount = Number(BigInt(l.data)) / 1e6;
  const to = "0x" + l.topics[2].slice(26);
  const fromAddr = "0x" + l.topics[1].slice(26);
  usd += amount;
  payers.add(fromAddr);
  const s = bySeller.get(to) ?? { usd: 0, payments: 0 };
  s.usd += amount;
  s.payments++;
  bySeller.set(to, s);
  const hoursAgo = Math.min(23, Math.floor(((head - Number(BigInt(l.blockNumber))) * 2) / 3600));
  byHour[23 - hoursAgo] += amount;
  if (!biggest || amount > biggest.usd) biggest = { usd: amount, to };
}
const label = (p) => bazaar.payees[p]?.name ?? bazaar.payees[p]?.host ?? `${p.slice(0, 6)}…${p.slice(-4)}`;
const top = [...bySeller.entries()].sort((a, b) => b[1].usd - a[1].usd).slice(0, 10).map(([p, s]) => ({ seller: label(p), host: bazaar.payees[p]?.host ?? null, usd: Number(s.usd.toFixed(2)), payments: s.payments }));
const payments = [...bySeller.values()].reduce((n, s) => n + s.payments, 0);

const ticker = {
  schema: "tabularium/ayb/v1",
  asOf: new Date(headTs).toISOString(),
  window: { hours: 24, fromBlock: from, toBlock: head },
  definition:
    "USDC paid on Base to payees listed on Coinbase's x402 Bazaar, in transactions that used an EIP-3009 authorization (the x402 'exact' scheme). Public chain data; payee names from the Bazaar.",
  usd: Number(usd.toFixed(2)),
  payments,
  payers: payers.size,
  activeSellers: bySeller.size,
  listedSellers: payeeList.length,
  biggest: biggest ? { usd: Number(biggest.usd.toFixed(2)), seller: label(biggest.to) } : null,
  perHourUsd: byHour.map((v) => Number(v.toFixed(2))),
  top,
  tookMs: Date.now() - t0,
};
writeFileSync(`${OUT}/ticker.json`, JSON.stringify(ticker, null, 2) + "\n");
// The small map the browser needs for the Wrapped card: payee -> display name, only sellers that ever appear.
writeFileSync(`${OUT}/names.json`, JSON.stringify(Object.fromEntries(Object.entries(bazaar.payees).map(([p, s]) => [p, s.name ?? s.host]))));
console.log(JSON.stringify({ ...ticker, perHourUsd: undefined, top: ticker.top.slice(0, 5) }, null, 2));
