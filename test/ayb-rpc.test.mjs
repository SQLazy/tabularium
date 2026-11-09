// The hourly count asks a free public node; these are the ways that node fails and what the collector does.
import { describe, expect, it } from "vitest";
import { node, tooWide } from "../scripts/ayb/rpc.mjs";

const reply = (body) => ({ json: async () => body });
const ok = (result) => reply({ jsonrpc: "2.0", id: 1, result });
const fail = (message) => reply({ jsonrpc: "2.0", id: 1, error: { code: -32000, message } });
const span = (call) => {
  const [{ fromBlock, toBlock }] = JSON.parse(call.body).params;
  return [Number(fromBlock), Number(toBlock)];
};
/** A node whose answer to each call is decided by `answer(call number, [from, to])`. */
function fake(answer) {
  const calls = [];
  const fetch = async (_url, init) => {
    calls.push(init);
    const a = answer(calls.length, init.body.includes("eth_getLogs") ? span(init) : null);
    if (a instanceof Error) throw a;
    return a;
  };
  const waits = [];
  return { calls, waits, opts: { fetch, wait: async (ms) => void waits.push(ms) } };
}

describe("tooWide", () => {
  it("knows a query that is too big from a node that is busy", () => {
    expect(tooWide("query exceeds max results 20000, retry with the range 55324573-55332965")).toBe(true);
    expect(tooWide("ranges over 10000 blocks are not supported on free plan")).toBe(true);
    expect(tooWide("eth_getLogs is limited to 0 - 50 blocks range")).toBe(true);
    expect(tooWide("request limit reached")).toBe(false);
    expect(tooWide("Too Many Requests")).toBe(false);
    expect(tooWide("broker: node error on base-fn-ash.allnodes.me")).toBe(false);
  });
});

describe("rpc", () => {
  it("asks again when the node behind the broker is broken (the failure of 9 Nov 2026)", async () => {
    const n = fake((i) => (i < 3 ? fail("broker: node error on base-fn-ash.allnodes.me") : ok("0x10")));
    expect(await node("http://node", n.opts).rpc("eth_blockNumber", [])).toBe("0x10");
    expect(n.calls).toHaveLength(3);
    expect(n.waits).toEqual([2000, 4000]);
  });

  it("asks again after a network error or a reply that is not JSON", async () => {
    const n = fake((i) => (i === 1 ? new Error("fetch failed") : i === 2 ? { json: async () => JSON.parse("<html>") } : ok("0x1")));
    expect(await node("http://node", n.opts).rpc("eth_blockNumber", [])).toBe("0x1");
    expect(n.calls).toHaveLength(3);
  });

  it("does not ask again for a query that is too wide", async () => {
    const n = fake(() => fail("query exceeds max results 20000"));
    await expect(node("http://node", n.opts).rpc("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x2" }])).rejects.toThrow("exceeds");
    expect(n.calls).toHaveLength(1);
  });

  it("gives up after the tries it was given", async () => {
    const n = fake(() => fail("broker: node error"));
    await expect(node("http://node", { ...n.opts, tries: 3 }).rpc("eth_blockNumber", [])).rejects.toThrow("broker");
    expect(n.calls).toHaveLength(3);
  });
});

describe("logs", () => {
  it("halves a range that is too wide and keeps the logs in order", async () => {
    const n = fake((_i, [from, to]) => (to - from + 1 > 4 ? fail("query exceeds max results") : ok([`${from}-${to}`])));
    expect(await node("http://node", n.opts).logs({}, 1, 16)).toEqual(["1-4", "5-8", "9-12", "13-16"]);
    expect(n.waits).toEqual([]);
  });

  it("halves a range the node keeps failing on, then gets it in pieces", async () => {
    const n = fake((_i, [from, to]) => (to - from + 1 > 5000 ? fail("broker: node error") : ok([`${from}-${to}`])));
    expect(await node("http://node", { ...n.opts, tries: 2 }).logs({}, 1, 10000)).toEqual(["1-5000", "5001-10000"]);
  });

  it("stops halving a failing range once it is small, and says why", async () => {
    const n = fake(() => fail("broker: node error"));
    await expect(node("http://node", { ...n.opts, tries: 2 }).logs({}, 1, 8000)).rejects.toThrow("broker");
    // 8000 -> 4000 -> 2000 blocks, two tries each, and nothing smaller
    expect(n.calls.map(span)).toEqual([[1, 8000], [1, 8000], [1, 4000], [1, 4000], [1, 2000], [1, 2000]]);
  });
});
