// Starts a tabularium-mcp release. GitHub Actions does the rest (.github/workflows/release-mcp.yml): tests, npm
// publish (trusted publishing, no token or 2FA), MCP Registry publish (GitHub OIDC), then a check of the published
// package from a clean install.
//   node scripts/release-mcp.mjs 0.5.1          bump, test, commit, tag mcp-v0.5.1, push
//   node scripts/release-mcp.mjs 0.5.1 --dry    bump and test only; nothing committed or pushed
import { execFileSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [version, flag] = process.argv.slice(2);
const dry = flag === "--dry";
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("usage: node scripts/release-mcp.mjs <x.y.z> [--dry]");
  process.exit(2);
}
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
// Fixed command strings only (no user input reaches a shell).
const run = (command, cwd) => execSync(command, { cwd, stdio: "inherit" });

if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") throw new Error("release from main only");
if (git("status", "--porcelain")) throw new Error("working tree not clean: commit or stash first");
git("fetch", "origin", "main", "--tags");
if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main")) throw new Error("main is not at origin/main: pull or push first");
if (git("tag", "-l", `mcp-v${version}`)) throw new Error(`tag mcp-v${version} already exists`);

const pkgPath = "mcp/package.json";
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const cmp = (a, b) => a.split(".").map(Number).reduce((r, n, i) => r || n - b.split(".").map(Number)[i], 0);
if (cmp(version, pkg.version) <= 0) throw new Error(`${version} is not above the current ${pkg.version}`);

// The two files that must agree: the npm package and the MCP Registry entry (its version and its npm package's).
pkg.version = version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
const srvPath = "mcp/server.json";
const srv = JSON.parse(readFileSync(srvPath, "utf8"));
srv.version = version;
for (const p of srv.packages ?? []) if (p.identifier === pkg.name) p.version = version;
writeFileSync(srvPath, JSON.stringify(srv, null, 2) + "\n");
console.log(`set ${pkg.name} and server.json to ${version}`);

run("npm test", "mcp");
run("npx vitest run", ".");
if (dry) {
  console.log("dry run: files bumped and tests passed; nothing committed. Revert with: git checkout mcp/package.json mcp/server.json");
  process.exit(0);
}
git("add", pkgPath, srvPath);
git("commit", "-m", `tabularium-mcp ${version}`, "-m", "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>");
git("tag", "-a", `mcp-v${version}`, "-m", `tabularium-mcp ${version}`);
git("push", "origin", "main");
git("push", "origin", `mcp-v${version}`);
console.log(`pushed mcp-v${version}: the Release MCP workflow publishes it. Watch: https://github.com/SQLazy/tabularium/actions`);
