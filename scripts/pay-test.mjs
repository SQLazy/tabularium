// Pays the LIVE endpoint with a throwaway payer wallet, then verifies the export offline.
//   node scripts/pay-test.mjs https://tabularium.<you>.workers.dev
// Payer: PAYER_FILE (default .testnet-wallets.json; mainnet: .secrets/mainnet-payer.json). The network is whatever the
// service's menu says, so the same script tests testnet and mainnet. On mainnet one run costs about $0.28 of real USDC.
import { readFileSync } from "node:fs";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { verifyExport, verifySnapshot } from "../verifier/verify.mjs";

const BASE = (process.argv[2] ?? "").replace(/\/$/, "");
if (!BASE) throw new Error("usage: node scripts/pay-test.mjs <baseUrl>");
const w = JSON.parse(readFileSync(process.env.PAYER_FILE ?? ".testnet-wallets.json", "utf8"));
const account = { address: w.payer.address };
// Every request this script makes carries the test marker, so our own runs never count as demand in the funnel.
// Copies a Request's own headers when no init headers are given (setting init.headers would replace them).
const tfetch = (input, init = {}) => {
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set("x-tabularium-test", "1");
  return fetch(input, { ...init, headers });
};
const NET = (await (await tfetch(`${BASE}/menu`)).json()).x402.network;
console.log(`network ${NET}, payer ${account.address}`);
// The official x402 v2 client, independent of our MCP signer, so this also proves third-party clients work.
const payFetch = wrapFetchWithPaymentFromConfig(tfetch, {
  schemes: [{ network: NET, client: new ExactEvmScheme(privateKeyToAccount(w.payer.privateKey)) }],
});

// Settlement can fail transiently on the shared testnet facilitator (nonce collisions on its own wallet).
// A real agent retries; writes carry an idempotency_key so the retry can never double-write.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function paid(url, init, tries = 4) {
  let res;
  for (let i = 0; i < tries; i++) {
    res = await payFetch(url, init);
    if (res.status !== 402) return res;
    await sleep(3000 * (i + 1));
  }
  return res;
}
const writeInit = (key, value, idem) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ key, value, idempotency_key: idem }),
});

