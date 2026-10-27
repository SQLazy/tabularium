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

// Snapshot service: the server signs "tabularium/snapshot/v1\n" + JSON of the record's fields in this order.
const SNAPSHOT_FIELDS = ["v", "wallet", "url", "finalUrl", "fetchedAt", "status", "contentType", "bytes", "sha256", "textChars", "textSha256", "title", "truncated"];

/**
 * Verifies a /snapshot/fetch response ({snapshot, text, sig}): the text matches textSha256 and textChars, and the
 * server's signature covers the record. Pass `rawBytes` (the page as saved) to also check sha256 and bytes.
 * Proves what Tabularium's fetcher received at fetchedAt, not what the site served to anyone else.
 */
export async function verifySnapshot(res, pubHex, rawBytes) {
  const errors = [];
  const s = res?.snapshot;
  if (!s || typeof res.text !== "string" || typeof res.sig !== "string") return { ok: false, errors: ["not a snapshot response"] };
  if (res.text.length !== s.textChars) errors.push("text length does not match textChars");
  if ((await sha256Hex(res.text)) !== s.textSha256) errors.push("text does not match textSha256");
  if (rawBytes) {
    if (rawBytes.byteLength !== s.bytes) errors.push("raw body size does not match bytes");
    if (hex(await crypto.subtle.digest("SHA-256", rawBytes)) !== s.sha256) errors.push("raw body does not match sha256");
  }
  try {
    const pub = await crypto.subtle.importKey("raw", fromHex(pubHex), { name: "Ed25519" }, false, ["verify"]);
    const msg = enc.encode(`tabularium/snapshot/v1\n${JSON.stringify(SNAPSHOT_FIELDS.map((k) => s[k]))}`);
    const ok = await crypto.subtle.verify({ name: "Ed25519" }, pub, Uint8Array.from(atob(res.sig), (c) => c.charCodeAt(0)), msg);
    if (!ok) errors.push("snapshot signature invalid");
  } catch (err) {
    errors.push(`signature check failed: ${err.message}`);
  }
  return { ok: errors.length === 0, errors, url: s.finalUrl, fetchedAt: s.fetchedAt };
}

if (import.meta.url === `file://${process.argv[1]}` || import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
  const args = process.argv.slice(2);
  const snap = args[0] === "--snapshot";
  const [file, pub] = snap ? args.slice(1) : args;
  if (!file || !pub) {
    console.error("usage: node verifier/verify.mjs export.json <publicKeyHex>\n       node verifier/verify.mjs --snapshot response.json <publicKeyHex>");
    process.exit(2);
  }
  const { readFileSync } = await import("node:fs");
  const doc = JSON.parse(readFileSync(file, "utf8"));
  if (snap) {
    const r = await verifySnapshot(doc, pub);
    console.log(r.ok ? `OK: snapshot of ${r.url} at ${new Date(r.fetchedAt).toISOString()} verified` : "FAILED:\n  " + r.errors.join("\n  "));
    process.exit(r.ok ? 0 : 1);
  }
  const r = await verifyExport(doc, pub);
  console.log(r.ok ? `OK: ${r.entries} entries verified` : "FAILED:\n  " + r.errors.join("\n  "));
  process.exit(r.ok ? 0 : 1);
}
