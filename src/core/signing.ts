import type { Env } from "../env";
import { loadSigningKey } from "../chain";

// The server's Ed25519 key, shared by every service. Loaded once per isolate; reloaded if the secret changes.
let cached: { src: string; pub: string; key: CryptoKey } | null = null;
export async function signingKey(env: Env): Promise<CryptoKey> {
  const src = (env.SIGNING_KEY_PKCS8 ?? "").trim();
  const pub = (env.SIGNING_PUBKEY_HEX ?? "").trim();
  if (!cached || cached.src !== src || cached.pub !== pub) {
    cached = { src, pub, key: await loadSigningKey(src, pub) };
  }
  return cached.key;
}
