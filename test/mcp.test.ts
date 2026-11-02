// Run with the rest of the suite: npm test (vitest).
// The fake forward stands in for the full app: it answers paid routes the way the x402 paywall does.
import { assert, test } from "vitest";
import { handleMcp, mcpTools, REMOTE_UA, type McpTool } from "../src/mcp";
import type { Service } from "../src/core/service";

const KEY = { type: "string", pattern: "^[A-Za-z0-9._:\\/-]{1,128}$" };
const svc = (s: Partial<Service>) => ({ serviceName: "x", tags: [], summary: "", llms: () => "", calls: [], ...s }) as Service;
const SERVICES: Service[] = [
  svc({
    id: "memory",
    serviceName: "Tabularium",
    calls: [
      { name: "write", method: "POST", path: "/write", price: "$0.003", description: "Append", discovery: {}, menu: {}, handler: null as never,
        openapi: { summary: "Write a key", requestBody: { content: { "application/json": { schema: { type: "object", required: ["key", "value"], properties: { key: KEY, value: { type: "string" }, idempotency_key: { type: "string" } } } } } } } },
      { name: "read", method: "GET", path: "/read", price: "$0.002", description: "Latest value", discovery: {}, menu: {}, handler: null as never,
        openapi: { summary: "Read a key", parameters: [{ name: "key", in: "query", required: true, schema: KEY }] } },
      { name: "renew", method: "POST", path: "/renew", price: "$0.25", upfront: true, description: "Extend the term", discovery: {}, menu: {}, handler: null as never, openapi: { summary: "Renew" } },
    ],
    free: [{ method: "GET", path: "/head", openapi: { summary: "Signed head", parameters: [{ name: "wallet", in: "query", required: true, schema: { type: "string" } }] }, handler: null as never }],
  }),
  svc({
    id: "snapshot",
    serviceName: "Tabularium Snapshot",
    calls: [{ name: "fetch", method: "POST", path: "/snapshot/fetch", price: "$0.005", description: "Signed page snapshot", discovery: {}, menu: {}, handler: null as never,
      openapi: { summary: "Fetch a page", requestBody: { content: { "application/json": { schema: { type: "object", required: ["url"], properties: { url: { type: "string" }, max_chars: { type: "integer" } } } } } } } }],
  }),
];
const tools = mcpTools(SERVICES);
// Paid tools forward to their own paid route, /mcp/<tool name> (see mcpRoutePath).
const PAID = new Set(["/mcp/tabularium_write", "/mcp/tabularium_read", "/mcp/tabularium_renew", "/mcp/tabularium_snapshot_fetch"]);
const b64 = (v: unknown) => btoa(JSON.stringify(v));
const unb64 = (s: string) => JSON.parse(atob(s));
const PAYLOAD = { x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453" }, payload: { signature: "0xsig", authorization: { from: "0x" + "ab".repeat(20), nonce: "0x" + "01".repeat(32) } } };

type Seen = { url: URL; method: string; headers: Headers; body: string };
function fakeApp(seen: Seen[], override?: (s: Seen) => Response | null) {
  return async (req: Request) => {
    const s = { url: new URL(req.url), method: req.method, headers: req.headers, body: await req.text() };
    seen.push(s);
    const o = override?.(s);
    if (o) return o;
    if (PAID.has(s.url.pathname) && !s.headers.get("PAYMENT-SIGNATURE")) {
      const pr = { x402Version: 2, error: "Payment required", resource: { url: s.url.href }, accepts: [{ scheme: "exact", amount: "3000", payTo: "0xpay" }] };
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64(pr), "content-type": "application/json" } });
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (PAID.has(s.url.pathname)) headers["PAYMENT-RESPONSE"] = b64({ success: true, transaction: "0xtx", network: "eip155:8453" });
    return new Response(JSON.stringify({ ok: true, path: s.url.pathname, query: Object.fromEntries(s.url.searchParams), body: s.body ? JSON.parse(s.body) : null }), { headers });
  };
}

