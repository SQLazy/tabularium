// Tabularium from code: give an agent memory that survives the process, paid per call in USDC (x402 v2).
//   npm install @x402/fetch @x402/evm viem
//   TABULARIUM_PRIVATE_KEY=0x... node agent-memory.mjs
// Costs real USDC on Base mainnet: one write ($0.003) and one read ($0.002). Use a wallet holding a few dollars.
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const BASE = "https://tabularium.matt-3e0.workers.dev";
const account = privateKeyToAccount(process.env.TABULARIUM_PRIVATE_KEY);

// The menu is free: it names the network, prices and the public signing key.
const menu = await (await fetch(`${BASE}/menu`)).json();
const pay = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: menu.x402.network, client: new ExactEvmScheme(account) }] });

// Remember something. The idempotency_key makes a retry safe: it can never write twice.
const write = await pay(`${BASE}/write`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ key: "notes/today", value: JSON.stringify({ decided: "ship v2", at: new Date().toISOString() }), idempotency_key: `note-${Date.now()}` }),
});
console.log("write", write.status, await write.json());

// Recall it later, from any process or machine paying with the same wallet.
const read = await pay(`${BASE}/read?key=notes/today`);
console.log("read", read.status, await read.json());

// Free: the signed head of this wallet's history (no values). A later export must match it.
console.log("head", await (await fetch(`${BASE}/head?wallet=${account.address}`)).json());
