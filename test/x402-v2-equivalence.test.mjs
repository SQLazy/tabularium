// mcp/x402.mjs hand-builds the x402 v2 PAYMENT-SIGNATURE header to keep the MCP package small.
// This proves it is byte-identical to the official client (@x402/core + @x402/evm) for the same inputs.
import { afterEach, describe, expect, it, vi } from "vitest";
import { x402Client } from "@x402/core/client";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { createPaymentHeader, decodePaymentRequired } from "../mcp/x402.mjs";

// A throwaway key, never funded.
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const NOW = 1_790_000_000_000;
const NONCE_BYTES = new Uint8Array(32).map((_, i) => (i * 37 + 11) & 255);
const nonceHex = "0x" + Array.from(NONCE_BYTES, (b) => b.toString(16).padStart(2, "0")).join("");

// Shape of the live service's 402 (PAYMENT-REQUIRED), including a non-ASCII description to exercise UTF-8.
const paymentRequired = {
  x402Version: 2,
  error: "Payment required",
  resource: { url: "https://tabularium.example/write", description: "Append a value — hash-chained", mimeType: "application/json" },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:84532",
      amount: "1000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: "0x951BD91AD61d2D867F21b54D2f717D8FFF4aD28a",
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2" },
    },
  ],
};

afterEach(() => vi.restoreAllMocks());

async function official(pr) {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((a) => (a.set(NONCE_BYTES), a));
  const client = new x402Client().register("eip155:*", new ExactEvmScheme(privateKeyToAccount(KEY)));
  const header = encodePaymentSignatureHeader(await client.createPaymentPayload(pr));
  vi.restoreAllMocks();
  return header;
}

describe("x402 v2 header equivalence", () => {
  it("matches the official client byte for byte", async () => {
    const theirs = await official(paymentRequired);
    const ours = await createPaymentHeader(privateKeyToAccount(KEY), paymentRequired, paymentRequired.accepts[0], { now: NOW, nonce: nonceHex });
    expect(ours).toBe(theirs);
  });

  it("matches when the server declares extensions (needed for Bazaar)", async () => {
    const pr = { ...paymentRequired, extensions: { bazaar: { info: { input: { type: "http", method: "POST" } } } } };
    const theirs = await official(pr);
    const ours = await createPaymentHeader(privateKeyToAccount(KEY), pr, pr.accepts[0], { now: NOW, nonce: nonceHex });
    expect(ours).toBe(theirs);
  });

  it("decodes a PAYMENT-REQUIRED header, including UTF-8", () => {
    const enc = btoa(Array.from(new TextEncoder().encode(JSON.stringify(paymentRequired)), (b) => String.fromCharCode(b)).join(""));
    expect(decodePaymentRequired(enc)).toEqual(paymentRequired);
  });
});
