// Remote MCP endpoint: POST /mcp, Streamable HTTP, stateless, JSON replies only (no SSE, no sessions).
//
// Every tool is a thin forwarder to an existing HTTP route. A tools/call becomes an internal request to that route,
// so the paywall, payerOf, claimPayment, prechecks and /stats all apply exactly as they do over HTTP. Payment follows
// the x402 MCP transport (x402 specs/transports-v2/mcp.md):
//   - unpaid call to a paid tool  -> tool result { isError: true, structuredContent: PaymentRequired }
//   - client retries with params._meta["x402/payment"] (a PaymentPayload) -> sent on as the PAYMENT-SIGNATURE header
//   - the route's PAYMENT-RESPONSE header comes back as result._meta["x402/payment-response"]
//
// The PaymentRequired is the HTTP route's own, unchanged (its resource is the route URL), so the payload a client
// signs is exactly what the route verifies. Tool names match tabularium-mcp, so one prompt works with either.
//
// No dependencies: this file uses only web-standard Request/Response, so it runs (and is tested) outside Workers.
import { callInput, type PaidCall, type Service } from "./core/service";
import { PAYMENT_HEADER } from "./core/identity";
import { TEST_HEADER } from "./core/funnel";

export const MCP_PATH = "/mcp";
export const MCP_VERSION = "0.1.0";
/** Inner requests carry this User-Agent, so /stats counts remote MCP traffic as its own client family. */
export const REMOTE_UA = `tabularium-remote-mcp/${MCP_VERSION}`;
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
// A 64 KB value can double in size when JSON-escaped, plus the payment payload and the envelope.
const MAX_BODY_BYTES = 256 * 1024;
const PAY_META = "x402/payment";
const RECEIPT_META = "x402/payment-response";

type Json = Record<string, unknown>;

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  annotations: Json;
  method: "GET" | "POST";
  path: string;
  /** Argument names sent in the query string; the rest go in the JSON body. */
  query: string[];
  /** Set for paid tools only. */
  price?: string;
}

const toolName = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 64);
const prefixOf = (s: Service) => (s.id === "memory" ? "tabularium_" : `tabularium_${s.id}_`);

/** One tool per paid call and free route on the platform, plus tabularium_menu. */
export function mcpTools(services: Service[]): McpTool[] {
  const tools: McpTool[] = [
    {
      name: "tabularium_menu",
      title: "Tabularium: menu",
      description: "Free. Prices, payee, network, policy (term, grace, size limits) and the signing key for every call.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      method: "GET",
      path: "/menu",
      query: [],
    },
  ];
  for (const s of services) {
    for (const f of s.free ?? []) {
      const { schema, query } = callInput({ method: f.method, path: f.path, openapi: f.openapi } as PaidCall);
      const summary = (f.openapi as { summary?: string }).summary ?? "";
      tools.push({
        name: toolName(prefixOf(s) + (f.path.split("/").pop() ?? "")),
        title: `${s.serviceName}: ${f.path}`.slice(0, 100),
        description: `Free. ${summary}`.trim(),
        inputSchema: schema,
        annotations: { readOnlyHint: f.method === "GET", openWorldHint: false },
        method: f.method,
        path: f.path,
        query: f.method === "GET" ? Object.keys((schema.properties as Json) ?? {}) : query,
      });
    }
    for (const call of s.calls) {
      const { schema, query } = callInput(call);
      const summary = (call.openapi as { summary?: string }).summary ?? "";
      const settles = call.upfront ? "Settles before it runs (a free check refuses a call that would fail)." : "Charged only if it succeeds.";
      tools.push({
        name: toolName(prefixOf(s) + call.name),
        title: `${s.serviceName}: ${call.name}`.slice(0, 100),
        description:
          `Paid (${call.price} USDC on Base, x402). ${summary}. ${call.description}. ${settles} ` +
          `Call once without payment to get the price, then retry with params._meta["${PAY_META}"].`.replace(/\.\s*\./g, "."),
        inputSchema: schema,
        annotations: { readOnlyHint: call.method === "GET", openWorldHint: true },
        method: call.method,
        path: call.path,
        query,
        price: call.price,
      });
    }
  }
  const seen = new Set<string>();
  for (const t of tools) {
    if (seen.has(t.name)) throw new Error(`duplicate MCP tool name ${t.name}`);
    seen.add(t.name);
  }
  return tools;
}

// ---- base64 of JSON (UTF-8 safe) --------------------------------------------------------------
function b64json(v: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(v));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function unb64json(s: string | null): Json | null {
  if (!s) return null;
  try {
    const bin = atob(s);
    const v = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0))));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
}

// ---- JSON-RPC ---------------------------------------------------------------------------------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, accept, mcp-protocol-version, mcp-session-id",
};
const reply = (body: unknown, status = 200) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...CORS, ...(body === null ? {} : { "content-type": "application/json" }) },
  });
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const text = (v: unknown) => [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v) }];
const toolError = (message: string, extra: Json = {}) => ({ isError: true, content: text(message), structuredContent: { error: message, ...extra } });

