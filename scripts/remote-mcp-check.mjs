#!/usr/bin/env node
// Live check of the remote MCP endpoint (POST /mcp) with real payments, the way an outside x402 MCP client pays:
// an unpaid tools/call returns PaymentRequired, the retry carries the PaymentPayload in _meta["x402/payment"].
//
//   node scripts/remote-mcp-check.mjs [base]          free checks only, prints what the paid run would cost
//   PAYER_FILE=.secrets/mainnet-payer.json node scripts/remote-mcp-check.mjs [base] --pay
//
// Paid run (about $0.02): write stack/hello, read it back, snapshot example.com, export, then verify the export and
// the snapshot offline against /menu's signing key, and check /stats counted it as excluded test traffic only.
// Refuses to sign unless each requirement matches /menu (network, payee, USDC) and is within that call's menu price.
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { createPaymentHeader, decodePaymentResponse } from "../mcp/x402.mjs";
import { verifyExport, verifySnapshot } from "../verifier/verify.mjs";

const args = process.argv.slice(2);
const PAY = args.includes("--pay");
const BASE = (args.find((a) => !a.startsWith("--")) ?? "https://tabularium.matt-3e0.workers.dev").replace(/\/$/, "");
const MAX_TOTAL_USD = 0.05;
const TEST = { "x-tabularium-test": "1" };

let fails = 0;
const check = (name, ok, info) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || info === undefined ? "" : "  " + JSON.stringify(info).slice(0, 400)}`);
  if (!ok) {
    fails++;
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=remote-mcp-check::${name}`);
  }
  return ok;
};

let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...TEST },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  return res.json();
}
const call = (name, args, payment) => rpc("tools/call", { name, arguments: args, ...(payment ? { _meta: { "x402/payment": payment } } : {}) });
const usd = (s) => Number(String(s).replace("$", ""));
const stats = async () => (await fetch(`${BASE}/stats`, { headers: TEST })).json();

// ---- free part -------------------------------------------------------------------------------------------------
const menu = await (await fetch(`${BASE}/menu`, { headers: TEST })).json();
const NET = menu.x402?.network;
const PAY_TO = menu.payTo;
if (!/^0x[0-9a-fA-F]{40}$/.test(PAY_TO ?? "")) throw new Error("menu has no payTo");
const PUB = menu.signing?.publicKeyHex;
const price = Object.fromEntries((menu.services ?? []).flatMap((s) => s.calls.map((c) => [c.name, usd(c.price)])));
console.log(`base ${BASE}, network ${NET}, payTo ${PAY_TO}`);

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "remote-mcp-check", version: "1" } });
check("initialize", init.result?.serverInfo?.name === "tabularium", init);
const tools = (await rpc("tools/list", {})).result?.tools?.map((t) => t.name) ?? [];
check("tools/list has the paid tools", ["tabularium_write", "tabularium_read", "tabularium_export", "tabularium_snapshot_fetch"].every((n) => tools.includes(n)), tools);

const PLAN = [
  ["tabularium_write", { key: "stack/hello", value: JSON.stringify({ hello: "stack", at: new Date().toISOString(), via: "remote /mcp" }), idempotency_key: `stack-hello-${Date.now()}` }, "write"],
  ["tabularium_read", { key: "stack/hello" }, "read"],
  ["tabularium_snapshot_fetch", { url: "https://example.com/" }, "snapshot/fetch"],
  ["tabularium_export", {}, "export"],
];
const menuPrice = (call) => price[call] ?? price[call.split("/").pop()];
const total = PLAN.reduce((s, [, , c]) => s + (menuPrice(c) ?? Infinity), 0);
console.log(`paid run would cost $${total.toFixed(3)} (cap $${MAX_TOTAL_USD})`);

const quote = await call("tabularium_write", PLAN[0][1]);
const pr = quote.result?.structuredContent;
check("unpaid call returns PaymentRequired as a tool error", quote.result?.isError === true && pr?.x402Version === 2 && pr?.accepts?.length > 0, quote);

