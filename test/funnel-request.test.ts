// Which unpaid requests count as "carried a real request": the number docs/PRICING.md decides the price on.
import { describe, expect, it } from "vitest";
import { carriesRequest } from "../src/core/funnel";

const snapExample = { url: "https://example.com/" };
const post = (body: unknown, example: unknown = snapExample) => carriesRequest({ method: "POST", query: "", body, example });
const get = (query: string, example: unknown = { key: "notes/today" }) => carriesRequest({ method: "GET", query, body: undefined, example });

describe("carriesRequest", () => {
  it("a page an agent wants read counts", () => expect(post({ url: "https://news.ycombinator.com/item?id=1" })).toBe(true));
  it("extra options on the example page count (someone is using it)", () => expect(post({ url: "https://example.com/", max_chars: 2000 })).toBe(true));
  it.each([
    ["no body", undefined],
    ["empty object", {}],
    ["empty strings", { url: "" }],
    ["an array", [1, 2]],
    ["a string", "hello"],
    ["the listing's own example", { url: "https://example.com/" }],
  ])("a probe does not count: %s", (_what, body) => expect(post(body)).toBe(false));
  it("the example matches regardless of key order", () => {
    expect(carriesRequest({ method: "POST", query: "", body: { b: 2, a: 1 }, example: { a: 1, b: 2 } })).toBe(false);
  });
  it("without a published example, any filled body counts", () => expect(post({ key: "x", value: "y" }, undefined)).toBe(true));

  it("a GET with its own query counts", () => expect(get("?key=notes/monday")).toBe(true));
  it.each(["", "?", "?key=", "?key=notes/today"])("a GET probe does not count: %s", (q) => expect(get(q)).toBe(false));
});