async function rpc(msg: unknown, opts: { seen?: Seen[]; override?: (s: Seen) => Response | null; headers?: Record<string, string>; tools?: McpTool[] } = {}) {
  const seen = opts.seen ?? [];
  const res = await handleMcp(
    new Request("https://tabularium.example/mcp", { method: "POST", headers: { "content-type": "application/json", ...(opts.headers ?? {}) }, body: JSON.stringify(msg) }),
    { tools: opts.tools ?? tools, forward: fakeApp(seen, opts.override) },
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, seen };
}
const call = (name: string, args: unknown = {}, _meta?: unknown) => ({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args, ...(_meta ? { _meta } : {}) } });

test("tool names match tabularium-mcp and inputs come from the OpenAPI", () => {
  assert.deepEqual(tools.map((t) => t.name), ["tabularium_menu", "tabularium_head", "tabularium_write", "tabularium_read", "tabularium_renew", "tabularium_snapshot_fetch"]);
  const read = tools.find((t) => t.name === "tabularium_read")!;
  assert.deepEqual(read.query, ["key"]);
  assert.strictEqual(read.annotations.readOnlyHint, true);
  assert.deepEqual((read.inputSchema as { required: string[] }).required, ["key"]);
  assert.match(tools.find((t) => t.name === "tabularium_renew")!.description, /Settles before it runs/);
  assert.strictEqual(tools.find((t) => t.name === "tabularium_head")!.price, undefined);
});

