// The snapshot service: fetch a public web page for the paying agent and return its text with a signed record of
// what was served, from where, and when. Charged only when a page comes back (HTTP 2xx from the site).
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { b64encode, sha256Hex } from "../chain";
import { SNAPSHOT_PRICES } from "../policy";
import type { C } from "../core/identity";
import { signingKey } from "../core/signing";
import type { Service } from "../core/service";
import {
  CHECKS_NOTE,
  FETCH_UA,
  TargetError,
  checkPage,
  checkTarget,
  decodeEntities,
  csvTable,
  documentFormat,
  documentHasText,
  documentName,
  finishTables,
  hiddenReason,
  isTextual,
  markdownTables,
  scrubInvisible,
  robotsAllows,
  snapshotMessage,
  tidyDocument,
  tidyText,
  type PageChecks,
  type PageRead,
  type RawTable,
  TABLE_LIMITS,
  type Table,
  type Snapshot,
} from "./snapshot-core";

export const SNAPSHOT_LIMITS = {
  MAX_BYTES: 5 * 1024 * 1024,
  DEFAULT_CHARS: 50_000,
  MIN_CHARS: 1_000,
  MAX_CHARS: 200_000,
  MAX_REDIRECTS: 5,
  TIMEOUT_MS: 20_000,
  ROBOTS_MAX_BYTES: 512 * 1024,
};

type Fail = { status: 400 | 403 | 413 | 415 | 424 | 502; error: string; detail?: Record<string, unknown> };

/**
 * A document to markdown with Workers AI toMarkdown. Embedded images are not described (that would use paid
 * models); the converter's own failures come back as { error } and the call is not charged.
 */
async function convertDocument(ai: Ai, name: string, mime: string, raw: Uint8Array): Promise<{ data: string } | { error: string }> {
  try {
    const out = await ai.toMarkdown(
      { name, blob: new Blob([raw], { type: mime }) },
      { conversionOptions: { pdf: { metadata: false, images: { convert: false } }, docx: { images: { convert: false } } } },
    );
    if (out.format === "error") return { error: String(out.error).slice(0, 200) };
    return { data: out.data };
  } catch (err) {
    return { error: err instanceof Error ? err.message.slice(0, 200) : "converter_error" };
  }
}
const fail = (status: Fail["status"], error: string, detail?: Record<string, unknown>): Fail => ({ status, error, detail });

/** Reads at most `cap` bytes; null if the body is larger. */
async function readCapped(res: Response, cap: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel();
    return null;
  }
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

// robots.txt per origin, cached in this isolate for 10 minutes (plain strings only, never a pending promise).
const robotsCache = new Map<string, { at: number; txt: string }>();
/** Tests only: forget cached robots.txt files. */
export const clearRobotsCache = () => robotsCache.clear();
async function robotsFor(origin: string, deadline: number): Promise<string> {
  const hit = robotsCache.get(origin);
  if (hit && Date.now() - hit.at < 600_000) return hit.txt;
  let txt = "";
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { "user-agent": FETCH_UA, accept: "text/plain" },
      redirect: "follow",
      signal: AbortSignal.timeout(Math.max(1000, Math.min(5000, deadline - Date.now()))),
    });
    // 4xx: no robots.txt, everything allowed. 5xx or a network error: also treated as allowed (RFC 9309 lets a
    // crawler assume full disallow; for a single user-requested page we choose to try and let the site answer).
    if (res.ok) txt = new TextDecoder().decode((await readCapped(res, SNAPSHOT_LIMITS.ROBOTS_MAX_BYTES)) ?? new Uint8Array());
    else await res.body?.cancel();
  } catch {
    txt = "";
  }
  if (robotsCache.size > 500) robotsCache.clear();
  robotsCache.set(origin, { at: Date.now(), txt });
  return txt;
}

