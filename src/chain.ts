// Hash chain + head signatures. Pure functions, no Workers APIs: runs in Node for tests.
// Keep verifier/verify.mjs byte-compatible with this file (a test enforces it).

export const GENESIS = "0".repeat(64);
export const CHAIN_TAG = "omega/v1";

export interface Entry {
  seq: number;
  ts: number;
  op: "write" | "renew";
  key: string;
  valueHash: string;
  prev: string;
  hash: string;
}

const enc = new TextEncoder();

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Uint8Array {
  if (!/^([0-9a-f]{2})*$/i.test(hex)) throw new Error("bad hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function b64decode(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}

/** Canonical preimage. Keys cannot contain newlines (KEY_PATTERN), so fields are unambiguous. */
export function entryPreimage(e: Omit<Entry, "hash">): string {
  return `${CHAIN_TAG}\n${e.seq}\n${e.ts}\n${e.op}\n${e.key}\n${e.valueHash}\n${e.prev}`;
}

export async function entryHash(e: Omit<Entry, "hash">): Promise<string> {
  return sha256Hex(entryPreimage(e));
}

export function headMessage(wallet: string, seq: number, hash: string): string {
  return `${CHAIN_TAG}/head\n${wallet.toLowerCase()}\n${seq}\n${hash}`;
}

export async function importSigningKey(pkcs8B64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", b64decode(pkcs8B64), { name: "Ed25519" }, false, ["sign"]);
}

/**
 * Imports the private key and proves it pairs with the published public key, by signing a probe and verifying it.
 * A mismatch (e.g. a secret rotated without the matching SIGNING_PUBKEY_HEX) throws instead of issuing
 * signatures nobody can verify.
 */
export async function loadSigningKey(pkcs8B64: string, pubHex: string): Promise<CryptoKey> {
  const key = await importSigningKey(pkcs8B64);
  const probe = "0".repeat(64);
  const ok = await verifyHead(pubHex, "key-probe", 0, probe, await signHead(key, "key-probe", 0, probe)).catch(() => false);
  if (!ok) throw new Error("SIGNING_KEY_PKCS8 does not match SIGNING_PUBKEY_HEX");
  return key;
}

export async function signHead(key: CryptoKey, wallet: string, seq: number, hash: string): Promise<string> {
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, enc.encode(headMessage(wallet, seq, hash)));
  return b64encode(new Uint8Array(sig));
}

export async function verifyHead(
  pubHex: string,
  wallet: string,
  seq: number,
  hash: string,
  sigB64: string,
): Promise<boolean> {
  const pub = await crypto.subtle.importKey("raw", fromHex(pubHex), { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "Ed25519" }, pub, b64decode(sigB64), enc.encode(headMessage(wallet, seq, hash)));
}

/** Verify linkage and hashes of a contiguous run of entries starting after `anchor`. */
export async function verifyChain(
  entries: Entry[],
  anchor: string = GENESIS,
): Promise<{ ok: true } | { ok: false; brokenAt: number; reason: string }> {
  let prev = anchor;
  let expectSeq = entries.length ? entries[0].seq : 0;
  for (const e of entries) {
    if (e.seq !== expectSeq) return { ok: false, brokenAt: e.seq, reason: "seq gap" };
    if (e.prev !== prev) return { ok: false, brokenAt: e.seq, reason: "prev mismatch" };
    const { hash, ...rest } = e;
    if ((await entryHash(rest)) !== hash) return { ok: false, brokenAt: e.seq, reason: "hash mismatch" };
    prev = hash;
    expectSeq++;
  }
  return { ok: true };
}
