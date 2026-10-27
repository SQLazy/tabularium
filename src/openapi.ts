// /openapi.json: machine-readable discovery for agent wallets and x402 explorers (x402scan, AgentCash).
// Follows the Agentcash Discovery v1 profile: OpenAPI 3.1, `security: []` (no API key), and `x-payment-info`
// on each paid operation. Built from every service's calls and live prices, so it cannot drift from /menu or /llms.txt.
// Discovery metadata is advisory; the 402 challenge on each paid route is the authority.
import type { Env } from "./env";
import { POLICY } from "./policy";
import { usd, type Service } from "./core/service";
import { SERVICES } from "./services";

const DAY = 86_400_000;
const PAYMENT_REQUIRED = {
  description: "Payment required (x402 v2). The PAYMENT-REQUIRED header lists the accepted USDC payment; repeat the request with PAYMENT-SIGNATURE.",
};
const freeOp = (operationId: string, summary: string, description: string) => ({ get: { operationId, summary, security: [], responses: { "200": { description } } } });

export function openApi(env: Env, origin: string, services: Service[] = SERVICES) {
  const chain = env.NETWORK === "base" ? "Base mainnet (eip155:8453)" : "Base Sepolia testnet (eip155:84532)";
  const paths: Record<string, Record<string, unknown>> = {};
  const add = (path: string, method: string, op: unknown) => ((paths[path] ??= {})[method.toLowerCase()] = op);
  for (const s of services) {
    for (const call of s.calls) {
      const op = call.openapi as { responses?: Record<string, unknown> };
      add(call.path, call.method, {
        ...op,
        tags: [s.id],
        security: [],
        "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: usd(call.price) }, protocols: [{ x402: {} }] },
        responses: { ...op.responses, "402": PAYMENT_REQUIRED },
      });
    }
    for (const f of s.free ?? []) add(f.path, f.method, { ...f.openapi, tags: [s.id], security: [] });
  }
  Object.assign(paths, {
    "/menu": freeOp("menu", "Free: prices, policy, network, payee and the public signing key", "The menu (JSON)"),
    "/stats": freeOp("stats", "Free: public aggregates of settled calls and the demand funnel, per service", "Stats (JSON)"),
    "/llms.txt": freeOp("llmsTxt", "Free: plain-text guide for language models", "text/plain"),
  });
  return {
    openapi: "3.1.0",
    info: {
      title: "Tabularium",
      version: "1.0.0",
      summary: "Persistent, hash-chained memory for AI agents, plus a signed ledger of what an agent buys.",
      description:
        `Pay-per-call agent memory over x402 v2, in USDC on ${chain}. No account or API key: the paying wallet is the ` +
        `identity and owns one workspace. Every write is appended to a hash chain whose head is signed (Ed25519), so an ` +
        `export verifies offline without trusting the server. Values up to ${POLICY.MAX_VALUE_BYTES / 1024} KB; the ` +
        `operator can read stored values, so encrypt secrets first. Failed calls (4xx/5xx) are not charged.`,
      "x-guidance":
        `First write opens a ${POLICY.TERM_MS / DAY}-day workspace; renew adds ${POLICY.TERM_MS / DAY} days. ` +
        `Pass idempotency_key on writes so a retry never appends twice. Full guide: ${origin}/llms.txt`,
      license: { name: "FSL-1.1-MIT (service); MIT (MCP client, verifier)", url: "https://github.com/SQLazy/tabularium#license" },
    },
    tags: services.map((s) => ({ name: s.id, description: s.summary })),
    externalDocs: { description: "Source, verifier and MCP client", url: "https://github.com/SQLazy/tabularium" },
    "x-agentcash-guidance": { llmsTxtUrl: `${origin}/llms.txt` },
    servers: [{ url: origin }],
    paths,
  };
}
