// tabularium-mcp ships npm-shrinkwrap.json so `npx tabularium-mcp` installs exactly the dependency tree we tested.
// The payer's private key is in that process's environment, so a floating transitive dependency could read it.
import { readFileSync } from "node:fs";
import { assert, test } from "vitest";

const pkg = JSON.parse(readFileSync("mcp/package.json", "utf8"));
const lock = JSON.parse(readFileSync("mcp/npm-shrinkwrap.json", "utf8"));

test("the shrinkwrap is in the published files", () => {
  assert.include(pkg.files, "npm-shrinkwrap.json");
});

test("the shrinkwrap matches package.json (name, version, direct dependencies)", () => {
  assert.strictEqual(lock.name, pkg.name);
  assert.strictEqual(lock.version, pkg.version);
  assert.strictEqual(lock.packages[""].version, pkg.version);
  assert.deepEqual(lock.packages[""].dependencies, pkg.dependencies);
});

test("every locked package has an integrity hash and no dev-only entries ship", () => {
  const entries = Object.entries(lock.packages).filter(([k]) => k);
  assert.isAbove(entries.length, 50);
  for (const [k, v] of entries) {
    assert.ok(v.integrity, `${k} has no integrity`);
    assert.notOk(v.dev, `${k} is a dev dependency`);
  }
});