let failed = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + extra}`);
  if (!ok) failed++;
};
const j = async (res) => ({ status: res.status, json: await res.json().catch(() => null), pay: res.headers.get("payment-response") });

const stats0 = await (await tfetch(`${BASE}/stats`)).json();
const menu = await j(await tfetch(`${BASE}/menu`));
check("menu is free", menu.status === 200, JSON.stringify(menu.json));
{
  const mem = menu.json?.services?.find((s) => s.id === "memory");
  check(
    "menu lists the services, and memory's calls and prices match the legacy list",
    !!mem && mem.calls.length === menu.json.calls.length && mem.calls.every((c, i) => menu.json.calls[i].call.startsWith(c.call) && menu.json.calls[i].price === c.price),
    JSON.stringify(menu.json?.services)?.slice(0, 200),
  );
}
const pub = menu.json?.signing?.publicKeyHex;

const llms = await tfetch(`${BASE}/llms.txt`);
const llmsText = await llms.text();
check("llms.txt is free and shows the live prices", llms.status === 200 && menu.json.calls.every((c) => llmsText.includes(c.price)), String(llms.status));

// Discovery for x402 explorers and agent wallets: free OpenAPI with the menu's prices, and every paid route answers
// a bare probe (no body, no query, no payment) with 402, which is how x402scan registers a route.
{
  const oa = await tfetch(`${BASE}/openapi.json`);
  const doc = await oa.json().catch(() => null);
  const priceOf = (path, method) => doc?.paths?.[path]?.[method]?.["x-payment-info"]?.price?.amount;
  const same = menu.json.calls.every((c) => {
    const [method, rest] = c.call.split(" ");
    return priceOf(rest.split("?")[0], method.toLowerCase()) === c.price.slice(1);
  });
  check("openapi.json is free and prices every paid call as the menu does", oa.status === 200 && doc?.openapi === "3.1.0" && same, String(oa.status));
  const probes = menu.json.services.flatMap((s) => s.calls.map((c) => c.call.split(" ")));
  const got = await Promise.all(probes.map(async ([method, path]) => (await tfetch(`${BASE}${path}`, { method })).status));
  check(`bare probes of all ${probes.length} paid routes get 402`, probes.length >= 5 && got.every((s) => s === 402), got.join(","));
}

let r = await j(await tfetch(`${BASE}/write`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "a", value: "x" }) }));
check("unpaid write -> 402", r.status === 402, String(r.status));

const key = "hello-" + Date.now();
r = await j(await paid(`${BASE}/write`, writeInit(key, "first paid write", "first-" + key)));
check("PAID write succeeds", r.status === 200 && r.json?.entry?.seq >= 1, JSON.stringify(r));
check("settlement receipt returned", !!r.pay, "no X-PAYMENT-RESPONSE header");

r = await j(await paid(`${BASE}/read?key=${encodeURIComponent(key)}`));
check("PAID read returns the value", r.status === 200 && r.json?.value === "first paid write", JSON.stringify(r));

r = await j(await payFetch(`${BASE}/write`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "bad key\n", value: "x" }) }));
check("invalid write -> 400 and not charged", r.status === 400 && !r.pay, JSON.stringify(r));

const idemInit = writeInit("retry-demo", "v", "live-" + Date.now());
const w1 = await j(await paid(`${BASE}/write`, idemInit));
const w2 = await j(await paid(`${BASE}/write`, idemInit));
check(
  "idempotent retry returns the same entry, not a duplicate",
  w1.status === 200 && w2.status === 200 && w2.json?.replayed === true && w1.json?.entry?.seq === w2.json?.entry?.seq,
  JSON.stringify({ w1: w1.json?.entry?.seq, w2: w2.json?.entry?.seq, replayed: w2.json?.replayed }),
);

const before = await j(await tfetch(`${BASE}/head?wallet=${account.address}`));
const rn = await j(await paid(`${BASE}/renew`, { method: "POST" }));
check(
  "PAID renew extends the term by 30 days from the current expiry",
  rn.status === 200 && rn.json?.expiresAt - before.json?.expiresAt === 30 * 86_400_000 && !!rn.pay,
  JSON.stringify({ status: rn.status, before: before.json?.expiresAt, after: rn.json?.expiresAt }),
);

const exp = await j(await paid(`${BASE}/export`));
check("PAID export succeeds", exp.status === 200, JSON.stringify(exp).slice(-1200));
if (exp.status === 200) {
  const v = await verifyExport(exp.json, pub);
  check("export verifies offline against the published key", v.ok, v.errors.join("; "));
  check("export wallet is the payer", String(exp.json.wallet).toLowerCase() === account.address.toLowerCase(), String(exp.json.wallet));
}

const head = await j(await tfetch(`${BASE}/head?wallet=${account.address}`));
check("public head available", head.status === 200 && head.json?.seq >= 1, JSON.stringify(head));

// Security review, finding 2: renew settles upfront, so a missing workspace must be refused by the free pre-check.
// A brand-new wallet with no funds: without the pre-check this would be a 402 (or a charge); with it, a free 404.
const { generatePrivateKey } = await import("viem/accounts");
const stranger = privateKeyToAccount(generatePrivateKey());
const strangerFetch = wrapFetchWithPaymentFromConfig(tfetch, { schemes: [{ network: NET, client: new ExactEvmScheme(stranger) }] });
const sr = await strangerFetch(`${BASE}/renew`, { method: "POST" });
check("renew for a wallet with no workspace is refused free (pre-check 404, nothing settled)", sr.status === 404 && !sr.headers.get("payment-response"), String(sr.status));

// Finding 1: one signed payment buys one call. Sign once with our own client, send it 5 times at once.
const { createPaymentHeader, decodePaymentRequired } = await import("../mcp/x402.mjs");
const unpaid = await tfetch(`${BASE}/write`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const required = decodePaymentRequired(unpaid.headers.get("PAYMENT-REQUIRED"));
const oneHeader = await createPaymentHeader(privateKeyToAccount(w.payer.privateKey), required, required.accepts[0]);
const burst = await Promise.all(
  Array.from({ length: 5 }, (_, i) =>
    tfetch(`${BASE}/write`, {
      method: "POST",
      headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": oneHeader },
      body: JSON.stringify({ key: `burst-${Date.now()}-${i}`, value: "one payment" }),
    }).then((res) => ({ status: res.status, paid: !!res.headers.get("payment-response") })),
  ),
);
check(
  "one payment sent 5 times at once is served exactly once",
  // The duplicates are refused either by our nonce claim (409) or, if the first one has already settled, by the
  // facilitator at verify (402). Either way: served once, paid once, never served again.
  burst.filter((b) => b.status === 200).length === 1 && burst.filter((b) => b.paid).length === 1 && burst.every((b) => b.status === 200 || b.status === 409 || b.status === 402),
  JSON.stringify(burst),
);

// Snapshot service: one paid fetch, verified offline; a refused URL is not charged.
{
  const snapInit = (url) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });
  const sn = await j(await paid(`${BASE}/snapshot/fetch`, snapInit("https://example.com/")));
  const sv = sn.status === 200 ? await verifySnapshot(sn.json, pub) : { ok: false, errors: [] };
  check(
    "PAID snapshot returns the page and a signature that verifies offline",
    sn.status === 200 && !!sn.pay && sv.ok && String(sn.json.snapshot.wallet).toLowerCase() === account.address.toLowerCase(),
    JSON.stringify({ status: sn.status, errors: sv.errors, body: sn.json }).slice(0, 300),
  );
  const bad = await j(await payFetch(`${BASE}/snapshot/fetch`, snapInit("http://localhost/")));
  check("snapshot of a non-public URL -> 400 and not charged", bad.status === 400 && !bad.pay, JSON.stringify(bad));
}

// Charged above: write, read, retry-demo write, its replay, renew, export = 6, the one burst write = 7, one snapshot = 8. The payer is an excluded test wallet,
// so they must land in excludedTestCalls and leave the real metric untouched. Recording runs after the response.
await new Promise((res) => setTimeout(res, 3000));
const stats1 = await (await tfetch(`${BASE}/stats`)).json();
check(
  "settled calls are recorded, as test traffic only",
  stats1.excludedTestCalls - stats0.excludedTestCalls === 8 && stats1.wallets === stats0.wallets && stats1.paidCalls === stats0.paidCalls,
  JSON.stringify({ excluded: stats1.excludedTestCalls - stats0.excludedTestCalls, wallets: stats1.wallets - stats0.wallets, calls: stats1.paidCalls - stats0.paidCalls }),
);

// The funnel: every request above was marked, so it lands in excludedTestFunnelEvents, not in memory's funnel.
// (Real traffic can arrive during a live run, so the check allows for it: our own 7 charges must not show as paid.)
{
  const f0 = stats0.services?.memory?.funnel ?? { paid: 0 };
  const f1 = stats1.services?.memory?.funnel;
  const ours = stats1.excludedTestFunnelEvents - (stats0.excludedTestFunnelEvents ?? 0);
  check("marked test traffic is kept out of the demand funnel", !!f1 && ours >= 14 && f1.paid - f0.paid < 7, JSON.stringify({ ours, paid: f1 && f1.paid - f0.paid }));
}

console.log(`\npayer ${account.address}`);
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
