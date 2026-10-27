// Drives the MCP server over stdio like an agent would, against the LIVE testnet service.
//   cd mcp && node smoke.mjs [baseUrl]
// Pays with a throwaway payer: PAYER_FILE (path relative to the repo root), default ../.testnet-wallets.json.
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { checkIntent } from "./ledger.mjs";

// --npx <spec> tests the published package (e.g. --npx tabularium-mcp@0.1.0) instead of the local server.mjs.
const npxAt = process.argv.indexOf("--npx");
const npxSpec = npxAt >= 0 ? process.argv[npxAt + 1] : null;
const BASE = process.argv.slice(2).find((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--npx") ?? "https://tabularium.matt-3e0.workers.dev";
const w = JSON.parse(readFileSync(new URL("../" + (process.env.PAYER_FILE ?? ".testnet-wallets.json"), import.meta.url), "utf8"));

const transport = new StdioClientTransport({
  ...(npxSpec
    ? { command: "npx", args: ["-y", npxSpec], cwd: tmpdir() } // empty-ish dir, so npx fetches from the registry
    : { command: process.execPath, args: [new URL("./server.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")] }),
  env: { ...process.env, TABULARIUM_URL: BASE, TABULARIUM_PRIVATE_KEY: w.payer.privateKey, TABULARIUM_MAX_SPEND_USD: "0.08", TABULARIUM_TEST: "1", TABULARIUM_STATE_DIR: mkdtempSync(join(tmpdir(), "tabularium-smoke-state-")) },
});
console.log(npxSpec ? `testing published ${npxSpec}` : "testing local server.mjs");
const client = new Client({ name: "tabularium-smoke", version: "0.0.0" });
await client.connect(transport);

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
  if (!cond) failed++;
};
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  let json = r.structuredContent;
  if (!json) try { json = JSON.parse(text); } catch { json = null; }
  return { isError: !!r.isError, json, text };
};

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
const core = "tabularium_export,tabularium_head,tabularium_ledger,tabularium_menu,tabularium_pay,tabularium_read,tabularium_reconcile,tabularium_renew,tabularium_verify,tabularium_write".split(",");
check("lists the 10 core tools (plus one per call of other services)", core.every((n) => names.includes(n)) && names.filter((n) => !core.includes(n)).every((n) => /^tabularium_[a-z0-9-]+_/.test(n)), names.join());

const instructions = client.getInstructions() ?? "";
check("server instructions reach the client", /Tabularium/.test(instructions) && /real money/.test(instructions), instructions.slice(0, 80));
const { prompts } = await client.listPrompts();
check("ready-made prompts are listed", prompts.map((p) => p.name).sort().join() === "load_memory,spending_report", JSON.stringify(prompts.map((p) => p.name)));
const lm = await client.getPrompt({ name: "load_memory", arguments: { index_key: "projects/index" } });
check("load_memory prompt uses the given index key", /projects\/index/.test(lm.messages?.[0]?.content?.text ?? ""), JSON.stringify(lm).slice(0, 120));

const liveMenu = await (await fetch(BASE + "/menu")).json();
const writePrice = liveMenu.calls.find((c) => c.call === "POST /write").price;
const writeTool = tools.find((t) => t.name === "tabularium_write");
check("tool descriptions show the live menu price", writeTool.description.startsWith(`Paid (${writePrice}).`), writeTool.description.slice(0, 60));

let r = await call("tabularium_menu");
check("menu is free and names the network", !r.isError && r.json?.network === liveMenu.network && r.json?.mcp?.payerConfigured === true, r.text);

const key = "mcp-smoke-" + Date.now();
r = await call("tabularium_write", { key, value: "written through MCP" });
check("write succeeds and is charged once", !r.isError && r.json?.entry?.seq >= 1 && r.json?.billing?.charged === true, r.text);
const idem = r.json?.idempotency_key;
const seq = r.json?.entry?.seq;

r = await call("tabularium_write", { key, value: "written through MCP", idempotency_key: idem });
check("same idempotency_key replays the same entry", !r.isError && r.json?.replayed === true && r.json?.entry?.seq === seq, r.text);

r = await call("tabularium_read", { key });
check("read returns the value", !r.isError && r.json?.value === "written through MCP", r.text);

r = await call("tabularium_read", { key: "bad key" });
check("invalid key rejected before paying", r.isError, r.text);

const file = join(tmpdir(), `tabularium-export-${Date.now()}.json`);
r = await call("tabularium_export", { save_to: file });
check("export saved and verified offline", !r.isError && r.json?.verification?.ok === true && r.json?.keys?.includes(key), r.text);

r = await call("tabularium_verify", { path: file });
check("saved export re-verifies locally", !r.isError && r.json?.ok === true, r.text);

r = await call("tabularium_verify", { path: file, public_key_hex: "00".repeat(32) });
check("wrong signing key fails verification", !r.isError && r.json?.ok === false, r.text);
rmSync(file, { force: true });

r = await call("tabularium_head");
check("own public head", !r.isError && r.json?.seq >= seq, r.text);

// tabularium_pay: buy something from an x402 endpoint (a Tabularium read stands in for a third party).
const readPrice = Number(liveMenu.calls.find((c) => c.call.startsWith("GET /read")).price.slice(1));
r = await call("tabularium_menu");
const spentBefore = r.json?.mcp?.sessionSpentUsd;
r = await call("tabularium_pay", { url: `${BASE}/read?key=${key}`, reason: "smoke: buy one read", max_usd: readPrice / 2 });
check("pay refuses a price above max_usd, before signing", r.isError && /above the cap/.test(r.text), r.text.slice(0, 200));
r = await call("tabularium_menu");
check("refused purchase charged nothing", r.json?.mcp?.sessionSpentUsd === spentBefore, JSON.stringify(r.json?.mcp));

