// LOCAL TESTING ONLY. Same handlers as production, with two differences:
//  1. the x402 paywall is removed so the e2e script can exercise state logic without a facilitator;
//  2. Workspace is subclassed to open an async gap between "read chain head" and "insert entry",
//     the exact window where an unserialized write path forks the chain. Production has no such gap
//     today, so this makes the concurrency test bite against future async work (R2, fetch) too.
// Referenced only by wrangler.dev.jsonc; never by the production config, so it cannot ship by accident.
import { createApp } from "./app";
import { htmlTables, htmlToText } from "./services/snapshot";
import { checkPage, finishTables } from "./services/snapshot-core";
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
const app = createApp({ paywall: false });

// Dev only: POST raw HTML to /__dev/read-html and get back what the snapshot reader makes of it. The live fetcher
// refuses local and self URLs, so this is how e2e feeds the HTML reader pages with hidden text it wrote itself.
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method === "POST" && new URL(req.url).pathname === "/__dev/read-html") {
      const bytes = new Uint8Array(await req.arrayBuffer());
      const read = await htmlToText(bytes, "text/html; charset=utf-8");
      return Response.json({ title: read.title, ...checkPage(read) });
    }
    if (req.method === "POST" && new URL(req.url).pathname === "/__dev/read-tables") {
      const bytes = new Uint8Array(await req.arrayBuffer());
      return Response.json(finishTables(await htmlTables(bytes, "text/html; charset=utf-8"), 20));
    }
    return app.fetch(req, env, ctx);
  },
};
