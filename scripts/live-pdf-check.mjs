// One paid snapshot of a small public PDF on a live Tabularium, to prove document conversion works in production.
// Usage: PAYER_FILE=.secrets/mainnet-payer.json node scripts/live-pdf-check.mjs https://tabularium.matt-3e0.workers.dev
// Costs one snapshot call (real USDC on mainnet). Marked as a test request, so it never counts as demand.
import { readFileSync } from "node:fs";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { verifySnapshot } from "../verifier/verify.mjs";

const BASE = (process.argv[2] ?? "").replace(/\/$/, "");
if (!BASE) throw new Error("usage: node scripts/live-pdf-check.mjs <baseUrl>");
const w = JSON.parse(readFileSync(process.env.PAYER_FILE ?? ".testnet-wallets.json", "utf8"));
const tfetch = (input, init = {}) => {
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set("x-tabularium-test", "1");
  return fetch(input, { ...init, headers });
};
const menu = await (await tfetch(`${BASE}/menu`)).json();
const payFetch = wrapFetchWithPaymentFromConfig(tfetch, {
  schemes: [{ network: menu.x402.network, client: new ExactEvmScheme(privateKeyToAccount(w.payer.privateKey)) }],
});
const res = await payFetch(`${BASE}/snapshot/fetch`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ url: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf" }),
});
const j = await res.json();
const ok = res.status === 200 && /Dummy PDF file/.test(j.text ?? "") && (await verifySnapshot(j, menu.signing.publicKeyHex)).ok;
console.log(ok ? "PASS" : "FAIL", res.status, JSON.stringify({ title: j.snapshot?.title, text: j.text, verdict: j.checks?.verdict, error: j.error }));
process.exit(ok ? 0 : 1);
