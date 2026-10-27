// Offline: the payer must refuse bad 402s before signing anything, and pay good ones exactly once.
//   node --test
import assert from "node:assert/strict";
import { test } from "node:test";
import { generatePrivateKey } from "viem/accounts";
import { createPayer } from "./x402.mjs";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAY_TO = "0x951BD91AD61d2D867F21b54D2f717D8FFF4aD28a";
const good = { scheme: "exact", network: "eip155:84532", asset: USDC, payTo: PAY_TO, amount: "1000", maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } };
const b64 = (o) => btoa(JSON.stringify(o));

function fakeFetch(accepts, { x402Version = 2 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push(init.headers?.["PAYMENT-SIGNATURE"] ?? null);
    if (calls.length === 1) {
      const required = { x402Version, resource: { url }, accepts };
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64(required) } });
    }
    return new Response("{}", { status: 200 });
  };
  return calls;
}
const payer = () => createPayer(generatePrivateKey(), { network: "eip155:84532", payTo: PAY_TO, maxAtomic: 50_000n });

test("pays a valid requirement once, with a decodable v2 header", async () => {
  const calls = fakeFetch([good]);
  const p = payer();
  const res = await p.payFetch("https://svc/write", {}, { maxAtomic: 1000n });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
  const h = JSON.parse(atob(calls[1]));
  assert.equal(h.x402Version, 2);
  assert.deepEqual(h.accepted, good);
  assert.equal(h.payload.authorization.from, p.address);
  assert.equal(h.payload.authorization.to, PAY_TO);
  assert.equal(h.payload.authorization.value, "1000");
  assert.match(h.payload.signature, /^0x[0-9a-f]{130}$/);
});

test("accepts the legacy network name for configuration", () => {
  assert.doesNotThrow(() => createPayer(generatePrivateKey(), { network: "base-sepolia", payTo: PAY_TO, maxAtomic: 1n }));
});

const refusals = {
  "a non-USDC asset": { ...good, asset: "0x0000000000000000000000000000000000000001" },
  "a different payee than the menu": { ...good, payTo: "0x0000000000000000000000000000000000000002" },
  "more than the call's menu price": { ...good, amount: "1001" },
  "another network": { ...good, network: "eip155:8453" },
  "another scheme": { ...good, scheme: "upto" },
  "a Permit2 transfer": { ...good, extra: { ...good.extra, assetTransferMethod: "permit2" } },
};
for (const [what, req] of Object.entries(refusals)) {
  test(`refuses ${what}, and sends no payment`, async () => {
    const calls = fakeFetch([req]);
    await assert.rejects(payer().payFetch("https://svc/write", {}, { maxAtomic: 1000n }));
    assert.equal(calls.length, 1, "no second (paid) request");
  });
}

test("refuses an x402 v1 402, and sends no payment", async () => {
  const calls = fakeFetch([good], { x402Version: 1 });
  await assert.rejects(payer().payFetch("https://svc/write", {}, { maxAtomic: 1000n }));
  assert.equal(calls.length, 1);
});

test("per-call cap cannot raise the global cap", async () => {
  const calls = fakeFetch([{ ...good, amount: "60000" }]);
  await assert.rejects(payer().payFetch("https://svc/write", {}, { maxAtomic: 10n ** 9n }));
  assert.equal(calls.length, 1);
});

// ---- paying a third-party service (tabularium_pay) ----
const OTHER = "0x00000000000000000000000000000000000000Aa";

test("third party: pays whoever the service names when payTo is null, and reports the payment", async () => {
  const calls = fakeFetch([{ ...good, payTo: OTHER }]);
  const { res, payment } = await payer().payOnce("https://other/api", {}, { networks: ["eip155:84532"], payTo: null, maxAtomic: 5000n });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
  const h = JSON.parse(atob(calls[1]));
  assert.equal(h.payload.authorization.to.toLowerCase(), OTHER.toLowerCase());
  assert.equal(payment.nonce, h.payload.authorization.nonce, "reported nonce is the one signed");
  assert.equal(payment.requirement.payTo, OTHER);
});

