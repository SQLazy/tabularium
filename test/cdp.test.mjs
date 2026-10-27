// The CDP facilitator token must be a JWT any standard verifier accepts, shaped like @coinbase/cdp-sdk's.
import { describe, expect, it } from "vitest";
import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { cdpAuthHeaders, cdpJwt, importCdpKey } from "../src/cdp.ts";

const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

// A throwaway key in CDP's format: base64(seed || public key).
async function cdpStyleKey() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const secret = btoa(String.fromCharCode(...fromB64url(jwk.d), ...fromB64url(jwk.x)));
  return { secret, publicJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x } };
}

describe("CDP facilitator auth", () => {
  it("issues an EdDSA JWT that jose verifies, with CDP's claims", async () => {
    const { secret, publicJwk } = await cdpStyleKey();
    const token = await cdpJwt(await importCdpKey(secret), "key-id-123", "POST", "/platform/v2/x402/settle");
    const { payload, protectedHeader } = await jwtVerify(token, await importJWK(publicJwk, "EdDSA"), { issuer: "cdp", subject: "key-id-123" });
    expect(protectedHeader).toMatchObject({ alg: "EdDSA", kid: "key-id-123", typ: "JWT" });
    expect(protectedHeader.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(payload.uris).toEqual(["POST api.cdp.coinbase.com/platform/v2/x402/settle"]);
    expect(payload.exp - payload.iat).toBe(120);
    expect(payload.nbf).toBe(payload.iat);
  });

  it("is rejected by a verifier holding a different key", async () => {
    const a = await cdpStyleKey();
    const b = await cdpStyleKey();
    const token = await cdpJwt(await importCdpKey(a.secret), "k", "GET", "/platform/v2/x402/supported");
    await expect(jwtVerify(token, await importJWK(b.publicJwk, "EdDSA"))).rejects.toThrow();
  });

  it("gives verify, settle and supported their own path-bound tokens", async () => {
    const { secret } = await cdpStyleKey();
    const h = await cdpAuthHeaders("k", secret)();
    const uri = (bearer) => JSON.parse(new TextDecoder().decode(fromB64url(bearer.slice(7).split(".")[1]))).uris[0];
    expect(uri(h.verify.Authorization)).toBe("POST api.cdp.coinbase.com/platform/v2/x402/verify");
    expect(uri(h.settle.Authorization)).toBe("POST api.cdp.coinbase.com/platform/v2/x402/settle");
    expect(uri(h.supported.Authorization)).toBe("GET api.cdp.coinbase.com/platform/v2/x402/supported");
    expect(decodeProtectedHeader(h.verify.Authorization.slice(7)).nonce).not.toBe(decodeProtectedHeader(h.settle.Authorization.slice(7)).nonce);
  });

  it("refuses a key that is not a 64-byte Ed25519 secret (e.g. a PEM EC key)", async () => {
    await expect(importCdpKey("-----BEGIN EC PRIVATE KEY-----")).rejects.toThrow(/base64|Ed25519/);
    await expect(importCdpKey(btoa("x".repeat(32)))).rejects.toThrow(/Ed25519/);
  });
});
