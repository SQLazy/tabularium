// Offline: reconciling receipts against on-chain settlements, and reading those settlements from logs.
//   node --test
import assert from "node:assert/strict";
import { test } from "node:test";
import { pad, toHex } from "viem";
import { TOPIC, USDC, reconcile, settlementsOnChain, stableStringify } from "./ledger.mjs";

const SERVICE = "0x951bd91ad61d2d867f21b54d2f717d8fff4ad28a";
const SELLER = "0x1111111111111111111111111111111111111111";
const n = (i) => "0x" + String(i).padStart(64, "0");
const settlement = (i, payTo, atomic) => ({ nonce: n(i), transaction: "0x" + String(i).padStart(64, "a"), block: 100 + i, payTo, atomic: String(atomic) });
const receipt = (i, payTo, atomic, extra = {}) => ({ key: `ledger/x/${i}`, paymentNonce: n(i), payTo, amount: { atomic: String(atomic), usd: atomic / 1e6 }, transaction: "0x" + String(i).padStart(64, "a"), ...extra });

test("stableStringify ignores key order", () => {
  assert.equal(stableStringify({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } }), stableStringify({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
});

test("a complete ledger reconciles; Tabularium's own calls are counted, not flagged", () => {
  const r = reconcile({
    receipts: [receipt(1, SELLER, 1000), receipt(2, SELLER, 5000)],
    settlements: [settlement(1, SELLER, 1000), settlement(2, SELLER, 5000), settlement(3, SERVICE, 3000), settlement(4, SERVICE, 2000)],
    servicePayTo: SERVICE,
  });
  assert.equal(r.ok, true);
  assert.equal(r.matched.length, 2);
  assert.deepEqual(r.serviceCalls, { count: 2, usd: 0.005 });
});

test("a settled purchase without a receipt is unrecorded", () => {
  const r = reconcile({ receipts: [receipt(1, SELLER, 1000)], settlements: [settlement(1, SELLER, 1000), settlement(9, SELLER, 7000)], servicePayTo: SERVICE });
  assert.equal(r.ok, false);
  assert.deepEqual(r.unrecorded.map((x) => [x.nonce, x.usd]), [[n(9), 0.007]]);
});

test("a receipt with no settlement is unsettled, and one that differs from the chain is mismatched", () => {
  const r = reconcile({
    receipts: [receipt(1, SELLER, 1000), receipt(2, SELLER, 9999), receipt(3, SELLER, 1000, { transaction: "0x" + "f".repeat(64) })],
    settlements: [settlement(2, SELLER, 5000), settlement(3, SELLER, 1000)],
    servicePayTo: SERVICE,
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.unsettled.map((x) => x.nonce), [n(1)]);
  assert.deepEqual(r.mismatched.map((x) => [x.nonce, x.differs]), [[n(2), ["amount"]], [n(3), ["transaction"]]]);
});

test("settlementsOnChain pages 50,000 blocks at a time and joins each authorization with its transfer", async () => {
  const payer = "0x9511e21a4D5D8ba7Cc85cfFB65Df3fD682b90D92";
  const head = 1_000_000;
  const ranges = [];
  const fetchImpl = async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    const reply = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    if (method === "eth_blockNumber") return reply(toHex(head));
    const f = params[0];
    assert.equal(f.address, USDC["eip155:8453"]);
    assert.equal(f.topics[1], pad(payer.toLowerCase()));
    ranges.push([Number(f.fromBlock), Number(f.toBlock), f.topics[0] === TOPIC.authorizationUsed ? "auth" : "transfer"]);
    if (Number(f.fromBlock) <= 960_000 && 960_000 <= Number(f.toBlock)) {
      const tx = "0x" + "c".repeat(64);
      if (f.topics[0] === TOPIC.authorizationUsed) return reply([{ topics: [TOPIC.authorizationUsed, f.topics[1], n(5)], transactionHash: tx, blockNumber: toHex(960_000), logIndex: "0x1" }]);
      return reply([{ topics: [TOPIC.transfer, f.topics[1], pad(SELLER)], data: toHex(2500, { size: 32 }), transactionHash: tx, blockNumber: toHex(960_000), logIndex: "0x2" }]);
    }
    return reply([]);
  };
  const out = await settlementsOnChain({ rpcUrl: "http://rpc", network: "eip155:8453", payer, days: 2, fetchImpl });
  assert.equal(out.toBlock, head);
  assert.equal(out.fromBlock, head - 86_400);
  for (const [from, to] of ranges) assert.ok(to - from + 1 <= 50_000, `range ${from}-${to} too wide`);
  assert.equal(ranges.filter((r) => r[2] === "auth").length, 2);
  assert.deepEqual(out.settlements, [{ nonce: n(5), transaction: "0x" + "c".repeat(64), block: 960_000, payTo: SELLER, atomic: "2500" }]);
});
