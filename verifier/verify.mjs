#!/usr/bin/env node
// Standalone, zero-dependency verifier for Omega exports. Trust the math, not the server.
//   node verifier/verify.mjs export.json <publicKeyHex>
// Must stay byte-compatible with src/chain.ts (test/chain.test.ts enforces this).

const GENESIS = "0".repeat(64);
const enc = new TextEncoder();

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const sha256Hex = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const preimage = (e) => `omega/v1\n${e.seq}\n${e.ts}\n${e.op}\n${e.key}\n${e.valueHash}\n${e.prev}`;

export async function verifyExport(exp, pubHex) {
  const errors = [];
  const entries = exp.entries ?? [];

  // 1. hash chain: contiguous seq, each prev == previous hash, each hash recomputes
  let prev = exp.anchor ?? GENESIS;
  let seq = entries.length ? entries[0].seq : 0;
  for (const e of entries) {
    if (e.seq !== seq) errors.push(`seq gap at ${e.seq}`);
    if (e.prev !== prev) errors.push(`prev mismatch at ${e.seq}`);
    if ((await sha256Hex(preimage(e))) !== e.hash) errors.push(`hash mismatch at ${e.seq}`);
    prev = e.hash;
    seq = e.seq + 1;
  }

  // 2. head matches the chain
  if (entries.length && (exp.head.seq !== entries.at(-1).seq || exp.head.hash !== entries.at(-1).hash)) {
    errors.push("head does not match last entry");
  }

  // 3. every exported value matches the hash committed in the chain for its seq
  const bySeq = new Map(entries.map((e) => [e.seq, e]));
  for (const [key, v] of Object.entries(exp.values ?? {})) {
    const e = bySeq.get(v.seq);
    if (!e) errors.push(`value for "${key}" points at seq ${v.seq}, not in export`);
    else if (e.key !== key) errors.push(`value key mismatch at seq ${v.seq}`);
    else if ((await sha256Hex(v.value)) !== e.valueHash) errors.push(`value hash mismatch for "${key}"`);
  }

  // 4. server signature over the head
  try {
    const pub = await crypto.subtle.importKey("raw", fromHex(pubHex), { name: "Ed25519" }, false, ["verify"]);
    const msg = enc.encode(`omega/v1/head\n${exp.wallet.toLowerCase()}\n${exp.head.seq}\n${exp.head.hash}`);
    const ok = await crypto.subtle.verify({ name: "Ed25519" }, pub, Uint8Array.from(atob(exp.head.sig), (c) => c.charCodeAt(0)), msg);
    if (!ok) errors.push("head signature invalid");
  } catch (err) {
    errors.push(`signature check failed: ${err.message}`);
  }

  return { ok: errors.length === 0, errors, entries: entries.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, pub] = process.argv.slice(2);
  if (!file || !pub) {
    console.error("usage: node verifier/verify.mjs export.json <publicKeyHex>");
    process.exit(2);
  }
  const { readFileSync } = await import("node:fs");
  const r = await verifyExport(JSON.parse(readFileSync(file, "utf8")), pub);
  console.log(r.ok ? `OK: ${r.entries} entries verified` : "FAILED:\n  " + r.errors.join("\n  "));
  process.exit(r.ok ? 0 : 1);
}