const purchaseId = `smoke-${Date.now()}`;
r = await call("tabularium_pay", { url: `${BASE}/read?key=${key}`, reason: "smoke: buy one read", max_usd: 0.005, purchase_id: purchaseId });
const bought = r.json;
check(
  "pay buys from an x402 endpoint and returns its response",
  !r.isError && bought?.paid === true && bought?.response?.status === 200 && JSON.parse(bought.response.body).value === "written through MCP",
  r.text.slice(0, 300),
);
check("pay records a settled transaction", /^0x[0-9a-fA-F]{64}$/.test(bought?.payment?.transaction ?? ""), JSON.stringify(bought?.payment));
check("pay writes a signed receipt to the ledger", /^ledger\/\d{4}-\d{2}-\d{2}\//.test(bought?.receipt?.key ?? "") && !!bought?.receipt?.head?.sig, JSON.stringify(bought?.receipt));

r = await call("tabularium_menu");
const spentAfterBuy = r.json?.mcp?.sessionSpentUsd;
r = await call("tabularium_pay", { url: `${BASE}/read?key=${key}`, reason: "smoke: buy one read", max_usd: 0.005, purchase_id: purchaseId });
const replay = r.json;
r = await call("tabularium_menu");
check(
  "the same purchase_id returns the first purchase and charges nothing",
  replay?.replayed === true && replay?.payment?.transaction === bought?.payment?.transaction && r.json?.mcp?.sessionSpentUsd === spentAfterBuy,
  JSON.stringify({ replay, spent: [spentAfterBuy, r.json?.mcp?.sessionSpentUsd] }).slice(0, 300),
);

r = await call("tabularium_pay", { url: `${BASE}/menu`, reason: "smoke: free endpoint" });
check("pay on a free endpoint charges nothing and writes no receipt", !r.isError && r.json?.paid === false && !r.json?.receipt, r.text.slice(0, 200));

r = await call("tabularium_read", { key: bought?.receipt?.key ?? "missing" });
const rec = r.json?.value ? JSON.parse(r.json.value) : null;
check(
  "receipt holds reason, amount, payee, tx and response hash",
  rec?.reason === "smoke: buy one read" && rec?.amount?.atomic === String(Math.round(readPrice * 1e6)) && rec?.payTo === liveMenu.payTo &&
    rec?.transaction === bought?.payment?.transaction && rec?.response?.sha256 === bought?.response?.sha256,
  JSON.stringify(rec),
);
const ic = await checkIntent(rec);
check(
  "receipt v2: accepted terms, purchase id, and an intent the payer signed over the nonce and the reason",
  rec?.v === 2 && rec?.accepted?.payTo === liveMenu.payTo && rec?.purchaseId === purchaseId && ic?.ok === true && rec?.intent?.message?.includes(`nonce: ${rec?.paymentNonce}`),
  JSON.stringify({ v: rec?.v, ic, accepted: rec?.accepted }).slice(0, 300),
);

r = await call("tabularium_ledger", { day_prefix: new Date().toISOString().slice(0, 7) });
const host = new URL(BASE).host;
check(
  "ledger verifies the export and totals the purchase",
  !r.isError && r.json?.verification?.ok === true && r.json?.byService?.[host]?.count >= 1 && r.json?.latest?.some((x) => x.key === bought?.receipt?.key),
  r.text.slice(0, 300),
);
check("ledger checks every payer-signed intent and finds none invalid", r.json?.intents?.valid >= 1 && r.json?.intents?.invalid?.length === 0, JSON.stringify(r.json?.intents));

r = await call("tabularium_reconcile", { days: 2 });
const net = r.json?.networks?.[liveMenu.x402.network];
check(
  "reconcile: every receipt matches an on-chain settlement, and no purchase outside Tabularium lacks a receipt",
  !r.isError && r.json?.exportVerified === true && net && net.unsettled.length === 0 && net.mismatched.length === 0 && net.unrecorded.length === 0 && net.serviceCalls.count > 0,
  r.text.slice(0, 600),
);

// Check the spend cap with a fresh server whose cap is below any price:
await client.close();
const capped = new Client({ name: "tabularium-smoke-cap", version: "0.0.0" });
await capped.connect(new StdioClientTransport({ ...transport._serverParams, env: { ...transport._serverParams.env, TABULARIUM_MAX_SPEND_USD: "0.0001" } }));
const c = await capped.callTool({ name: "tabularium_write", arguments: { key, value: "should not be sent" } });
check("spend cap blocks a call before paying", !!c.isError && /spend cap/.test(c.content?.[0]?.text ?? ""), c.content?.[0]?.text);
const cp = await capped.callTool({ name: "tabularium_pay", arguments: { url: `${BASE}/read?key=${key}`, reason: "should not be bought" } });
check("spend cap blocks a purchase (price + receipt) before signing", !!cp.isError && /spend cap/.test(cp.content?.[0]?.text ?? ""), cp.content?.[0]?.text);
const cm = JSON.parse((await capped.callTool({ name: "tabularium_menu", arguments: {} })).content[0].text);
check("the blocked purchase spent nothing", cm.mcp.sessionSpentUsd === 0, JSON.stringify(cm.mcp));
const cf = await capped.callTool({ name: "tabularium_pay", arguments: { url: `${BASE}/menu`, reason: "free fetch" } });
check("a free fetch still works under the cap", !cf.isError && JSON.parse(cf.content[0].text).paid === false, cf.content?.[0]?.text?.slice(0, 200));
await capped.close();

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
