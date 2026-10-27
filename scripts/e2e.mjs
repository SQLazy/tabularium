// End-to-end test against a locally running worker (no-paywall dev build).
//   npx wrangler dev -c wrangler.dev.jsonc --port 8787   (in another shell)
//   node scripts/e2e.mjs [baseUrl]
import { readFileSync } from "node:fs";
import { verifyExport } from "../verifier/verify.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
const pub = readFileSync(".dev.vars", "utf8").match(/SIGNING_PUBKEY_HEX=(\w+)/)[1];
// Fresh wallets every run: local dev persists Durable Object state, and a workspace is keyed by wallet.
const rand = () => "0x" + Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, "0")).join("");
const A = rand();
const B = rand();

// Same header shape x402 clients send; the paywall build verifies the signature, this build trusts it.
const pay = (wallet) => ({ "PAYMENT-SIGNATURE": btoa(JSON.stringify({ x402Version: 2, payload: { authorization: { from: wallet } } })) });
const call = async (method, path, wallet, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(wallet ? pay(wallet) : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
  if (!cond) failed++;
};

// --- menu & identity
let r = await call("GET", "/menu");
check("menu is free and publishes the signing key", r.status === 200 && r.json.signing.publicKeyHex === pub);
check("menu lists exactly four paid calls", r.json.calls.length === 4);

r = await call("POST", "/write", null, { key: "a", value: "x" });
check("no payer header -> 400", r.status === 400 && r.json.error === "evm_payer_required");

// Identity comes only from PAYMENT-SIGNATURE, the header the v2 paywall verifies.
const raw = async (headers) =>
  (await fetch(BASE + "/write", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ key: "a", value: "x" }) })).status;
const v1Header = btoa(JSON.stringify({ x402Version: 1, payload: { authorization: { from: rand() } } }));
check("legacy X-PAYMENT alone is not an identity -> 400", (await raw({ "X-PAYMENT": v1Header })) === 400);
check("a v1 payload in PAYMENT-SIGNATURE is not an identity -> 400", (await raw({ "PAYMENT-SIGNATURE": v1Header })) === 400);

// --- basic round trip
r = await call("POST", "/write", A, { key: "plan", value: "step 1" });
check("first write creates workspace, seq 1", r.status === 200 && r.json.entry.seq === 1);
const term = r.json.expiresAt - Date.now();
check("term is ~30 days", Math.abs(term - 30 * 86400e3) < 60e3, String(term));

r = await call("POST", "/write", A, { key: "plan", value: "step 2" });
check("overwrite appends, does not rewrite history", r.json.entry.seq === 2);

r = await call("GET", "/read?key=plan", A);
check("read returns latest value + its chain entry", r.status === 200 && r.json.value === "step 2" && r.json.entry.seq === 2);

// --- validation never reaches storage (and in prod, is never charged: status >= 400)
r = await call("POST", "/write", A, { key: "bad key\nwith newline", value: "x" });
check("newline in key rejected (chain preimage safety)", r.status === 400);
r = await call("POST", "/write", A, { key: "big", value: "x".repeat(64 * 1024 + 1) });
check("oversize value -> 413", r.status === 413);
r = await call("POST", "/write", A, { key: "k", value: 123 });
check("non-string value -> 400", r.status === 400);
r = await call("GET", "/read?key=nope", A);
check("missing key -> 404", r.status === 404);

// --- isolation: wallet is the account
r = await call("GET", "/read?key=plan", B);
check("another wallet cannot read my key", r.status === 404);
r = await call("GET", "/export", B);
check("another wallet has no workspace to export", r.status === 404);

// --- concurrency: the fork-the-chain bug
const N = 25;
const results = await Promise.all(Array.from({ length: N }, (_, i) => call("POST", "/write", B, { key: `c${i}`, value: `v${i}` })));
const seqs = results.map((x) => x.json?.entry?.seq).sort((a, b) => a - b);
check(`${N} concurrent writes all succeed`, results.every((x) => x.status === 200));
check("seqs are exactly 1..N with no duplicates", seqs.every((s, i) => s === i + 1), JSON.stringify(seqs));
let exp = await call("GET", "/export", B);
let v = await verifyExport(exp.json, pub);
check("concurrent history verifies (chain + values + signature)", v.ok && v.entries === N, v.errors.join("; "));

// --- idempotency: retries must not double-write
const I = rand();
const idemId = "retry-1";
const dup = await Promise.all(Array.from({ length: 6 }, () => call("POST", "/write", I, { key: "job", value: "once", idempotency_key: idemId })));
check("6 concurrent identical idempotent writes all succeed", dup.every((x) => x.status === 200));
check("they all return the same entry (one seq)", new Set(dup.map((x) => x.json.entry.seq)).size === 1 && dup[0].json.entry.seq === 1, JSON.stringify(dup.map((x) => x.json?.entry?.seq)));
check("exactly one is a first write, the rest are marked replayed", dup.filter((x) => !x.json.replayed).length === 1);
r = await call("POST", "/write", I, { key: "job", value: "DIFFERENT", idempotency_key: idemId });
check("same id, different body -> 409 idempotency_key_reuse", r.status === 409 && r.json.error === "idempotency_key_reuse");
r = await call("POST", "/write", I, { key: "job", value: "once", idempotency_key: "bad id with spaces" });
check("malformed idempotency_key -> 400", r.status === 400);
r = await call("POST", "/write", I, { key: "job2", value: "x" });
check("write without an id still appends normally", r.status === 200 && r.json.entry.seq === 2 && !r.json.replayed);
exp = await call("GET", "/export", I);
check("history has exactly 2 entries, and verifies", (await verifyExport(exp.json, pub)).ok && exp.json.entries.length === 2, String(exp.json.entries?.length));

