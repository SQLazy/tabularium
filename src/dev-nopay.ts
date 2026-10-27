// LOCAL TESTING ONLY. Same handlers as production, with two differences:
//  1. the x402 paywall is removed so the e2e script can exercise state logic without a facilitator;
//  2. Workspace is subclassed to open an async gap between "read chain head" and "insert entry",
//     the exact window where an unserialized write path forks the chain. Production has no such gap
//     today, so this makes the concurrency test bite against future async work (R2, fetch) too.
// Referenced only by wrangler.dev.jsonc; never by the production config, so it cannot ship by accident.
import { createApp } from "./app";
import { Workspace as Base } from "./workspace";
import type { Entry } from "./chain";

export class Workspace extends Base {
  protected override async nextEntry(now: number, op: Entry["op"], key: string, valueHash: string): Promise<Entry> {
    const entry = await super.nextEntry(now, op, key, valueHash);
    await new Promise((r) => setTimeout(r, 5));
    return entry;
  }
}

export { Stats } from "./stats";
export default createApp({ paywall: false });
