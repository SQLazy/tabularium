// Offline: tabularium_pay's ledger guarantees, against a fake Tabularium, fake sellers and a fake chain on localhost.
//   node --test
// - the receipt carries the full accepted terms and a payer-signed intent over them and the payment nonce
// - purchase_id: the same id never pays twice; an unconfirmed purchase is retried with the SAME authorization
// - a payment that settled while its response was lost is recorded once, not reported as a failure
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { checkIntent, sha256, stableStringify } from "./ledger.mjs";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const SERVICE = "0x951BD91AD61d2D867F21b54D2f717D8FFF4aD28a";
const SELLER = "0x1111111111111111111111111111111111111111";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const decode = (h) => JSON.parse(Buffer.from(h, "base64").toString());
const KEY = generatePrivateKey();
const PAYER = privateKeyToAccount(KEY).address;

const used = new Set(); // the fake chain: authorization nonces that have settled
const seen = []; // every request the fake servers received
const receipts = []; // receipt values written to the fake Tabularium
let flakyFailures = 0;
let base;

const requirement = (path, payTo, amount) => ({ scheme: "exact", network: "eip155:84532", asset: USDC, payTo, amount, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" }, resource: undefined, path });
const http = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    const sig = req.headers["payment-signature"];
    const auth = sig ? decode(sig).payload.authorization : null;
    seen.push({ path: url.pathname, nonce: auth?.nonce ?? null });
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    const ask = (payTo, amount) => {
      const { path: _p, resource: _r, ...accept } = requirement(url.pathname, payTo, amount);
      return json(402, {}, { "PAYMENT-REQUIRED": b64({ x402Version: 2, resource: { url: base + url.pathname, description: "fake item" }, accepts: [accept] }) });
    };
    const settle = (body) => {
      used.add(auth.nonce.toLowerCase());
      return json(200, body, { "PAYMENT-RESPONSE": b64({ success: true, transaction: "0x" + "ab".repeat(32) }) });
    };
    if (url.pathname === "/rpc") {
      const call = JSON.parse(raw);
      if (call.method === "eth_call") {
        const nonce = "0x" + call.params[0].data.slice(-64);
        return json(200, { jsonrpc: "2.0", id: 1, result: "0x" + (used.has(nonce.toLowerCase()) ? "1" : "0").padStart(64, "0") });
      }
      return json(200, { jsonrpc: "2.0", id: 1, error: { message: "unsupported" } });
    }
    if (url.pathname === "/menu") {
      return json(200, { name: "tabularium", network: "base-sepolia", payTo: SERVICE, x402: { version: 2, network: "eip155:84532" }, calls: [{ call: "POST /write", price: "$0.003" }], signing: { publicKeyHex: "00".repeat(32) }, services: [] });
    }
    if (url.pathname === "/write") {
      if (!sig) return ask(SERVICE, "3000");
      receipts.push(JSON.parse(JSON.parse(raw).value));
      return settle({ ok: true, entry: { seq: receipts.length }, head: { seq: receipts.length, hash: "h", sig: "s" } });
    }
    if (url.pathname === "/seller/item") return sig ? settle({ item: "the goods" }) : ask(SELLER, "1000");
    if (url.pathname === "/seller/lost") {
      // Settles, then the response is lost (the caller sees a 502). The same authorization again is refused.
      if (!sig) return ask(SELLER, "1000");
      if (used.has(auth.nonce.toLowerCase())) return json(402, { error: "authorization already used" });
      used.add(auth.nonce.toLowerCase());
      return json(502, { error: "gateway timeout" });
    }
    if (url.pathname === "/seller/flaky") {
      // The first paid attempt fails without settling; a later one settles.
      if (!sig) return ask(SELLER, "1000");
      if (flakyFailures++ === 0) return json(503, { error: "try again" });
      return settle({ item: "eventually" });
    }
    json(404, { error: "not_found" });
  });
});

