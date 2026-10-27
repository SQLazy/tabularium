// Generates the Ed25519 signing keypair.
//   npm run keygen              -> prints values
//   npm run keygen -- --dev     -> also writes .dev.vars for local testing (gitignored)
import { writeFileSync } from "node:fs";

const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", kp.privateKey)).toString("base64");
const pubHex = Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString("hex");

if (process.argv.includes("--dev")) {
  writeFileSync(".dev.vars", `SIGNING_KEY_PKCS8=${pkcs8}\nSIGNING_PUBKEY_HEX=${pubHex}\n`);
  console.log("wrote .dev.vars (local testing only)");
  console.log("SIGNING_PUBKEY_HEX=" + pubHex);
} else {
  console.log("Public (put in wrangler.jsonc vars.SIGNING_PUBKEY_HEX):\n  " + pubHex);
  console.log("\nSecret (pipe into: npx wrangler secret put SIGNING_KEY_PKCS8):\n  " + pkcs8);
  console.log("\nStore the secret somewhere safe. Rotating it invalidates nothing already issued,");
  console.log("but publish the old public key forever so old receipts stay verifiable.");
}
