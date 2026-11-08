// Writes wrangler.ci.jsonc: the production config without the Workers AI binding. AI bindings only run remotely, so
// `wrangler dev` with one needs a Cloudflare login, which the CI paywall job does not have (and should not need).
// Without it, snapshot refuses documents (415) and every other route is the production code.
import { readFileSync, writeFileSync } from "node:fs";

const lines = readFileSync("wrangler.jsonc", "utf8").split("\n");
const at = lines.findIndex((l) => /^\s*"ai"\s*:\s*\{[^}]*\}\s*,?\s*$/.test(l));
if (at < 0) {
  console.log("wrangler.jsonc has no single-line ai binding; copying it unchanged");
} else {
  lines.splice(at, 1);
  if (at > 0 && /^\s*\/\//.test(lines[at - 1])) lines.splice(at - 1, 1);
}
writeFileSync("wrangler.ci.jsonc", lines.join("\n"));
console.log("wrote wrangler.ci.jsonc");
