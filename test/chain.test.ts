import { describe, expect, it } from "vitest";
import {
  GENESIS,
  loadSigningKey,
  b64encode,
  entryHash,
  sha256Hex,
  signHead,
  toHex,
  verifyChain,
  verifyHead,
  type Entry,
} from "../src/chain";
import { verifyExport } from "../verifier/verify.mjs";

const WALLET = "0x1111111111111111111111111111111111111111";

async function build(n: number): Promise<Entry[]> {
  const out: Entry[] = [];
  let prev = GENESIS;
  for (let i = 1; i <= n; i++) {
    const base = { seq: i, ts: 1_700_000_000_000 + i, op: "write" as const, key: `k${i % 3}`, valueHash: await sha256Hex(`v${i}`), prev };
    const hash = await entryHash(base);
    out.push({ ...base, hash });
    prev = hash;
  }
  return out;
}

async function keypair() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return {
    priv: kp.privateKey,
    pubHex: toHex((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer),
  };
}

describe("hash chain", () => {
  it("verifies an intact chain", async () => {
    expect(await verifyChain(await build(25))).toEqual({ ok: true });
  });

  it("detects a modified entry", async () => {
    const c = await build(10);
    c[4] = { ...c[4], key: "evil" };
    const r = await verifyChain(c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.brokenAt).toBe(5);
  });

  it("detects a deleted entry", async () => {
    const c = await build(10);
    c.splice(3, 1);
    expect((await verifyChain(c)).ok).toBe(false);
  });

  it("detects reordering", async () => {
    const c = await build(10);
    [c[2], c[3]] = [c[3], c[2]];
    expect((await verifyChain(c)).ok).toBe(false);
  });

  it("supports incremental verification from an anchor", async () => {
    const c = await build(10);
    expect(await verifyChain(c.slice(5), c[4].hash)).toEqual({ ok: true });
    expect((await verifyChain(c.slice(5), GENESIS)).ok).toBe(false);
  });
});

describe("head signatures", () => {
  it("round-trips, and fails on any changed field", async () => {
    const { priv, pubHex } = await keypair();
    const sig = await signHead(priv, WALLET, 7, "ab".repeat(32));
    expect(await verifyHead(pubHex, WALLET, 7, "ab".repeat(32), sig)).toBe(true);
    expect(await verifyHead(pubHex, WALLET, 8, "ab".repeat(32), sig)).toBe(false);
    expect(await verifyHead(pubHex, WALLET, 7, "cd".repeat(32), sig)).toBe(false);
    expect(await verifyHead(pubHex, "0x2222222222222222222222222222222222222222", 7, "ab".repeat(32), sig)).toBe(false);
  });

  it("is case-insensitive on the wallet (identity is the lowercased address)", async () => {
    const { priv, pubHex } = await keypair();
    const sig = await signHead(priv, WALLET.toUpperCase().replace("0X", "0x"), 1, "ab".repeat(32));
    expect(await verifyHead(pubHex, WALLET, 1, "ab".repeat(32), sig)).toBe(true);
  });
});

describe("standalone verifier agrees with the Worker code", () => {
  async function makeExport() {
    const entries = await build(6);
    const { priv, pubHex } = await keypair();
    const head = { seq: 6, hash: entries[5].hash };
    const sig = await signHead(priv, WALLET, head.seq, head.hash);
    // latest write per key, as the DO's kv table would hold it
    const values: Record<string, { value: string; seq: number }> = {};
    for (const e of entries) {
      const i = Number(e.seq);
      values[e.key] = { value: `v${i}`, seq: e.seq };
    }
    return { exp: { wallet: WALLET, anchor: GENESIS, entries, values, head: { ...head, sig } }, pubHex };
  }

  it("accepts a genuine export", async () => {
    const { exp, pubHex } = await makeExport();
    const r = await verifyExport(exp, pubHex);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("rejects a tampered value", async () => {
    const { exp, pubHex } = await makeExport();
    exp.values.k0.value = "forged";
    expect((await verifyExport(exp, pubHex)).ok).toBe(false);
  });

  it("rejects a tampered entry", async () => {
    const { exp, pubHex } = await makeExport();
    exp.entries[2] = { ...exp.entries[2], ts: exp.entries[2].ts + 1 };
    expect((await verifyExport(exp, pubHex)).ok).toBe(false);
  });

  it("rejects a head signed by a different key", async () => {
    const { exp } = await makeExport();
    const other = await keypair();
    expect((await verifyExport(exp, other.pubHex)).ok).toBe(false);
  });

  it("b64 helpers round-trip (guards the signature encoding)", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
    const back = Uint8Array.from(atob(b64encode(bytes)), (c) => c.charCodeAt(0));
    expect(Array.from(back)).toEqual(Array.from(bytes));
  });
});

describe("signing key load", () => {
  async function pkcs8Pair() {
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    return {
      pkcs8: b64encode(new Uint8Array((await crypto.subtle.exportKey("pkcs8", kp.privateKey)) as ArrayBuffer)),
      pubHex: toHex((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer),
    };
  }

  it("accepts a matching private/public pair", async () => {
    const a = await pkcs8Pair();
    await expect(loadSigningKey(a.pkcs8, a.pubHex)).resolves.toBeDefined();
  });

  it("refuses a private key that does not match the published public key", async () => {
    const a = await pkcs8Pair();
    const b = await pkcs8Pair();
    await expect(loadSigningKey(a.pkcs8, b.pubHex)).rejects.toThrow(/does not match/);
  });

  it("refuses a malformed public key", async () => {
    const a = await pkcs8Pair();
    await expect(loadSigningKey(a.pkcs8, "zz")).rejects.toThrow(/does not match/);
  });
});
