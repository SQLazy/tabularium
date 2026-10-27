// Free checks against a deployed Tabularium (no payment, nothing charged). Run after every deploy.
//   node scripts/live-check.mjs [baseUrl]
// Every request carries the test marker, so these checks never count as demand in /stats.
const BASE = (process.argv[2] ?? "https://tabularium.matt-3e0.workers.dev").replace(/\/$/, "");
const H = { "x-tabularium-test": "1", "user-agent": "tabularium-live-check" };
const get = (path, init = {}) => fetch(BASE + path, { ...init, headers: { ...H, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });

let failed = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + extra}`);
  if (!ok) failed++;
};

const menuRes = await get("/menu");
const menu = await menuRes.json().catch(() => null);
check("menu answers with services and a signing key", menuRes.status === 200 && Array.isArray(menu?.services) && /^[0-9a-f]{64}$/.test(menu?.signing?.publicKeyHex ?? ""), String(menuRes.status));
const calls = (menu?.services ?? []).flatMap((s) => s.calls.map((c) => ({ service: s.id, ...c })));
check("every service lists at least one paid call", calls.length > 0 && (menu?.services ?? []).every((s) => s.calls.length > 0));

const oa = await (await get("/openapi.json")).json().catch(() => null);
const llms = await (await get("/llms.txt")).text();
for (const c of calls) {
  const [method, path] = c.call.split(" ");
  const res = await get(path, { method });
  let req = null;
  try {
    req = JSON.parse(atob(res.headers.get("payment-required") ?? ""));
  } catch {
    req = null;
  }
  const accept = req?.accepts?.[0];
  const atomic = String(Math.round(Number(c.price.slice(1)) * 1e6));
  check(
    `${c.call}: a bare probe gets 402 asking the menu price (${c.price}) for the menu payee`,
    res.status === 402 && accept?.amount === atomic && accept?.payTo?.toLowerCase() === menu.payTo.toLowerCase() && accept?.network === menu.x402.network,
    JSON.stringify({ status: res.status, accept }).slice(0, 200),
  );
  check(`${c.call}: openapi.json prices it the same`, oa?.paths?.[path]?.[method.toLowerCase()]?.["x-payment-info"]?.price?.amount === c.price.slice(1));
  check(`${c.call}: llms.txt shows the price`, llms.includes(c.price));
}

const stats = await (await get("/stats")).json().catch(() => null);
check("stats lists every service", (menu?.services ?? []).every((s) => stats?.services?.[s.id]));

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
