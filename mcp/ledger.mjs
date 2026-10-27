// Ledger helpers: the payer's signed intent, receipt fingerprints, on-chain settlements, and reconciling receipts
// against them. Pure or fetch-injectable, so they run offline in tests.
import { createHash } from "node:crypto";
import { encodeFunctionData, keccak256, pad, toHex, verifyMessage } from "viem";

export const USDC = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};
export const DEFAULT_RPC = { "eip155:8453": "https://base-rpc.publicnode.com", "eip155:84532": "https://base-sepolia-rpc.publicnode.com" };
const BLOCK_SECONDS = { "eip155:8453": 2, "eip155:84532": 2 };
export const TOPIC = {
  // USDC (FiatToken v2) emits AuthorizationUsed(authorizer, nonce) for every settled EIP-3009 authorization.
  authorizationUsed: keccak256(toHex("AuthorizationUsed(address,bytes32)")),
  transfer: keccak256(toHex("Transfer(address,address,uint256)")),
};
const MAX_BLOCKS_PER_QUERY = 50_000; // the public Base RPCs refuse wider eth_getLogs ranges

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** JSON with object keys sorted at every level: one fingerprint per value, whatever order a seller used. */
export function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/**
 * The text the payer signs (EIP-191) BEFORE signing the payment: who, when, what request, which exact terms, which
 * payment nonce, and why. The reason is last, so it may contain anything (newlines included) without ambiguity.
 */
export function intentMessage({ payer, at, method, url, bodySha256, req, nonce, reason }) {
  return [
    "tabularium/intent/v1",
    `payer: ${payer.toLowerCase()}`,
    `at: ${at}`,
    `method: ${method}`,
    `url: ${url}`,
    `bodySha256: ${bodySha256 ?? "-"}`,
    `network: ${req.network}`,
    `asset: ${req.asset}`,
    `amount: ${req.amount}`,
    `payTo: ${req.payTo}`,
    `nonce: ${nonce}`,
    `acceptedSha256: ${sha256(stableStringify(req))}`,
    `reason: ${reason}`,
  ].join("\n");
}

/** Checks a receipt's intent: signed by the payer, and saying the same thing as the receipt. Null for v1 receipts. */
export async function checkIntent(rec) {
  if (!rec?.intent) return null;
  const problems = [];
  try {
    if (!(await verifyMessage({ address: rec.payer, message: rec.intent.message, signature: rec.intent.signature }))) problems.push("signature is not the payer's");
  } catch {
    problems.push("signature unreadable");
  }
  const lines = Object.fromEntries(
    rec.intent.message
      .split("\n")
      .slice(1)
      .map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2)]),
  );
  const reason = rec.intent.message.slice(rec.intent.message.indexOf("\nreason: ") + 9);
  const expect = {
    payer: String(rec.payer).toLowerCase(),
    nonce: rec.paymentNonce,
    amount: rec.amount?.atomic,
    payTo: rec.payTo,
    network: rec.network,
    acceptedSha256: rec.acceptedSha256,
    url: rec.request?.url,
    method: rec.request?.method,
  };
  for (const [k, v] of Object.entries(expect)) if (String(lines[k]) !== String(v)) problems.push(`${k} differs from the receipt`);
  if (reason !== rec.reason) problems.push("reason differs from the receipt");
  if (rec.accepted && sha256(stableStringify(rec.accepted)) !== rec.acceptedSha256) problems.push("accepted terms do not match acceptedSha256");
  return { ok: problems.length === 0, problems };
}

async function rpc(url, method, params, fetchImpl) {
  const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result;
}

/** Whether a payer's EIP-3009 authorization nonce has been used on-chain (i.e. that payment settled). */
export async function authorizationUsed({ rpcUrl, network, payer, nonce, fetchImpl = fetch }) {
  const data = encodeFunctionData({
    abi: [{ type: "function", name: "authorizationState", stateMutability: "view", inputs: [{ type: "address" }, { type: "bytes32" }], outputs: [{ type: "bool" }] }],
    functionName: "authorizationState",
    args: [payer, nonce],
  });
  const out = await rpc(rpcUrl, "eth_call", [{ to: USDC[network], data }, "latest"], fetchImpl);
  return BigInt(out) === 1n;
}