// --- renew
const before = (await call("GET", "/export", A)).json.expiresAt;
r = await call("POST", "/renew", A);
check("renew appends a signed entry", r.status === 200 && r.json.entry.op === "renew");
check("renew extends by ~30d from current expiry", Math.abs(r.json.expiresAt - (before + 30 * 86400e3)) < 5e3);
r = await call("POST", "/renew", rand());
check("renew on nonexistent workspace -> 404 (uncharged)", r.status === 404);

// --- export verifies; tampering is caught
exp = await call("GET", "/export", A);
v = await verifyExport(exp.json, pub);
check("full export verifies offline", v.ok, v.errors.join("; "));
const forged = structuredClone(exp.json);
forged.values.plan.value = "step 999";
check("forged value is detected", !(await verifyExport(forged, pub)).ok);
const dropped = structuredClone(exp.json);
dropped.entries.splice(1, 1);
check("dropped history entry is detected", !(await verifyExport(dropped, pub)).ok);

// --- incremental export
const inc = await call("GET", "/export?since=2", A);
check("incremental export verifies from its anchor", (await verifyExport(inc.json, pub)).ok && inc.json.entries[0].seq === 3);

// --- public head
r = await call("GET", `/head?wallet=${A}`);
check("public head matches export head", r.status === 200 && r.json.hash === exp.json.head.hash && r.json.seq === exp.json.head.seq);
check("public head reveals no values", !("value" in r.json) && !("values" in r.json));

// --- one signed payment buys one call (security review, finding 1)
const nonce = () => "0x" + Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
const payN = (wallet, n) => ({ "PAYMENT-SIGNATURE": btoa(JSON.stringify({ x402Version: 2, payload: { authorization: { from: wallet, nonce: n } } })) });
const withPay = (path, wallet, n, body) =>
  fetch(BASE + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...payN(wallet, n) }, body: body && JSON.stringify(body) });
const G = rand();
const n1 = nonce();
r = { status: (await withPay("/write", G, n1, { key: "a", value: "1" })).status };
check("first use of a payment succeeds", r.status === 200);
const again = await withPay("/write", G, n1, { key: "b", value: "2" });
check("the same payment again is refused (409 payment_reused, never settled)", again.status === 409 && (await again.json()).error === "payment_reused");
const n2 = nonce();
const burst = await Promise.all(Array.from({ length: 8 }, (_, i) => withPay("/write", G, n2, { key: `burst${i}`, value: "x" }).then((res) => res.status)));
check("8 concurrent calls on one payment: exactly one is served", burst.filter((s) => s === 200).length === 1 && burst.filter((s) => s === 409).length === 7, JSON.stringify(burst));
const n3 = nonce();
const readTwice = [(await withPay("/read?key=a", G, n3)).status, (await withPay("/read?key=a", G, n3)).status];
check("reads are one call per payment too", readTwice[0] === 200 && readTwice[1] === 409, JSON.stringify(readTwice));

// --- the no-paywall build serves localhost only (finding 4)
const viaOtherHost = await fetch(BASE.replace("127.0.0.1", "localhost") + "/menu");
check("dev build answers on localhost", viaOtherHost.status === 200);

// --- success metric (/stats): 14-day return, using X-Test-Now to record calls on past days
const DAY = 86_400_000;
const NOW = Date.now();
const at = async (wallet, ts) => {
  const res = await fetch(BASE + "/write", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Test-Now": String(ts), ...pay(wallet) },
    body: JSON.stringify({ key: "m", value: "x" }),
  });
  return res.status;
};
const stats = async () => await (await fetch(`${BASE}/stats?now=${NOW}`)).json();
const settle = () => new Promise((res) => setTimeout(res, 300)); // recording runs after the response (waitUntil)
const s0 = await stats();
const [C, D, E, F] = [rand(), rand(), rand(), rand()];
await at(C, NOW - 20 * DAY);
await at(C, NOW - 15 * DAY); // came back on day 5: returned
await at(D, NOW - 20 * DAY); // never came back
await at(E, NOW - 20 * DAY);
await at(E, NOW - 2 * DAY); // came back on day 18: too late
await at(F, NOW); // too new for the cohort
await at("0x00000000000000000000000000000000000000e1", NOW); // excluded test wallet
await settle();
const s1 = await stats();
const d = (k) => s1[k] - s0[k];
check("stats count new paying wallets, not excluded ones", d("wallets") === 4, JSON.stringify({ before: s0.wallets, after: s1.wallets }));
check("excluded test wallet is counted only as test traffic", d("excludedTestCalls") === 1, String(d("excludedTestCalls")));
check("14-day cohort holds only wallets first seen 14+ days ago", s1.return14d.cohort - s0.return14d.cohort === 3, JSON.stringify(s1.return14d));
check("only a return within 14 days counts", s1.return14d.returned - s0.return14d.returned === 1, JSON.stringify(s1.return14d));
check(
  "paid calls and revenue add up",
  d("paidCalls") === 6 && Math.abs(s1.byCall.write.usd - (s0.byCall.write?.usd ?? 0) - 6 * 0.003) < 1e-9,
  JSON.stringify({ calls: d("paidCalls"), write: s1.byCall.write }),
);
check("multi-day wallets counted", d("multiDayWallets") === 2, String(d("multiDayWallets")));
r = await call("POST", "/write", rand(), { key: "bad key", value: "x" });
await settle();
check("failed calls are not counted", r.status === 400 && (await stats()).wallets === s1.wallets);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
