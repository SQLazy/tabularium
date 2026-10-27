// A service is one partition of the platform: its own paid calls, free routes, docs and line in /stats.
// Everything else (payment, payer identity, one-payment-one-call, stats, the funnel, discovery files) is shared.
import type { C } from "./identity";
import type { Env } from "../env";

export interface PaidCall {
  /** Unique within its service; the name /stats reports it under. */
  name: string;
  method: "GET" | "POST";
  /** Full path. New services live under /<service id>/...; memory keeps its original root paths. */
  path: string;
  /** USDC, e.g. "$0.003". */
  price: string;
  /** The x402 route description (shown in the 402 and on the Bazaar). */
  description: string;
  /** Bazaar discovery extension for this route. */
  discovery: Record<string, unknown>;
  /** Settle before the handler runs (worth it for higher-priced calls); pair with a free precheck. */
  upfront?: boolean;
  /** Free check run on the paid attempt before anything settles; return a Response to refuse for free. */
  precheck?: (c: C, wallet: string) => Promise<Response | null>;
  /** The OpenAPI operation, without security and x-payment-info (the platform adds those from price). */
  openapi: Record<string, unknown>;
  /** Line in /menu. */
  menu: Record<string, unknown>;
  /** Runs only for a verified payer whose payment has not been used before. */
  handler: (c: C, wallet: string) => Promise<Response>;
}

export interface FreeRoute {
  method: "GET" | "POST";
  path: string;
  /** Line in /menu's free list, e.g. "GET /head?wallet=0x..."; defaults to "METHOD /path". */
  menu?: string;
  openapi: Record<string, unknown>;
  handler: (c: C) => Promise<Response> | Response;
}

export interface Service {
  /** Stable id: the /stats key and the path prefix for new services. Never rename. */
  id: string;
  /** Bazaar service name (<= 32 ASCII chars) and tags (<= 5). */
  serviceName: string;
  tags: string[];
  summary: string;
  calls: PaidCall[];
  free?: FreeRoute[];
  /** This service's part of /llms.txt. */
  llms: (env: Env, origin: string) => string;
}

export const usd = (price: string) => price.replace(/^\$/, "");
export const micro = (price: string) => Math.round(Number(usd(price)) * 1e6);