test("third party: refuses a network outside the allow-list, and sends no payment", async () => {
  const calls = fakeFetch([{ ...good, network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }]);
  await assert.rejects(payer().payOnce("https://other/api", {}, { networks: ["eip155:84532"], payTo: null, maxAtomic: 5000n }));
  assert.equal(calls.length, 1);
});

test("third party: refuses a price above the purchase cap, and sends no payment", async () => {
  const calls = fakeFetch([{ ...good, payTo: OTHER, amount: "5001" }]);
  await assert.rejects(payer().payOnce("https://other/api", {}, { networks: ["eip155:84532"], payTo: null, maxAtomic: 5000n }));
  assert.equal(calls.length, 1);
});

test("a free endpoint is fetched once and reports no payment", async () => {
  globalThis.fetch = async () => new Response("{}", { status: 200 });
  const { res, payment } = await payer().payOnce("https://other/free", {}, { networks: ["eip155:84532"], payTo: null, maxAtomic: 1n });
  assert.equal(res.status, 200);
  assert.equal(payment, null);
});

test("beforeSign sees the real requirement and can abort before anything is signed", async () => {
  const calls = fakeFetch([{ ...good, payTo: OTHER }]);
  let seen = null;
  await assert.rejects(
    payer().payOnce("https://other/api", {}, { networks: ["eip155:84532"], payTo: null, maxAtomic: 5000n, beforeSign: (r) => { seen = r; throw new Error("cap"); } }),
    /cap/,
  );
  assert.equal(seen.amount, "1000");
  assert.equal(calls.length, 1, "aborted before the paid request");
});

// ---- security review: redirects and authorization window ----
test("never follows redirects, and a 3xx is returned unpaid", async () => {
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push(init.redirect);
    return new Response(null, { status: 302, headers: { location: "https://elsewhere/pay" } });
  };
  const { res, payment } = await payer().payOnce("https://other/api", {}, { networks: ["eip155:84532"], payTo: null, maxAtomic: 5000n });
  assert.equal(res.status, 302);
  assert.equal(payment, null);
  assert.deepEqual(seen, ["manual"]);
});

test("the paid retry does not follow redirects either", async () => {
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push(init.redirect);
    if (seen.length === 1) return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64({ x402Version: 2, resource: { url }, accepts: [good] }) } });
    return new Response("{}", { status: 200 });
  };
  await payer().payOnce("https://svc/write", {}, { maxAtomic: 1000n });
  assert.deepEqual(seen, ["manual", "manual"]);
});

test("a seller asking for a long authorization window gets at most 10 minutes", async () => {
  const calls = fakeFetch([{ ...good, maxTimeoutSeconds: 30 * 86400 }]);
  const before = Math.floor(Date.now() / 1000);
  await payer().payFetch("https://svc/write", {}, { maxAtomic: 1000n });
  const validBefore = Number(JSON.parse(atob(calls[1])).payload.authorization.validBefore);
  assert.ok(validBefore <= before + 600 + 2, `validBefore ${validBefore - before}s ahead`);
});

test("beforeSign gets the nonce the authorization uses, and onSigned gets the header before it is sent", async () => {
  const calls = fakeFetch([good]);
  const p = payer();
  const seen = {};
  await p.payOnce("https://svc/write", {}, {
    maxAtomic: 1000n,
    beforeSign: (req, nonce) => void (seen.before = { amount: req.amount, nonce, sent: calls.length }),
    onSigned: (header, req, nonce) => void (seen.signed = { header, nonce, sent: calls.length }),
  });
  const h = JSON.parse(atob(calls[1]));
  assert.equal(seen.before.nonce, h.payload.authorization.nonce);
  assert.equal(seen.signed.nonce, h.payload.authorization.nonce);
  assert.equal(seen.signed.header, calls[1]);
  assert.equal(seen.before.sent, 1); // only the unpaid probe had gone out
  assert.equal(seen.signed.sent, 1); // the paid request had not been sent yet
});

test("signMessage is EIP-191 from the paying wallet", async () => {
  const { verifyMessage } = await import("viem");
  const p = payer();
  const signature = await p.signMessage("tabularium/intent/v1\nhello");
  assert.equal(await verifyMessage({ address: p.address, message: "tabularium/intent/v1\nhello", signature }), true);
});
