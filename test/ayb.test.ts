// /allyourbase: the wallet card's arithmetic (the same code the browser runs) and the page's safety with hostile
// seller names (names come from the Bazaar, which anyone can write to).
import { afterEach, describe, expect, it, vi } from "vitest";
import { AYB_CLIENT } from "../src/pages/ayb-client";
import { createApp } from "../src/app";

type Log = { transactionHash: string; topics: string[]; data?: string; blockNumber?: string };
const client = new Function(`${AYB_CLIENT}; return { x402Payments, summarize, personality };`)() as {
  x402Payments: (a: Log[], t: Log[], head: number, ts: number) => { to: string; usd: number; ts: number }[];
  summarize: (p: { to: string; usd: number; ts: number }[], names: Record<string, string>) => any;
  personality: (n: number, usd: number, top: { n: number }[], biggest: { usd: number } | null) => { title: string };
};
const addr = (n: number) => "0x" + String(n).padStart(40, "0");
const topic = (a: string) => "0x" + a.slice(2).padStart(64, "0");
const transfer = (tx: string, to: string, atomic: number, block: number): Log => ({
  transactionHash: tx,
  topics: ["0xddf2", topic(addr(1)), topic(to)],
  data: "0x" + atomic.toString(16),
  blockNumber: "0x" + block.toString(16),
});

describe("wallet card", () => {
  it("counts only transfers made with an EIP-3009 authorization (x402), and dates them by block", () => {
    const auth = [{ transactionHash: "0xa", topics: [] }, { transactionHash: "0xb", topics: [] }];
    const t = [transfer("0xa", addr(7), 3000, 990), transfer("0xb", addr(8), 250000, 1000), transfer("0xc", addr(9), 5_000_000, 1000)];
    const p = client.x402Payments(auth, t, 1000, 1_800_000_000_000);
    expect(p.map((x) => [x.to, x.usd])).toEqual([[addr(7), 0.003], [addr(8), 0.25]]);
    expect(p[0].ts).toBe(1_800_000_000_000 - 20_000);
  });

  it("summarises totals, favourite, biggest and uses Bazaar names", () => {
    const p = [
      { to: addr(7), usd: 0.003, ts: Date.UTC(2026, 9, 27) },
      { to: addr(7), usd: 0.003, ts: Date.UTC(2026, 9, 27) },
      { to: addr(8), usd: 0.25, ts: Date.UTC(2026, 9, 26) },
    ];
    const s = client.summarize(p, { [addr(7)]: "Tabularium" });
    expect(s).toMatchObject({ n: 3, sellers: 2, top: [{ seller: "Tabularium", n: 2 }, { n: 1 }], biggest: { usd: 0.25 }, busiestDay: "Tuesday" });
    expect(s.usd).toBeCloseTo(0.256, 9);
  });

  it.each([
    [0, 0, [], null, "THE PACIFIST"],
    [3, 2, [{ n: 3 }], { usd: 1.5 }, "THE BIG SPENDER"],
    [150, 0.5, [{ n: 80 }, { n: 70 }], { usd: 0.01 }, "THE SPEEDRUNNER"],
    [10, 0.05, [{ n: 8 }, { n: 2 }], { usd: 0.01 }, "THE LOYAL CUSTOMER"],
    [10, 0.05, [{ n: 10 }], { usd: 0.01 }, "THE MONOGAMIST"],
    [10, 0.02, [{ n: 4 }, { n: 3 }, { n: 3 }], { usd: 0.003 }, "THE PENNY PINCHER"],
  ])("%s purchases -> %s", (n, usd, top, biggest, title) => {
    expect(client.personality(n as number, usd as number, top as { n: number }[], biggest as { usd: number } | null).title).toBe(title);
  });
});

describe("the page", () => {
  afterEach(() => vi.unstubAllGlobals());
  const evil = "</script><img src=x onerror=alert(1)>";
  const ticker = { asOf: "2026-10-28T00:00:00Z", usd: 1234.5, payments: 99, payers: 7, activeSellers: 3, listedSellers: 1500, top: [{ seller: evil, usd: 10, payments: 2 }], perHourUsd: new Array(24).fill(1), biggest: { usd: 5, seller: evil }, definition: "test" };

  it("renders the live number, and a hostile seller name can neither end the script nor add HTML", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(ticker), { status: 200 }));
    const res = await createApp({ paywall: false }).request("http://localhost/allyourbase");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("$1,234.50");
    expect(html).toContain('content="Machines paid $1,234.50 on Base in the last 24 hours over x402. How much did your agent spend?"');
    expect(html).not.toContain(evil);
    expect(html).not.toContain("<img src=x");
    expect(html.split("</script>").length).toBe(2); // exactly one script, closed once
  });

  it("still renders, saying it is counting, when the data is not there yet", async () => {
    vi.stubGlobal("fetch", async () => new Response("404", { status: 404 }));
    const app = createApp({ paywall: false });
    const page = await app.request("http://localhost/allyourbase");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("COUNTING...");
    const data = await app.request("http://localhost/ayb/ticker.json");
    expect(data.status).toBe(503);
  });
});