/**
 * Every USDC payment the payer authorized (EIP-3009) that settled in the last `days`: nonce, tx, block, payee, amount.
 * Joins AuthorizationUsed (nonce) with the Transfer from the payer in the same transaction (payee, amount).
 */
export async function settlementsOnChain({ rpcUrl, network, payer, days, fetchImpl = fetch }) {
  const head = Number(BigInt(await rpc(rpcUrl, "eth_blockNumber", [], fetchImpl)));
  const span = Math.ceil((days * 86_400) / BLOCK_SECONDS[network]);
  const from = Math.max(0, head - span);
  const who = pad(payer.toLowerCase());
  const auths = [];
  const transfers = [];
  for (let start = from; start <= head; start += MAX_BLOCKS_PER_QUERY) {
    const range = { address: USDC[network], fromBlock: toHex(start), toBlock: toHex(Math.min(start + MAX_BLOCKS_PER_QUERY - 1, head)) };
    auths.push(...(await rpc(rpcUrl, "eth_getLogs", [{ ...range, topics: [TOPIC.authorizationUsed, who] }], fetchImpl)));
    transfers.push(...(await rpc(rpcUrl, "eth_getLogs", [{ ...range, topics: [TOPIC.transfer, who] }], fetchImpl)));
  }
  const byTx = new Map();
  for (const t of transfers) (byTx.get(t.transactionHash) ?? byTx.set(t.transactionHash, []).get(t.transactionHash)).push(t);
  return {
    fromBlock: from,
    toBlock: head,
    settlements: auths.map((a) => {
      // In a transferWithAuthorization the Transfer is emitted right after AuthorizationUsed; pair by log order.
      const same = (byTx.get(a.transactionHash) ?? []).sort((x, y) => Number(BigInt(x.logIndex)) - Number(BigInt(y.logIndex)));
      const t = same.find((x) => Number(BigInt(x.logIndex)) > Number(BigInt(a.logIndex))) ?? same[0];
      return {
        nonce: a.topics[2].toLowerCase(),
        transaction: a.transactionHash.toLowerCase(),
        block: Number(BigInt(a.blockNumber)),
        payTo: t ? `0x${t.topics[2].slice(26)}` : null,
        atomic: t ? BigInt(t.data).toString() : null,
      };
    }),
  };
}

/**
 * Receipts vs settlements. servicePayTo: Tabularium's own payee; its calls (writes, reads, exports) settle on-chain
 * without receipts by design, so they are counted separately, not flagged.
 */
export function reconcile({ receipts, settlements, servicePayTo }) {
  const byNonce = new Map(settlements.map((s) => [s.nonce, s]));
  const matched = [];
  const mismatched = [];
  const unsettled = [];
  const recorded = new Set();
  for (const r of receipts) {
    const n = String(r.paymentNonce ?? "").toLowerCase();
    const s = byNonce.get(n);
    if (!s) {
      unsettled.push({ key: r.key, nonce: n, usd: r.amount?.usd, payTo: r.payTo, transaction: r.transaction });
      continue;
    }
    recorded.add(n);
    const diffs = [];
    if (s.atomic !== null && String(r.amount?.atomic) !== s.atomic) diffs.push("amount");
    if (s.payTo && String(r.payTo).toLowerCase() !== s.payTo.toLowerCase()) diffs.push("payTo");
    if (r.transaction && String(r.transaction).toLowerCase() !== s.transaction) diffs.push("transaction");
    (diffs.length ? mismatched : matched).push({ key: r.key, nonce: n, transaction: s.transaction, usd: Number(s.atomic ?? 0) / 1e6, ...(diffs.length ? { differs: diffs } : {}) });
  }
  const service = { count: 0, usd: 0 };
  const unrecorded = [];
  for (const s of settlements) {
    if (recorded.has(s.nonce)) continue;
    if (servicePayTo && s.payTo && s.payTo.toLowerCase() === servicePayTo.toLowerCase()) {
      service.count++;
      service.usd += Number(s.atomic ?? 0) / 1e6;
    } else unrecorded.push({ nonce: s.nonce, transaction: s.transaction, block: s.block, payTo: s.payTo, usd: Number(s.atomic ?? 0) / 1e6 });
  }
  service.usd = Number(service.usd.toFixed(6));
  return { ok: !unrecorded.length && !mismatched.length && !unsettled.length, matched, mismatched, unsettled, unrecorded, serviceCalls: service };
}
