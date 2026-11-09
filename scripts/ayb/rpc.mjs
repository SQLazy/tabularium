// The collector's two calls to a Base node, written to ride out a public node's bad minutes.
// A free node fails in three different ways and each wants a different answer:
//   - "too wide" (too many results, range over the cap): the same call will never work; ask for half the range.
//   - "busy" (rate limit, a broken backend behind the provider's broker, a timeout, a 5xx): wait and ask again.
//   - still failing after the waits: ask for half the range anyway, since a smaller query often lands on a node
//     that can answer; give up only once the range is small.
// Until 9 Nov 2026 a node error was thrown at once and the hourly count failed about one run in six.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The node is telling us the query itself is too big, as opposed to asking us to slow down. */
export function tooWide(message) {
  const m = String(message ?? "");
  if (/rate limit|request limit|too many requests/i.test(m)) return false;
  return /exceed|too many|range|limit/i.test(m);
}

/**
 * @param {string} url
 * @param {{ tries?: number, wait?: (ms: number) => Promise<void>, fetch?: typeof fetch, log?: (line: string) => void }} [opts]
 */
export function node(url, { tries = 6, wait = sleep, fetch: f = fetch, log = () => {} } = {}) {
  async function rpc(method, params) {
    for (let i = 0; ; i++) {
      try {
        const r = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(60_000) });
        const j = await r.json();
        if (j.error) throw Object.assign(new Error(j.error.message ?? JSON.stringify(j.error)), { rpc: true });
        return j.result;
      } catch (err) {
        if ((err.rpc && tooWide(err.message)) || i >= tries - 1) throw err;
        log(`${method}: ${err.message}; asking again (${i + 2} of ${tries})`);
        await wait(Math.min(2000 * 2 ** i, 30_000));
      }
    }
  }

  /** eth_getLogs over [from, to], halving the range when the node says it is too wide, or keeps failing on it. */
  async function logs(filter, from, to, minSpan = 2000) {
    try {
      return await rpc("eth_getLogs", [{ ...filter, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }]);
    } catch (err) {
      const wide = err.rpc && tooWide(err.message);
      if (from >= to || (!wide && to - from + 1 <= minSpan)) throw err;
      if (!wide) log(`eth_getLogs ${from}-${to}: ${err.message}; halving the range`);
      const mid = Math.floor((from + to) / 2);
      const left = await logs(filter, from, mid, minSpan);
      const right = await logs(filter, mid + 1, to, minSpan);
      return left.concat(right);
    }
  }

  return { rpc, logs };
}
