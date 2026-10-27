import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// mcp/verify.mjs ships inside the npm package, so it is a copy. It must never drift from the real verifier.
describe("mcp verifier copy", () => {
  it("is byte-identical to verifier/verify.mjs", () => {
    const real = readFileSync(new URL("../verifier/verify.mjs", import.meta.url), "utf8");
    const copy = readFileSync(new URL("../mcp/verify.mjs", import.meta.url), "utf8");
    expect(copy).toBe(real);
  });
});