let client;
let stateDir;
before(async () => {
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${http.address().port}`;
  stateDir = mkdtempSync(join(tmpdir(), "tabularium-pay-test-"));
  client = new Client({ name: "pay-test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [new URL("./server.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")],
      env: { ...process.env, TABULARIUM_URL: base, TABULARIUM_PRIVATE_KEY: KEY, TABULARIUM_RPC_URL: `${base}/rpc`, TABULARIUM_STATE_DIR: stateDir, TABULARIUM_MAX_SPEND_USD: "1" },
    }),
  );
});
after(async () => {
  await client?.close();
  http.close();
  rmSync(stateDir, { recursive: true, force: true });
});
const pay = async (args) => {
  const r = await client.callTool({ name: "tabularium_pay", arguments: args });
  return { isError: !!r.isError, json: r.structuredContent, text: r.content?.[0]?.text ?? "" };
};
const paidTo = (path) => seen.filter((s) => s.path === path && s.nonce);

test("the receipt carries the accepted terms and a payer-signed intent over them and the payment nonce", async () => {
  const r = await pay({ url: `${base}/seller/item`, reason: "need the goods\nfor task 7", purchase_id: "p1" });
  assert.equal(r.isError, false, r.text);
  const rec = receipts.at(-1);
  const nonce = paidTo("/seller/item")[0].nonce;
  assert.equal(rec.v, 2);
  assert.equal(rec.paymentNonce, nonce);
  assert.equal(rec.accepted.payTo, SELLER);
  assert.equal(rec.acceptedSha256, sha256(stableStringify(rec.accepted)));
  assert.match(rec.reasonStatus, /^claimed/);
  assert.equal(rec.purchaseId, "p1");
  assert.match(rec.intent.message, new RegExp(`\\nnonce: ${nonce}\\n`));
  assert.match(rec.intent.message, /\nreason: need the goods\nfor task 7$/);
  assert.deepEqual(await checkIntent(rec), { ok: true, problems: [] });
  assert.equal(rec.payer, PAYER);
});

test("an edited receipt no longer matches its intent", async () => {
  const rec = receipts.at(-1);
  assert.equal((await checkIntent({ ...rec, reason: "something nicer" })).ok, false);
  assert.equal((await checkIntent({ ...rec, amount: { ...rec.amount, atomic: "999" } })).ok, false);
  assert.equal((await checkIntent({ ...rec, payTo: SERVICE })).ok, false);
  assert.equal((await checkIntent({ ...rec, accepted: { ...rec.accepted, amount: "1" } })).ok, false);
});

test("the same purchase_id never pays twice", async () => {
  const before = seen.length;
  const r = await pay({ url: `${base}/seller/item`, reason: "need the goods\nfor task 7", purchase_id: "p1" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.replayed, true);
  assert.equal(seen.length, before, "no request at all was sent");
});

test("a purchase_id reused for a different request is refused before anything is sent", async () => {
  const before = seen.length;
  const r = await pay({ url: `${base}/seller/flaky`, reason: "x", purchase_id: "p1" });
  assert.equal(r.isError, true);
  assert.match(r.text, /different request/);
  assert.equal(seen.length, before);
});

test("a payment that settled while its response was lost is recorded once, not reported as failed", async () => {
  const n = receipts.length;
  const r = await pay({ url: `${base}/seller/lost`, reason: "lost response", purchase_id: "p2" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.payment.settledEarlier, true);
  assert.equal(receipts.length, n + 1);
  assert.equal(receipts.at(-1).response.lost, true);
  assert.equal(paidTo("/seller/lost").length, 1, "one authorization, sent once");
  const again = await pay({ url: `${base}/seller/lost`, reason: "lost response", purchase_id: "p2" });
  assert.equal(again.json.replayed, true);
  assert.equal(receipts.length, n + 1, "recorded once");
});

test("an unconfirmed purchase is retried with the same authorization, which settles once", async () => {
  const first = await pay({ url: `${base}/seller/flaky`, reason: "flaky seller", purchase_id: "p3" });
  assert.equal(first.isError, true);
  assert.match(first.text, /unused/);
  const second = await pay({ url: `${base}/seller/flaky`, reason: "flaky seller", purchase_id: "p3" });
  assert.equal(second.isError, false, second.text);
  const nonces = paidTo("/seller/flaky").map((s) => s.nonce);
  assert.equal(nonces.length, 2);
  assert.equal(nonces[0], nonces[1], "the retry resent the same signed authorization");
  assert.equal(receipts.at(-1).paymentNonce, nonces[0]);
});
