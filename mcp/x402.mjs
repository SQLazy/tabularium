// Minimal x402 v2 client for the EVM "exact" scheme (EIP-3009 transferWithAuthorization on USDC).
// Builds the same PAYMENT-SIGNATURE header as the official @x402/fetch + @x402/evm 2.28 client
// (test/x402-v2-equivalence.test.mjs proves it byte for byte), without their dependency tree.
// Signing is local: no RPC, no network calls besides the request itself.
import { getAddress, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const CHAIN_ID = { "eip155:8453": 8453, "eip155:84532": 84532 };
// Only ever sign for real USDC. A 402 that asks for any other asset is refused.
const USDC = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};
export const CAIP2 = { base: "eip155:8453", "base-sepolia": "eip155:84532" };
const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

// A seller that holds a signed authorization can settle it until validBefore, even after answering with an error.
// Keep that window short whatever the seller asks for.
export const MAX_AUTH_WINDOW_SECONDS = 600;

const b64encode = (s) => btoa(Array.from(new TextEncoder().encode(s), (b) => String.fromCharCode(b)).join(""));
const b64decode = (s) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

/** Decodes the PAYMENT-REQUIRED header of a 402 response. */
export function decodePaymentRequired(header) {
  if (!header || !/^[A-Za-z0-9+/]*={0,2}$/.test(header)) throw new Error("402 without a valid PAYMENT-REQUIRED header");
  return JSON.parse(b64decode(header));
}

/**
 * Builds the base64 PAYMENT-SIGNATURE header paying `req` (one entry of paymentRequired.accepts).
 * `now` (ms) and `nonce` are injectable for tests.
 */
export async function createPaymentHeader(account, paymentRequired, req, { now = Date.now(), nonce } = {}) {
  const chainId = CHAIN_ID[req.network];
  if (!chainId) throw new Error(`unsupported network ${req.network}`);
  if (!req.extra?.name || !req.extra?.version) throw new Error("payment requirement lacks the token's EIP-712 name/version");
  nonce ??= toHex(crypto.getRandomValues(new Uint8Array(32)));
  const authorization = {
    from: account.address,
    to: getAddress(req.payTo),
    value: req.amount,
    validAfter: "0",
    validBefore: (Math.floor(now / 1e3) + Math.min(req.maxTimeoutSeconds, MAX_AUTH_WINDOW_SECONDS)).toString(),
    nonce,
  };
  const signature = await account.signTypedData({
    domain: { name: req.extra.name, version: req.extra.version, chainId, verifyingContract: getAddress(req.asset) },
    types: TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: getAddress(authorization.from),
      to: getAddress(authorization.to),
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce,
    },
  });
  // Field order matches the official client, so the encoded header is identical.
  const payment = {
    x402Version: paymentRequired.x402Version,
    payload: { authorization, signature },
    extensions: paymentRequired.extensions,
    resource: paymentRequired.resource,
    accepted: req,
  };
  return b64encode(JSON.stringify(payment));
}

/** Decodes a PAYMENT-RESPONSE (settlement receipt) header, or returns null. */
export function decodePaymentResponse(header) {
  if (!header || !/^[A-Za-z0-9+/]*={0,2}$/.test(header)) return null;
  try {
    return JSON.parse(b64decode(header));
  } catch {
    return null;
  }
}

/**
 * Pays a 402 once and retries the request with PAYMENT-SIGNATURE.
 * Refuses (throws, nothing signed) unless the requirement is: x402 v2, exact scheme via EIP-3009, an allowed
 * network, real USDC on it, the expected payee (when one is given), and an amount within the cap.
 * Networks are CAIP-2 ids ("eip155:84532") or legacy names ("base-sepolia").
 *
 * Defaults (network, payTo) describe the Tabularium service itself. Paying any other service passes
 * { networks, payTo: null, maxAtomic } per call: the payee then is whoever that service names, which the
 * caller records in its receipt.
 */
export function createPayer(privateKey, { network, payTo, maxAtomic }) {
  network = CAIP2[network] ?? network;
  if (!CHAIN_ID[network]) throw new Error(`unsupported network ${network}`);
  const account = privateKeyToAccount(privateKey);

  /**
   * Returns { res, payment }; payment is null when no payment was needed.
   * beforeSign(req, nonce): last chance to refuse, with the real price and the nonce the authorization will use
   * (so a caller can sign its own intent over that nonce first). onSigned(header, req, nonce, resource): called
   * with the finished PAYMENT-SIGNATURE before it is sent, so a caller can persist it and retry with the same
   * authorization (which can settle at most once) instead of signing a second one.
   */
  async function payOnce(url, init = {}, { networks = [network], payTo: expectPayTo = payTo, maxAtomic: callCap, beforeSign, onSigned } = {}) {
    const allowed = networks.map((n) => CAIP2[n] ?? n);
    const cap = callCap !== undefined && BigInt(callCap) < BigInt(maxAtomic) ? callCap : maxAtomic;
    // Never follow redirects: the payment (and the receipt) must go to the URL that was asked for, and a signed
    // PAYMENT-SIGNATURE must not be forwarded to another origin. A 3xx comes back to the caller unpaid.
    const first = await fetch(url, { ...init, redirect: "manual" });
    if (first.status !== 402) return { res: first, payment: null };
    const required = decodePaymentRequired(first.headers.get("PAYMENT-REQUIRED"));
    if (required.x402Version !== 2) throw new Error(`unsupported x402 version ${required.x402Version}`);
    const req = (required.accepts ?? []).find(
      (r) =>
        r.scheme === "exact" &&
        allowed.includes(r.network) &&
        !!USDC[r.network] &&
        getAddress(r.asset) === getAddress(USDC[r.network]) &&
        (r.extra?.assetTransferMethod ?? "eip3009") === "eip3009",
    );
    if (!req) throw new Error(`no acceptable payment option (need x402 v2 exact/EIP-3009 USDC on ${allowed.join(" or ")})`);
    if (expectPayTo && getAddress(req.payTo) !== getAddress(expectPayTo)) throw new Error(`402 asks to pay ${req.payTo}, but the menu says ${expectPayTo}`);
    if (BigInt(req.amount) > BigInt(cap)) throw new Error(`402 asks for ${req.amount} (atomic USDC), above the cap ${cap}`);
    const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
    await beforeSign?.(req, nonce); // last chance to refuse (e.g. a spend cap), with the real price known; throws to abort
    const header = await createPaymentHeader(account, required, req, { nonce });
    await onSigned?.(header, req, nonce, required.resource);
    const res = await fetch(url, { ...init, redirect: "manual", headers: { ...(init.headers ?? {}), "PAYMENT-SIGNATURE": header } });
    return { res, payment: { requirement: req, resource: required.resource, nonce } };
  }

  async function payFetch(url, init = {}, opts = {}) {
    return (await payOnce(url, init, opts)).res;
  }
  /** EIP-191 personal_sign with the paying wallet (verifiable by anyone with the address). */
  const signMessage = (message) => account.signMessage({ message });
  return { address: account.address, payFetch, payOnce, signMessage };
}