if (!PAY) {
  console.log(fails ? `${fails} FAILED` : "free checks passed. Add --pay (with PAYER_FILE) for the paid run.");
  process.exit(fails ? 1 : 0);
}

// ---- paid part -------------------------------------------------------------------------------------------------
if (!process.env.PAYER_FILE) throw new Error("--pay needs PAYER_FILE (the stack wallet's key file)");
if (!(total <= MAX_TOTAL_USD)) throw new Error(`refusing: run would cost $${total} > cap $${MAX_TOTAL_USD}`);
const account = privateKeyToAccount(JSON.parse(readFileSync(process.env.PAYER_FILE, "utf8")).payer.privateKey);
console.log(`payer ${account.address}`);
const before = await stats();

async function paid(name, toolArgs, menuCall) {
  const first = await call(name, toolArgs);
  const required = first.result?.structuredContent;
  if (!first.result?.isError || !required?.accepts) return { first, res: first };
  const req = required.accepts.find((r) => r.scheme === "exact" && r.network === NET);
  const cap = Math.round((menuPrice(menuCall) ?? 0) * 1e6);
  if (!req) throw new Error(`${name}: no exact option on ${NET}`);
  if (req.payTo.toLowerCase() !== String(PAY_TO).toLowerCase()) throw new Error(`${name}: payee ${req.payTo} is not the menu's ${PAY_TO}`);
  if (BigInt(req.amount) > BigInt(cap)) throw new Error(`${name}: asks ${req.amount} atomic, menu price is ${cap}`);
  const header = await createPaymentHeader(account, required, req);
  const payload = JSON.parse(Buffer.from(header, "base64").toString("utf8")); // the PaymentPayload object, as the spec sends it
  const res = await call(name, toolArgs, payload);
  return { first, res, req };
}

const results = {};
for (const [name, toolArgs, menuCall] of PLAN) {
  const { res, req } = await paid(name, toolArgs, menuCall);
  const r = res.result ?? {};
  const receipt = r._meta?.["x402/payment-response"];
  results[name] = r.structuredContent;
  check(`${name}: paid through /mcp and settled (${req ? "$" + Number(req.amount) / 1e6 : "?"})`, !r.isError && receipt?.success === true && /^0x[0-9a-f]{64}$/i.test(receipt?.transaction ?? ""), r);
  if (receipt?.transaction) console.log(`      tx ${receipt.transaction}`);
}

const w = results.tabularium_write;
check("read returns what the write stored", results.tabularium_read?.entry?.hash === w?.entry?.hash, { read: results.tabularium_read?.entry, write: w?.entry });
const exp = results.tabularium_export;
const ve = exp ? await verifyExport(exp, PUB) : { ok: false, errors: ["no export"] };
check("export verifies offline against /menu's key", ve.ok, ve.errors);
check("export contains stack/hello", exp?.entries?.some((e) => e.key === "stack/hello" && e.hash === w?.entry?.hash), exp?.entries?.slice(-3));
const vs = results.tabularium_snapshot_fetch ? await verifySnapshot(results.tabularium_snapshot_fetch, PUB) : { ok: false, errors: ["no snapshot"] };
check("snapshot verifies offline", vs.ok, vs.errors);

// /stats records settled calls via waitUntil: give it a few seconds.
let after;
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  after = await stats();
  if (after.excludedTestCalls >= before.excludedTestCalls + PLAN.length) break;
}
check(`/stats: +${PLAN.length} excluded test calls`, after.excludedTestCalls - before.excludedTestCalls === PLAN.length, { before: before.excludedTestCalls, after: after.excludedTestCalls });
check("/stats: outside wallets and revenue unchanged", after.wallets === before.wallets && after.revenueUsd === before.revenueUsd, { before: [before.wallets, before.revenueUsd], after: [after.wallets, after.revenueUsd] });
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
