import type { Stats } from "./stats";
import type { Workspace } from "./workspace";

export interface Env {
  WORKSPACE: DurableObjectNamespace<Workspace>;
  /** One global instance: settled-call counts for the success metric. */
  STATS: DurableObjectNamespace<Stats>;
  /** Comma-separated wallets left out of /stats (our own test payers). */
  EXCLUDE_WALLETS?: string;
  /** Address that receives USDC. */
  PAY_TO: `0x${string}`;
  /** "base-sepolia" while testing, "base" in production. */
  NETWORK: "base-sepolia" | "base";
  /** Defaults to the public testnet facilitator. The CDP URL (src/cdp.ts) switches on CDP auth. */
  FACILITATOR_URL?: string;
  /** CDP secret API key (Ed25519). Secrets; required only with the CDP facilitator. */
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  /** Ed25519 private key, PKCS8, base64. Secret. */
  SIGNING_KEY_PKCS8: string;
  /** Matching raw public key, hex. Public, published at /menu. */
  SIGNING_PUBKEY_HEX: string;
}