test("initialize negotiates the protocol and needs no session", async () => {
  const r = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  assert.strictEqual(r.body.result.protocolVersion, "2025-03-26");
  assert.deepEqual(r.body.result.capabilities, { tools: { listChanged: false } });
  const later = await rpc({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2099-01-01" } });
  assert.strictEqual(later.body.result.protocolVersion, "2025-06-18");
});

test("notifications get 202 and GET gets 405", async () => {
  assert.strictEqual((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const res = await handleMcp(new Request("https://tabularium.example/mcp"), { tools, forward: fakeApp([]) });
  assert.strictEqual(res.status, 405);
});

test("an unpaid paid call returns the route's PaymentRequired as an error result", async () => {
  const r = await rpc(call("tabularium_write", { key: "a/b", value: "v" }));
  const res = r.body.result;
  assert.strictEqual(res.isError, true);
  assert.strictEqual(res.structuredContent.x402Version, 2);
  // The route's PaymentRequired, with resource.url pointing at the MCP endpoint (the Bazaar probes tools/call there).
  assert.strictEqual(res.structuredContent.resource.url, "https://tabularium.example/mcp");
  assert.strictEqual(r.seen[0].url.pathname, "/mcp/tabularium_write");
  assert.deepEqual(JSON.parse(res.content[0].text), res.structuredContent);
  assert.strictEqual(r.seen[0].headers.get("PAYMENT-SIGNATURE"), null);
});

test("a paid retry sends the payload as PAYMENT-SIGNATURE and returns the receipt", async () => {
  const r = await rpc(call("tabularium_write", { key: "a/b", value: "v", idempotency_key: "i1" }, { "x402/payment": PAYLOAD }));
  const [s] = r.seen;
  assert.strictEqual(s.method, "POST");
  assert.strictEqual(s.url.pathname, "/mcp/tabularium_write");
  assert.deepEqual(unb64(s.headers.get("PAYMENT-SIGNATURE")!), PAYLOAD);
  assert.deepEqual(JSON.parse(s.body), { key: "a/b", value: "v", idempotency_key: "i1" });
  assert.strictEqual(s.headers.get("user-agent"), REMOTE_UA);
  const res = r.body.result;
  assert.strictEqual(res.isError, undefined);
  assert.strictEqual(res.structuredContent.ok, true);
  assert.strictEqual(res._meta["x402/payment-response"].transaction, "0xtx");
});

test("GET tools put arguments in the query string and send no body", async () => {
  const r = await rpc(call("tabularium_read", { key: "a/b" }, { "x402/payment": PAYLOAD }));
  assert.strictEqual(r.seen[0].url.search, "?key=a%2Fb");
  assert.strictEqual(r.seen[0].body, "");
  assert.deepEqual(r.body.result.structuredContent.query, { key: "a/b" });
});

test("a route error comes back as an error result with its status", async () => {
  const r = await rpc(call("tabularium_write", { key: "k", value: "v", idempotency_key: "i1" }, { "x402/payment": PAYLOAD }), {
    override: () => new Response(JSON.stringify({ error: "idempotency_key_reuse" }), { status: 409 }),
  });
  assert.strictEqual(r.body.result.isError, true);
  assert.deepEqual(r.body.result.structuredContent, { status: 409, error: "idempotency_key_reuse" });
  assert.strictEqual(r.body.result._meta, undefined);
});

test("free tools never forward a payment", async () => {
  const r = await rpc(call("tabularium_head", { wallet: "0x1" }, { "x402/payment": PAYLOAD }));
  assert.strictEqual(r.seen[0].headers.get("PAYMENT-SIGNATURE"), null);
  assert.strictEqual(r.seen[0].url.pathname, "/head");
  assert.strictEqual(r.body.result.structuredContent.ok, true);
});

test("bad arguments are refused before anything is forwarded", async () => {
  for (const args of [{ key: "k" }, { key: "k", value: "v", extra: 1 }, [1]]) {
    const r = await rpc(call("tabularium_write", args));
    assert.strictEqual(r.body.result.isError, true, JSON.stringify(args));
    assert.strictEqual(r.seen.length, 0);
  }
  const r = await rpc(call("tabularium_write", { key: "k", value: "v" }, { "x402/payment": 5 }));
  assert.strictEqual(r.body.result.isError, true);
  assert.strictEqual(r.seen.length, 0);
});

test("protocol errors use JSON-RPC codes", async () => {
  assert.strictEqual((await rpc(call("nope"))).body.error.code, -32602);
  assert.strictEqual((await rpc({ jsonrpc: "2.0", id: 1, method: "resources/list" })).body.error.code, -32601);
  const res = await handleMcp(new Request("https://t.example/mcp", { method: "POST", body: "{" }), { tools, forward: fakeApp([]) });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(((await res.json()) as any).error.code, -32700);
});

test("forwards the caller's IP and the test marker, nothing else", async () => {
  const r = await rpc(call("tabularium_menu"), { headers: { "cf-connecting-ip": "203.0.113.9", "x-tabularium-test": "1", cookie: "s=1", authorization: "Bearer x" } });
  const h = r.seen[0].headers;
  assert.strictEqual(h.get("cf-connecting-ip"), "203.0.113.9");
  assert.strictEqual(h.get("x-tabularium-test"), "1");
  assert.strictEqual(h.get("cookie"), null);
  assert.strictEqual(h.get("authorization"), null);
});

test("oversized requests get 413", async () => {
  const big = "x".repeat(300 * 1024);
  const r = await rpc(call("tabularium_write", { key: "k", value: big }));
  assert.strictEqual(r.status, 413);
  assert.strictEqual(r.seen.length, 0);
});

test("batches from older clients still work", async () => {
  const r = await rpc([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }]);
  assert.strictEqual(r.body.length, 2);
  assert.strictEqual(r.body[1].result.tools.length, 6);
});

test("each paid tool has its own route and a valid type-mcp Bazaar declaration; free tools have neither", () => {
  for (const t of tools) {
    if (!t.price) {
      assert.strictEqual(t.route, undefined);
      continue;
    }
    assert.strictEqual(t.route, "/mcp/" + t.name);
    const input = (t.discovery as any).bazaar.info.input;
    assert.strictEqual(input.type, "mcp");
    assert.strictEqual(input.toolName, t.name);
    assert.strictEqual(input.transport, "streamable-http");
    assert.deepEqual(input.inputSchema, t.inputSchema);
  }
});
