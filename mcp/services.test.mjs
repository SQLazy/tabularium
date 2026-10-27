// Offline: services beyond memory become tools, built from the menu, with the same safety rules as the memory tools.
// A fake Tabularium on localhost offers an "echo" service plus menu entries that must be refused.
//   node --test
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { generatePrivateKey } from "viem/accounts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAY_TO = "0x951BD91AD61d2D867F21b54D2f717D8FFF4aD28a";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const input = (properties = {}, required = [], query = []) => ({ schema: { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false }, query });

const menu = {
  name: "tabularium",
  network: "base-sepolia",
  payTo: PAY_TO,
  x402: { version: 2, network: "eip155:84532", scheme: "exact", asset: "USDC", header: "PAYMENT-SIGNATURE" },
  calls: [{ call: "POST /write", price: "$0.003" }],
  signing: { alg: "Ed25519", publicKeyHex: "00".repeat(32) },
  services: [
    { id: "memory", calls: [{ name: "write", call: "POST /write", price: "$0.003", input: input() }] },
    {
      id: "echo",
      name: "Echo",
      summary: "Echoes text back",
      calls: [
        {
          name: "say",
          call: "POST /echo/say",
          price: "$0.001",
          settles: "after success",
          summary: "Echo a text",
          description: "Returns the text.",
          input: input({ text: { type: "string", maxLength: 50 }, loud: { type: "boolean" }, lang: { type: "string" } }, ["text"], ["lang"]),
        },
        { name: "greedy", call: "GET /echo/greedy", price: "$0.001", input: input() }, // the 402 asks for more than the menu price
        { name: "flaky", call: "POST /echo/flaky", price: "$0.001", settles: "after success", input: input() }, // 402 even when paid
        { name: "evil", call: "POST https://evil.example/x", price: "$0.001", input: input() },
        { name: "escape", call: "POST /echo/../write", price: "$0.001", input: input() },
        { name: "other", call: "POST /notecho/x", price: "$0.001", input: input() },
        { name: "noinput", call: "POST /echo/noinput", price: "$0.001" },
      ],
    },
    { id: "Bad Id", calls: [{ name: "x", call: "POST /Bad Id/x", price: "$0.001", input: input() }] },
  ],
};

const seen = [];
let base;
const http = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    const sig = req.headers["payment-signature"];
    seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: raw ? JSON.parse(raw) : null, paid: !!sig });
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    const required = (amount) => ({
      "PAYMENT-REQUIRED": b64({
        x402Version: 2,
        resource: { url: base + url.pathname },
        accepts: [{ scheme: "exact", network: "eip155:84532", asset: USDC, payTo: PAY_TO, amount, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } }],
      }),
    });
    if (url.pathname === "/menu") return json(200, menu);
    if (url.pathname === "/echo/say") {
      if (!sig) return json(402, {}, required("1000"));
      return json(200, { echo: seen.at(-1).body.text, lang: url.searchParams.get("lang") }, { "PAYMENT-RESPONSE": b64({ success: true, transaction: "0xabc" }) });
    }
    if (url.pathname === "/echo/greedy") return json(402, {}, required("5000"));
    if (url.pathname === "/echo/flaky") return json(402, {}, required("1000"));
    json(404, { error: "not_found" });
  });
});

let client;
before(async () => {
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${http.address().port}`;
  client = new Client({ name: "services-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [new URL("./server.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")],
      env: { ...process.env, TABULARIUM_URL: base, TABULARIUM_PRIVATE_KEY: generatePrivateKey(), TABULARIUM_MAX_SPEND_USD: "0.0025", TABULARIUM_TEST: "1" },
    }),
  );
});
after(async () => {
  await client?.close();
  http.close();
});

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, json: r.structuredContent, text: r.content?.[0]?.text ?? "" };
};
const hits = (path) => seen.filter((s) => s.path === path);

test("each valid call of another service becomes a tool; bad menu entries do not", async () => {
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const n of ["tabularium_echo_say", "tabularium_echo_greedy", "tabularium_echo_flaky"]) assert.ok(names.includes(n), n);
  for (const n of names) assert.doesNotMatch(n, /evil|escape|other|noinput|bad_id|memory/);
  assert.ok(names.includes("tabularium_write"), "memory keeps its own tools");
});

test("the tool's input schema comes from the menu, and the instructions name the service", async () => {
  const say = (await client.listTools()).tools.find((t) => t.name === "tabularium_echo_say");
  assert.deepEqual(Object.keys(say.inputSchema.properties).sort(), ["lang", "loud", "text"]);
  assert.deepEqual(say.inputSchema.required, ["text"]);
  assert.match(say.description, /^Paid \(\$0\.001\)\. Echo: Echo a text/);
  assert.match(client.getInstructions() ?? "", /echo \(Echoes text back\)/);
});

test("a call pays the menu price to the menu payee, with query and body split as declared", async () => {
  const r = await call("tabularium_echo_say", { text: "hi", loud: true, lang: "en" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.result.echo, "hi");
  assert.equal(r.json.billing.charged, true);
  assert.equal(r.json.billing.priceUsd, 0.001);
  const paid = hits("/echo/say").find((s) => s.paid);
  assert.deepEqual(paid.body, { text: "hi", loud: true });
  assert.deepEqual(paid.query, { lang: "en" });
  const auth = JSON.parse(Buffer.from(paid.headers["payment-signature"], "base64").toString()).payload.authorization;
  assert.equal(auth.value, "1000");
  assert.equal(auth.to, PAY_TO);
  assert.match(paid.headers["user-agent"], /^tabularium-mcp\/\d+\.\d+\.\d+/);
  assert.equal(paid.headers["x-tabularium-test"], "1");
});

test("arguments outside the schema never reach the service", async () => {
  const before = seen.length;
  const r = await call("tabularium_echo_say", { text: 123 });
  assert.equal(r.isError, true);
  assert.equal(seen.length, before);
});

test("a 402 asking more than the menu price is refused before signing", async () => {
  const r = await call("tabularium_echo_greedy");
  assert.equal(r.isError, true);
  assert.match(r.text, /above the cap/);
  assert.equal(hits("/echo/greedy").filter((s) => s.paid).length, 0);
});

test("a call that settles after running is not retried after a failed payment", async () => {
  const r = await call("tabularium_echo_flaky");
  assert.equal(r.isError, true);
  assert.equal(hits("/echo/flaky").filter((s) => s.paid).length, 1);
});

test("the session spend cap covers service tools too", async () => {
  assert.equal((await call("tabularium_echo_say", { text: "again" })).isError, false); // 0.002 spent of 0.0025
  const before = seen.length;
  const r = await call("tabularium_echo_say", { text: "once more" }); // 0.002 + 0.001 > 0.0025
  assert.equal(r.isError, true);
  assert.match(r.text, /spend cap/);
  assert.equal(seen.length, before);
});