/** Follows up to MAX_REDIRECTS, re-checking every hop's URL and robots.txt. Exported for tests. */
export async function fetchPage(start: URL, selfHost: string): Promise<{ res: Response; finalUrl: URL } | Fail> {
  const deadline = Date.now() + SNAPSHOT_LIMITS.TIMEOUT_MS;
  let url = start;
  for (let hop = 0; hop <= SNAPSHOT_LIMITS.MAX_REDIRECTS; hop++) {
    if (!robotsAllows(await robotsFor(url.origin, deadline), url.pathname + url.search)) {
      return fail(403, "robots_disallowed", { url: url.href, note: "the site's robots.txt does not allow this path for TabulariumSnapshot or *" });
    }
    let res: Response;
    try {
      res = await fetch(url.href, {
        headers: { "user-agent": FETCH_UA, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5" },
        redirect: "manual",
        signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
      });
    } catch (err) {
      return fail(502, "fetch_failed", { url: url.href, reason: err instanceof Error ? err.name : "error" });
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await res.body?.cancel();
      try {
        url = checkTarget(new URL(res.headers.get("location")!, url).href, selfHost);
      } catch (err) {
        return fail(400, err instanceof TargetError ? `redirect_${err.code}` : "redirect_bad_url", { from: url.href });
      }
      continue;
    }
    return { res, finalUrl: url };
  }
  return fail(502, "too_many_redirects", { max: SNAPSHOT_LIMITS.MAX_REDIRECTS });
}

const BLOCK = "p,div,section,article,main,aside,header,footer,nav,li,ul,ol,dl,dt,dd,table,tr,h1,h2,h3,h4,h5,h6,pre,blockquote,figure,figcaption,form,hr,br,address,details,summary";
const BLOCKS = new Set(BLOCK.split(","));
const SKIP = "script,style,noscript,template,svg,iframe,object,embed,canvas,select,button";
const NL = "\n";

/**
 * HTML to readable text with HTMLRewriter (streaming, no DOM), in three passes: read the <title>; drop <head>,
 * scripts, styles and other non-text elements; collect the remaining text with line breaks at block elements.
 * Nothing depends on an end tag being present, so sloppy HTML cannot hide the page's text.
 */
export async function htmlToText(bytes: Uint8Array, contentType: string): Promise<PageRead & { title: string }> {
  const asResponse = () => new Response(bytes, { headers: { "content-type": contentType || "text/html" } });
  let title = "";
  let titles = 0;
  await new HTMLRewriter()
    .on("title", {
      element: () => void titles++,
      text: (t) => void (titles === 1 && (title += t.text)),
    })
    .transform(asResponse())
    .arrayBuffer();

  // Text inside an element a person would not see goes to `hidden` instead of `parts`. Depth is only raised for an
  // element whose end tag can be watched, so a void element cannot leave the rest of the page marked hidden.
  const parts: string[] = [];
  const hidden: string[] = [];
  const reasons = new Set<string>();
  let hiddenDepth = 0;
  let comments = "";
  const out = () => (hiddenDepth > 0 ? hidden : parts);
  const stripped = new HTMLRewriter().on(`head,${SKIP}`, { element: (e) => void e.remove() }).transform(asResponse());
  // One handler for every element: an element keeps only the last end-tag callback registered on it, so a separate
  // block-element handler replaced the one that closes a hidden section (found by e2e, 2026-11-07).
  await new HTMLRewriter()
    .on("*", {
      element(e) {
        const why = hiddenReason(e.getAttribute("style"), e.hasAttribute("hidden"));
        const block = BLOCKS.has(e.tagName);
        if (block) {
          out().push(NL);
          if (/^h[1-6]$/.test(e.tagName)) out().push("#".repeat(Number(e.tagName[1])) + " ");
          if (e.tagName === "li") out().push("- ");
        }
        if (!why && !block) return;
        try {
          e.onEndTag(() => {
            if (block) out().push(NL);
            if (why) hiddenDepth = Math.max(0, hiddenDepth - 1);
          });
        } catch {
          return; // void element (<br>, <img hidden>): no end tag and no text inside
        }
        if (why) {
          hiddenDepth++;
          reasons.add(why);
          hidden.push(NL);
        }
      },
    })
    .onDocument({
      text: (t) => void out().push(t.text),
      comments: (c) => void (comments.length < 20_000 && (comments += c.text + NL)),
    })
    .transform(stripped)
    .arrayBuffer();
  return {
    text: tidyText(decodeEntities(parts.join(""))),
    hidden: tidyText(decodeEntities(hidden.join(""))),
    reasons: [...reasons].sort(),
    comments: decodeEntities(comments),
    title: decodeEntities(title).replace(/\s+/g, " ").trim().slice(0, 300),
  };
}

const TABLE_PARTS = new Set(["thead", "tbody", "tfoot", "tr", "td", "th"]);

/**
 * Tables in an HTML page, with HTMLRewriter. Rows inside elements hidden from people are skipped, like hidden text
 * in /snapshot/fetch. Only top-level tables become tables; a table nested in a cell adds its text to that cell.
 * Cells and rows do not need end tags (HTML lets </td> and </tr> be left out). One handler per element: an element
 * keeps only its last end-tag callback.
 */
export async function htmlTables(bytes: Uint8Array, contentType: string): Promise<RawTable[]> {
  const asResponse = () => new Response(bytes, { headers: { "content-type": contentType || "text/html" } });
  const tables: RawTable[] = [];
  let depth = 0;
  let hiddenDepth = 0;
  let cur: RawTable | null = null;
  let row: RawTable["rows"][number] | null = null;
  let cell: { text: string; span: number } | null = null;
  let inCaption = false;
  // Rows, cells and table sections may leave out their end tags, so a hidden one cannot be closed by its end tag:
  // it ends where the next one of its kind starts (found by e2e: a hidden <tr> without </tr> swallowed every
  // following row). Other hidden elements use hiddenDepth, raised only when an end tag will lower it again.
  let sectionHidden = false;
  let rowHidden = false;
  let cellHidden = false;
  const stripped = new HTMLRewriter().on(`head,${SKIP}`, { element: (e) => void e.remove() }).transform(asResponse());
  await new HTMLRewriter()
    .on("*", {
      element(e) {
        const tag = e.tagName;
        const why = hiddenReason(e.getAttribute("style"), e.hasAttribute("hidden"));
        const structural = depth === 1 && TABLE_PARTS.has(tag);
        const outerHidden = hiddenDepth > 0;
        const isTable = tag === "table";
        // Text arrives in chunks that can split a word, so spaces go in at element boundaries only: block elements,
        // and the cells of a table nested inside this cell. Inline tags (<b>, <a>, <span>) join their text.
        if (cell && (BLOCKS.has(tag) || ((tag === "td" || tag === "th") && depth > 1))) cell.text += " ";
        if (isTable) {
          depth++;
          if (depth === 1) {
            cur = outerHidden || why ? null : { caption: "", rows: [] };
            if (cur) tables.push(cur);
            row = null;
            cell = null;
            sectionHidden = rowHidden = cellHidden = false;
          }
        }
        if (depth === 1 && cur && !outerHidden) {
          if (tag === "thead" || tag === "tbody" || tag === "tfoot") {
            sectionHidden = !!why;
            row = null;
            cell = null;
          }
          if (tag === "caption") inCaption = true;
          if (tag === "tr") {
            rowHidden = sectionHidden || !!why;
            cellHidden = false;
            row = rowHidden ? null : { cells: [], header: true };
            if (row) cur.rows.push(row);
            cell = null;
          }
          if ((tag === "td" || tag === "th") && !rowHidden) {
            if (!row) {
              row = { cells: [], header: true };
              cur.rows.push(row);
            }
            const span = Number.parseInt(e.getAttribute("colspan") ?? "1", 10);
            // A hidden cell stays as an empty cell, so the columns after it keep their place.
            cellHidden = !!why;
            cell = { text: "", span: Number.isFinite(span) && span > 0 ? span : 1 };
            row.cells.push(cell);
            if (tag === "td") row.header = false;
          }
        }
        const watchEnd = isTable || tag === "caption" || (!!why && !structural);
        if (!watchEnd) return;
        try {
          e.onEndTag(() => {
            if (isTable) {
              depth = Math.max(0, depth - 1);
              if (depth === 0) {
                cur = null;
                row = null;
                cell = null;
              }
            }
            if (tag === "caption") inCaption = false;
            if (why && !structural) hiddenDepth = Math.max(0, hiddenDepth - 1);
          });
        } catch {
          return; // void element: nothing inside it
        }
        if (why && !structural) hiddenDepth++;
      },
    })
    .onDocument({
      text(tx) {
        if (hiddenDepth > 0 || !cur) return;
        if (inCaption) cur.caption += tx.text;
        else if (cell && !cellHidden && !rowHidden) cell.text += tx.text;
      },
    })
    .transform(stripped)
    .arrayBuffer();
  return tables;
}

type Source = {
  target: URL;
  finalUrl: URL;
  status: number;
  contentType: string;
  raw: Uint8Array;
  fetchedAt: number;
  doc: { ext: string; mime: string } | null;
};

/** Fetches what a paid snapshot call asked for. Every refusal comes back as the Response to return; none is charged. */
async function readSource(c: C, url: string): Promise<Source | Response> {
  const selfHost = new URL(c.req.url).hostname;
  let target: URL;
  try {
    target = checkTarget(url, selfHost);
  } catch (err) {
    return c.json({ error: err instanceof TargetError ? err.code : "bad_url" }, 400);
  }
  const got = await fetchPage(target, selfHost);
  if ("error" in got) return c.json({ error: got.error, ...got.detail }, got.status);
  const { res, finalUrl } = got;
  const contentType = res.headers.get("content-type") ?? "";
  if (res.status < 200 || res.status >= 300) {
    await res.body?.cancel();
    return c.json({ error: "upstream_status", upstreamStatus: res.status, finalUrl: finalUrl.href }, 424);
  }
  const doc = documentFormat(contentType, finalUrl.pathname);
  if (doc && !c.env.AI) {
    await res.body?.cancel();
    return c.json({ error: "unsupported_content_type", contentType, note: "documents need the converter, which this deployment does not have" }, 415);
  }
  if (!doc && !isTextual(contentType)) {
    await res.body?.cancel();
    return c.json({ error: "unsupported_content_type", contentType }, 415);
  }
  const raw = await readCapped(res, SNAPSHOT_LIMITS.MAX_BYTES);
  if (!raw) return c.json({ error: "too_large", maxBytes: SNAPSHOT_LIMITS.MAX_BYTES }, 413);
  return { target, finalUrl, status: res.status, contentType, raw, fetchedAt: Date.now(), doc };
}

/** Converts a fetched document to markdown, or the Response refusing it (not charged). */
async function documentMarkdown(c: C, src: Source): Promise<{ name: string; text: string } | Response> {
  const name = documentName(src.finalUrl.pathname, src.doc!.ext);
  const converted = await convertDocument(c.env.AI!, name, src.doc!.mime, src.raw);
  if ("error" in converted) return c.json({ error: "conversion_failed", format: src.doc!.ext, reason: converted.error }, 422);
  const text = tidyDocument(converted.data, name);
  if (!documentHasText(text)) {
    return c.json({ error: "no_text_in_document", format: src.doc!.ext, note: "nothing to read: likely scanned images or form fields only" }, 422);
  }
  return { name, text };
}

const isHtmlSource = (src: Source) =>
  /html/i.test(src.contentType) || (!src.contentType && /^\s*</.test(new TextDecoder().decode(src.raw.slice(0, 256))));

/** The signed record over exactly `text`, and its signature. */
async function signRead(c: C, sk: CryptoKey, wallet: string, src: Source, text: string, title: string, truncated: boolean) {
  const record: Snapshot = {
    v: 1,
    wallet,
    url: src.target.href,
    finalUrl: src.finalUrl.href,
    fetchedAt: src.fetchedAt,
    status: src.status,
    contentType: src.contentType,
    bytes: src.raw.byteLength,
    sha256: await sha256Hex(src.raw),
    textChars: text.length,
    textSha256: await sha256Hex(text),
    title,
    truncated,
  };
  const sig = b64encode(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, sk, new TextEncoder().encode(snapshotMessage(record)))));
  return { record, sig };
}

