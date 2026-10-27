// Auth for the Coinbase (CDP) x402 facilitator, with WebCrypto only.
// Same JWT as @coinbase/cdp-sdk 1.58 generateJwt for Ed25519 keys (EdDSA, kid + nonce header, 120 s life,
// one `uris` claim per request), without the SDK's dependency tree, which does not suit a Worker.

export const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const HOST = "api.cdp.coinbase.com";
const ROUTE = "/platform/v2/x402";

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (o: unknown) => b64url(enc.encode(JSON.stringify(o)));
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** CDP "secret API key" for Ed25519: base64 of 64 bytes (32-byte seed then 32-byte public key). */
export async function importCdpKey(secretB64: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = Uint8Array.from(atob(secretB64.trim()), (c) => c.charCodeAt(0));
  } catch {
    throw new Error("CDP_API_KEY_SECRET is not base64");
  }
  if (raw.length !== 64) {
    throw new Error("CDP_API_KEY_SECRET must be an Ed25519 key (base64 of 64 bytes); create the key with the Ed25519 algorithm");
  }
  const jwk = { kty: "OKP", crv: "Ed25519", d: b64url(raw.subarray(0, 32)), x: b64url(raw.subarray(32)) };
  return crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
}

/** One signed bearer token for one request (method + host + path), valid for 120 s. */
export async function cdpJwt(key: CryptoKey, keyId: string, method: string, path: string, now = Date.now()): Promise<string> {
  const t = Math.floor(now / 1000);
  const header = { alg: "EdDSA", kid: keyId, typ: "JWT", nonce: hex(crypto.getRandomValues(new Uint8Array(16))) };
  const claims = { sub: keyId, iss: "cdp", uris: [`${method} ${HOST}${path}`], iat: t, nbf: t, exp: t + 120 };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, enc.encode(signingInput)));
  return `${signingInput}.${b64url(sig)}`;
}

/** createAuthHeaders for @x402/core's HTTPFacilitatorClient: fresh tokens for every facilitator call. */
export function cdpAuthHeaders(keyId: string, secretB64: string) {
  let keyPromise: Promise<CryptoKey> | null = null;
  return async () => {
    // Importing a key is CPU-only (no I/O), so sharing it across requests is safe.
    keyPromise ??= importCdpKey(secretB64);
    const key = await keyPromise.catch((err) => {
      keyPromise = null;
      throw err;
    });
    const bearer = async (method: string, path: string) => ({ Authorization: `Bearer ${await cdpJwt(key, keyId, method, `${ROUTE}${path}`)}` });
    return {
      verify: await bearer("POST", "/verify"),
      settle: await bearer("POST", "/settle"),
      supported: await bearer("GET", "/supported"),
    };
  };
}