export interface McpOptions {
  tools: McpTool[];
  /** Runs an internal request through the full app (paywall included). */
  forward: (req: Request) => Promise<Response>;
}

export async function handleMcp(req: Request, opts: McpOptions): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  // Stateless server: no SSE stream to open (GET) and no session to end (DELETE).
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { ...CORS, Allow: "POST, OPTIONS" } });
  // Origin is not checked: the endpoint is public, uses no cookies or ambient credentials, and every paid call needs
  // a signature the caller makes for that call, so a page that calls it from a browser gains nothing.
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return reply(rpcError(null, -32600, "request too large"), 413);
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return reply(rpcError(null, -32600, "request too large"), 413);
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return reply(rpcError(null, -32700, "parse error"), 400);
  }
  if (Array.isArray(msg)) {
    // Batches were dropped in protocol 2025-06-18 but older clients may still send them.
    if (msg.length === 0 || msg.length > 20) return reply(rpcError(null, -32600, "batch must hold 1 to 20 messages"), 400);
    const out = (await Promise.all(msg.map((m) => handleOne(m, req, opts)))).filter((r) => r !== null);
    return out.length ? reply(out) : reply(null, 202);
  }
  const out = await handleOne(msg, req, opts);
  return out === null ? reply(null, 202) : reply(out);
}

async function handleOne(m: unknown, req: Request, opts: McpOptions): Promise<Json | null> {
  if (!m || typeof m !== "object") return rpcError(null, -32600, "invalid request");
  const { jsonrpc, id, method, params } = m as Json;
  if (typeof method !== "string") return null; // a response to us: we never send requests, so nothing to match
  const isRequest = id !== undefined && id !== null;
  if (!isRequest) return null; // notifications (initialized, cancelled) need no answer
  if (jsonrpc !== "2.0") return rpcError(id, -32600, "jsonrpc must be 2.0");
  const p = (params && typeof params === "object" ? params : {}) as Json;
  switch (method) {
    case "initialize": {
      const asked = typeof p.protocolVersion === "string" ? p.protocolVersion : "";
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "tabularium", title: "Tabularium", version: MCP_VERSION },
          instructions:
            "Pay-per-call memory and web snapshots. Your wallet is your account: every paid call is an x402 payment " +
            "in USDC on Base, and the paying wallet owns the data. Call tabularium_menu (free) for prices and policy.",
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: opts.tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })),
        },
      };
    case "tools/call": {
      const tool = opts.tools.find((t) => t.name === p.name);
      if (!tool) return rpcError(id, -32602, `unknown tool: ${String(p.name)}`);
      return { jsonrpc: "2.0", id, result: await callTool(tool, p, req, opts) };
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

async function callTool(tool: McpTool, p: Json, outer: Request, opts: McpOptions): Promise<Json> {
  const args = (p.arguments ?? {}) as Json;
  if (typeof args !== "object" || Array.isArray(args)) return toolError("arguments must be an object");
  // Shallow checks only, so a bad call never reaches the paywall. The route validates everything else for free.
  const props = (tool.inputSchema.properties ?? {}) as Json;
  for (const k of Object.keys(args)) if (!(k in props)) return toolError(`unknown argument: ${k}`);
  for (const k of (tool.inputSchema.required ?? []) as string[]) if (args[k] === undefined) return toolError(`missing argument: ${k}`);

  const url = new URL(tool.path, new URL(outer.url).origin);
  const body: Json = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    if (tool.query.includes(k)) url.searchParams.set(k, String(v));
    else body[k] = v;
  }
  const headers = new Headers({ accept: "application/json", "user-agent": REMOTE_UA });
  for (const h of ["cf-connecting-ip", TEST_HEADER]) {
    const v = outer.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (tool.price) {
    const pay = ((p._meta ?? {}) as Json)[PAY_META];
    if (pay !== undefined) {
      if (typeof pay === "string") headers.set(PAYMENT_HEADER, pay); // already in header form
      else if (pay && typeof pay === "object") headers.set(PAYMENT_HEADER, b64json(pay));
      else return toolError(`_meta["${PAY_META}"] must be a PaymentPayload object`);
    }
  }
  const hasBody = tool.method === "POST";
  if (hasBody) headers.set("content-type", "application/json");
  const res = await opts.forward(new Request(url, { method: tool.method, headers, body: hasBody ? JSON.stringify(body) : undefined }));

  const receipt = unb64json(res.headers.get("PAYMENT-RESPONSE"));
  const meta = receipt ? { _meta: { [RECEIPT_META]: receipt } } : {};
  const required = res.status === 402 ? unb64json(res.headers.get("PAYMENT-REQUIRED")) : null;
  if (required) return { isError: true, structuredContent: required, content: text(required), ...meta };

  const raw = await res.text();
  let data: unknown = raw;
  try {
    data = JSON.parse(raw);
  } catch {
    /* plain text */
  }
  const structured = data && typeof data === "object" && !Array.isArray(data) ? (data as Json) : { value: data };
  if (res.status >= 400) return { isError: true, structuredContent: { status: res.status, ...structured }, content: text(data), ...meta };
  return { structuredContent: structured, content: text(data), ...meta };
}