function decodeText(bytes: Uint8Array, contentType: string): string {
  const charset = /charset=([^;]+)/i.exec(contentType)?.[1]?.trim().replace(/"/g, "") || "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

const SCHEMA = {
  type: "object",
  required: ["url"],
  properties: {
    url: { type: "string", pattern: "^https?://", maxLength: 2048, description: "Public http(s) page to fetch" },
    max_chars: {
      type: "integer",
      minimum: SNAPSHOT_LIMITS.MIN_CHARS,
      maximum: SNAPSHOT_LIMITS.MAX_CHARS,
      description: `Most characters of text to return (default ${SNAPSHOT_LIMITS.DEFAULT_CHARS}); the signature covers exactly what is returned`,
    },
  },
};
const json = (schema: object, description: string) => ({ description, content: { "application/json": { schema } } });
const ERR = (description: string) => json({ type: "object", properties: { error: { type: "string" } } }, description);
const SNAPSHOT_SCHEMA = {
  type: "object",
  description: "The signed record. The server signs `tabularium/snapshot/v1\\n` + JSON of these fields in this order.",
  properties: {
    v: { type: "integer" },
    wallet: { type: "string" },
    url: { type: "string" },
    finalUrl: { type: "string" },
    fetchedAt: { type: "integer", description: "Unix ms" },
    status: { type: "integer" },
    contentType: { type: "string" },
    bytes: { type: "integer" },
    sha256: { type: "string", description: "sha256 hex of the raw response body" },
    textChars: { type: "integer" },
    textSha256: { type: "string", description: "sha256 hex of the returned text (UTF-8)" },
    title: { type: "string" },
    truncated: { type: "boolean" },
  },
};
const EXAMPLE_SNAPSHOT: Snapshot = {
  v: 1,
  wallet: "0x...",
  url: "https://example.com/",
  finalUrl: "https://example.com/",
  fetchedAt: 1790000000000,
  status: 200,
  contentType: "text/html; charset=UTF-8",
  bytes: 1256,
  sha256: "<sha256 hex of the raw body>",
  textChars: 180,
  textSha256: "<sha256 hex of text>",
  title: "Example Domain",
  truncated: false,
};

const EXAMPLE_CHECKS: PageChecks = {
  verdict: "clean",
  hiddenText: { chars: 0, reasons: [], samples: [], separated: true },
  invisible: { tagCharsRemoved: 0, bidiControlsRemoved: 0, zeroWidthKept: 0 },
  steering: [],
  note: CHECKS_NOTE,
};
const CHECKS_SCHEMA = {
  type: "object",
  description: "Advisory, not signed: what the page hid from a person and whether it tries to steer a model.",
  properties: {
    verdict: { type: "string", enum: ["clean", "review", "suspicious"] },
    hiddenText: {
      type: "object",
      properties: { chars: { type: "integer" }, reasons: { type: "array", items: { type: "string" } }, samples: { type: "array", items: { type: "string" } }, separated: { type: "boolean" } },
    },
    invisible: { type: "object", properties: { tagCharsRemoved: { type: "integer" }, bidiControlsRemoved: { type: "integer" }, zeroWidthKept: { type: "integer" } } },
    steering: { type: "array", items: { type: "object", properties: { where: { type: "string", enum: ["visible", "hidden", "comment"] }, phrase: { type: "string" } } } },
    note: { type: "string" },
  },
};

const TABLES_SCHEMA = {
  type: "object",
  required: ["url"],
  properties: {
    url: { type: "string", pattern: "^https?://", maxLength: 2048, description: "Public http(s) page, document or CSV file" },
    max_tables: { type: "integer", minimum: 1, maximum: TABLE_LIMITS.MAX_TABLES, description: `Most tables to return (default ${TABLE_LIMITS.DEFAULT_TABLES})` },
  },
};
const TABLE_SCHEMA = {
  type: "object",
  properties: {
    caption: { type: "string" },
    headers: { type: "array", items: { type: "string" }, description: "Empty when the source marks no header row" },
    rows: { type: "array", items: { type: "array", items: { type: "string" } } },
  },
};
const EXAMPLE_TABLES: Table[] = [
  { caption: "Tallest buildings", headers: ["Rank", "Name", "Height (m)"], rows: [["1", "Burj Khalifa", "828"], ["2", "Merdeka 118", "679"]] },
];

export const snapshot: Service = {
  id: "snapshot",
  serviceName: "Tabularium Snapshot",
  tags: ["web-fetch", "markdown", "prompt-injection", "verifiable", "signed"],
  summary:
    "Read a public web page as clean markdown, the way a person sees it: hidden text and invisible characters are separated out and flagged, and the read is server-signed.",
  llms: (env, origin) => `# Tabularium Snapshot

> Read a public web page as clean markdown, the way a person sees it. Text the page hides from people (display:none,
> zero-size, off-screen, invisible Unicode) is kept out of the text and reported, with any instruction-like phrases
> and a verdict, so a hidden prompt injection does not reach your model as page content. Every read carries an
> Ed25519-signed record of what was served, from which final URL, and when. Paid per call in USDC over x402.

## When it fits

- An agent reads pages it did not choose (search results, links in email, user-supplied URLs) and should not take
  orders from them: check \`checks.verdict\` before acting on the text.
- An agent needs a page's content and someone may later ask "what did the page say when you read it?": research
  notes, citations, compliance, price or policy checks, disputes.

## What \`checks\` says

- verdict: \`clean\` (nothing found), \`review\` (instruction-like phrases in the visible text, common on pages
  about AI), \`suspicious\` (instruction-like phrases in hidden text or HTML comments, chat-template tokens, Unicode
  tag characters or bidi overrides).
- hiddenText: how many characters were hidden, why, and up to three samples. Not in \`text\`.
- invisible: tag characters and bidi controls removed from \`text\`; zero-width characters kept and counted.
- It reads inline styles and attributes only: text hidden by a stylesheet class or by a script is not detected.
  \`checks\` is advisory and not covered by the signature; \`text\` is.
- The signed record (sha256 of the raw body and of the returned text, final URL after redirects, time, status) can
  be stored in Tabularium memory or handed to anyone, and checked offline with the public key in /menu.

## When it does not fit

- Pages behind a login, paywall or bot wall; the fetcher does not run JavaScript.
- Images and other binaries: refused, not charged. Documents are read: PDF, Word (.docx), Excel (.xlsx, .xls),
  OpenDocument (.odt, .ods) and Numbers come back as markdown (tables included), at the same price.
- Paths the site's robots.txt disallows for TabulariumSnapshot or *: refused, not charged.

## Call

POST /snapshot/fetch   ${SNAPSHOT_PRICES.fetch}   body {"url": "https://example.com/", "max_chars": 50000}

Charged only when the site answers 2xx with a text page. Not charged: invalid or non-public URLs (400), robots.txt
disallow (403), over ${SNAPSHOT_LIMITS.MAX_BYTES / 1024 / 1024} MB (413), non-text content (415), a document the converter could not read or with no text in it, such as a scan (422), the site's own error status (424, with the status),
network failure or timeout (502). Redirects are followed (up to ${SNAPSHOT_LIMITS.MAX_REDIRECTS}), each hop checked again. Text is capped at
max_chars (default ${SNAPSHOT_LIMITS.DEFAULT_CHARS}, at most ${SNAPSHOT_LIMITS.MAX_CHARS}); \`truncated\` says whether it was cut, and the signature covers exactly
the text returned.

POST /snapshot/tables   ${SNAPSHOT_PRICES.tables}   body {"url": "https://en.wikipedia.org/wiki/List_of_tallest_buildings", "max_tables": 20}

The tables in a web page, PDF, Word, Excel, OpenDocument or CSV file as JSON: [{caption, headers, rows}], at most
max_tables (default ${TABLE_LIMITS.DEFAULT_TABLES}, at most ${TABLE_LIMITS.MAX_TABLES}). Rows hidden from people are skipped; layout tables (one row or one column)
are dropped. PDF tables are best effort: PDFs rarely record table structure. Charged only when at least one table
comes back: a page without tables is 422 and costs nothing.
\`text\` is JSON.stringify(tables), the exact text the signature covers.

## Verify

Response: {snapshot, text, sig}. The server signs "${"tabularium/snapshot/v1"}\\n" + JSON.stringify([v, wallet, url,
finalUrl, fetchedAt, status, contentType, bytes, sha256, textChars, textSha256, title, truncated]) with the key at
${origin}/menu (signing.publicKeyHex). Save the response and run:

    node verifier/verify.mjs --snapshot response.json <publicKeyHex>

It checks the text against textSha256 and the signature. It cannot prove the site served those bytes to anyone
else; it proves what Tabularium's fetcher received at that time.
`,
  calls: [
    {
      name: "fetch",
      method: "POST",
      path: "/snapshot/fetch",
      price: SNAPSHOT_PRICES.fetch,
      description:
        "Reads a web page as clean markdown, as a person sees it: hidden text and invisible Unicode are kept out of the text and flagged with a prompt-injection verdict. Also reads PDF, Word and Excel files as markdown. Includes an Ed25519-signed record (final URL, time, status, sha256 of body and text) that verifies offline. Charged only for 2xx pages and documents it can read; refused URLs cost nothing.",
      discovery: declareDiscoveryExtension({
        bodyType: "json",
        input: { url: "https://example.com/" },
        inputSchema: SCHEMA,
        output: {
          example: { ok: true, snapshot: EXAMPLE_SNAPSHOT, text: "# Example Domain\n\nThis domain is for use in documentation examples...", sig: "<base64 Ed25519 signature>", checks: EXAMPLE_CHECKS },
        },
      }),
      menu: { call: "POST /snapshot/fetch", price: SNAPSHOT_PRICES.fetch, body: { url: "string", max_chars: "integer, optional" } },
      openapi: {
        operationId: "snapshotFetch",
        summary: "Read a web page as markdown as a person sees it, hidden text flagged, with a signed record",
        description: "Charged only when the site answers 2xx with a text page. Verify offline with verifier/verify.mjs --snapshot.",
        requestBody: { required: true, content: { "application/json": { schema: SCHEMA, example: { url: "https://example.com/" } } } },
        responses: {
          "200": json(
            { type: "object", properties: { ok: { type: "boolean" }, snapshot: SNAPSHOT_SCHEMA, text: { type: "string" }, sig: { type: "string", description: "base64 Ed25519" }, checks: CHECKS_SCHEMA } },
            "The visible page text, its signed record, and the hidden-text checks",
          ),
          "400": ERR("Invalid or non-public URL (not charged)"),
          "403": ERR("robots.txt disallows this path (not charged)"),
          "413": ERR("Page larger than 5 MB (not charged)"),
          "415": ERR("Not a text page or a supported document (not charged)"),
          "422": ERR("A document the converter could not read (not charged)"),
          "424": ERR("The site answered with an error status (not charged)"),
          "502": ERR("Network failure, timeout or too many redirects (not charged)"),
        },
      },
      handler: async (c: C, wallet: string) => {
        const body = (await c.req.json().catch(() => null)) as { url?: unknown; max_chars?: unknown } | null;
        if (!body || typeof body.url !== "string") return c.json({ error: "body_must_be_{url:string,max_chars?:integer}" }, 400);
        const maxChars = body.max_chars === undefined ? SNAPSHOT_LIMITS.DEFAULT_CHARS : body.max_chars;
        if (typeof maxChars !== "number" || !Number.isInteger(maxChars) || maxChars < SNAPSHOT_LIMITS.MIN_CHARS || maxChars > SNAPSHOT_LIMITS.MAX_CHARS) {
          return c.json({ error: "bad_max_chars", min: SNAPSHOT_LIMITS.MIN_CHARS, max: SNAPSHOT_LIMITS.MAX_CHARS }, 400);
        }
        try {
          checkTarget(body.url, new URL(c.req.url).hostname);
        } catch (err) {
          return c.json({ error: err instanceof TargetError ? err.code : "bad_url" }, 400);
        }
        const sk = await signingKey(c.env); // before any work: a bad key must fail without fetching
        const src = await readSource(c, body.url);
        if (src instanceof Response) return src;

        let extracted: PageRead & { title: string };
        if (src.doc) {
          const md = await documentMarkdown(c, src);
          if (md instanceof Response) return md;
          extracted = { text: md.text, hidden: "", reasons: [], comments: "", title: md.name };
        } else {
          extracted = isHtmlSource(src)
            ? await htmlToText(src.raw, src.contentType)
            : { text: tidyText(decodeText(src.raw, src.contentType)), hidden: "", reasons: [], comments: "", title: "" };
        }
        const { text: seen, checks } = checkPage(extracted);
        if (src.doc) checks.note = `${checks.note} Documents are converted as written: text hidden inside them (white text, tiny fonts) is not detected.`;
        const truncated = seen.length > maxChars;
        const text = truncated ? seen.slice(0, maxChars) : seen;
        const { record, sig } = await signRead(c, sk, wallet, src, text, extracted.title, truncated);
        return c.json({ ok: true, snapshot: record, text, sig, publicKeyHex: c.env.SIGNING_PUBKEY_HEX, checks });
      },
    },
    {
      name: "tables",
      method: "POST",
      path: "/snapshot/tables",
      price: SNAPSHOT_PRICES.tables,
      description:
        "Returns the tables in a web page, PDF, Word, Excel or CSV file as JSON: caption, header row and rows of cells. Rows hidden from people are skipped. Includes the same Ed25519-signed record as fetch, over the exact JSON returned. Charged only when at least one table comes back; a page without tables costs nothing.",
      discovery: declareDiscoveryExtension({
        bodyType: "json",
        input: { url: "https://en.wikipedia.org/wiki/List_of_tallest_buildings" },
        inputSchema: TABLES_SCHEMA,
        output: { example: { ok: true, snapshot: EXAMPLE_SNAPSHOT, tables: EXAMPLE_TABLES, text: "<the signed JSON of tables>", sig: "<base64 Ed25519 signature>", checks: EXAMPLE_CHECKS } },
      }),
      menu: { call: "POST /snapshot/tables", price: SNAPSHOT_PRICES.tables, body: { url: "string", max_tables: "integer, optional" } },
      openapi: {
        operationId: "snapshotTables",
        summary: "The tables in a web page, PDF, Word, Excel or CSV file, as JSON, with a signed record",
        description: "Charged only when at least one table comes back. `text` is the exact JSON the signature covers; verify with verifier/verify.mjs --snapshot.",
        requestBody: { required: true, content: { "application/json": { schema: TABLES_SCHEMA, example: { url: "https://en.wikipedia.org/wiki/List_of_tallest_buildings" } } } },
        responses: {
          "200": json(
            {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                snapshot: SNAPSHOT_SCHEMA,
                tables: { type: "array", items: TABLE_SCHEMA },
                text: { type: "string", description: "JSON.stringify(tables): the exact text the signature covers" },
                sig: { type: "string", description: "base64 Ed25519" },
                checks: CHECKS_SCHEMA,
              },
            },
            "The tables, their signed record, and the page's hidden-text checks",
          ),
          "400": ERR("Invalid or non-public URL (not charged)"),
          "403": ERR("robots.txt disallows this path (not charged)"),
          "413": ERR("Larger than 5 MB (not charged)"),
          "415": ERR("Not a page, document or CSV file (not charged)"),
          "422": ERR("No tables found, or a document the converter could not read (not charged)"),
          "424": ERR("The site answered with an error status (not charged)"),
          "502": ERR("Network failure, timeout or too many redirects (not charged)"),
        },
      },
      handler: async (c: C, wallet: string) => {
        const body = (await c.req.json().catch(() => null)) as { url?: unknown; max_tables?: unknown } | null;
        if (!body || typeof body.url !== "string") return c.json({ error: "body_must_be_{url:string,max_tables?:integer}" }, 400);
        const maxTables = body.max_tables === undefined ? TABLE_LIMITS.DEFAULT_TABLES : body.max_tables;
        if (typeof maxTables !== "number" || !Number.isInteger(maxTables) || maxTables < 1 || maxTables > TABLE_LIMITS.MAX_TABLES) {
          return c.json({ error: "bad_max_tables", min: 1, max: TABLE_LIMITS.MAX_TABLES }, 400);
        }
        try {
          checkTarget(body.url, new URL(c.req.url).hostname);
        } catch (err) {
          return c.json({ error: err instanceof TargetError ? err.code : "bad_url" }, 400);
        }
        const sk = await signingKey(c.env);
        const src = await readSource(c, body.url);
        if (src instanceof Response) return src;

        let raw: RawTable[];
        let page: PageRead;
        let title = "";
        const baseType = src.contentType.split(";")[0].trim().toLowerCase();
        const isCsv = baseType === "text/csv" || (["", "text/plain", "application/octet-stream"].includes(baseType) && src.finalUrl.pathname.toLowerCase().endsWith(".csv"));
        if (src.doc) {
          const md = await documentMarkdown(c, src);
          if (md instanceof Response) return md;
          raw = markdownTables(md.text);
          page = { text: md.text, hidden: "", reasons: [], comments: "" };
          title = md.name;
        } else if (isCsv) {
          const text = decodeText(src.raw, src.contentType);
          raw = [csvTable(text)];
          page = { text, hidden: "", reasons: [], comments: "" };
          title = documentName(src.finalUrl.pathname, ".csv");
        } else if (isHtmlSource(src)) {
          raw = await htmlTables(src.raw, src.contentType);
          const read = await htmlToText(src.raw, src.contentType);
          page = read;
          title = read.title;
        } else {
          return c.json({ error: "no_tables", note: "not a page, document or CSV file with tables" }, 422);
        }
        const tables: Table[] = finishTables(raw, maxTables).map((tb) => ({
          caption: scrubInvisible(tb.caption).text,
          headers: tb.headers.map((h) => scrubInvisible(h).text),
          rows: tb.rows.map((r) => r.map((v) => scrubInvisible(v).text)),
        }));
        if (!tables.length) return c.json({ error: "no_tables", note: "no table with at least two rows and two columns" }, 422);
        const { checks } = checkPage(page);
        const text = JSON.stringify(tables);
        const { record, sig } = await signRead(c, sk, wallet, src, text, title, false);
        return c.json({ ok: true, snapshot: record, tables, text, sig, publicKeyHex: c.env.SIGNING_PUBKEY_HEX, checks });
      },
    },
  ],
};
