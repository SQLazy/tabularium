// Snapshot service, pure parts (no Workers APIs, so they run in Node tests): which URLs may be fetched, what
// robots.txt allows, and the exact message the server signs. verifier/verify.mjs rebuilds the same message.

/** Our robots.txt product token and the User-Agent the fetcher sends. */
export const ROBOTS_TOKEN = "TabulariumSnapshot";
export const FETCH_UA = `${ROBOTS_TOKEN}/1.0 (+https://github.com/SQLazy/tabularium; fetched on behalf of a paying agent)`;
export const SNAPSHOT_TAG = "tabularium/snapshot/v1";

export interface Snapshot {
  v: 1;
  /** Wallet that paid for (requested) the snapshot. */
  wallet: string;
  /** URL as requested, and the URL finally served after redirects. */
  url: string;
  finalUrl: string;
  /** Unix ms when the response was received. */
  fetchedAt: number;
  status: number;
  contentType: string;
  /** Raw response body: size and sha256 hex. Lets anyone who saved or re-fetches the bytes compare. */
  bytes: number;
  sha256: string;
  /** The returned text: length in UTF-16 code units (JS string length) and sha256 hex of its UTF-8 bytes. */
  textChars: number;
  textSha256: string;
  title: string;
  truncated: boolean;
}

// The signed message: a domain tag, then the record as JSON with a fixed key order. The tag keeps a snapshot
// signature from ever being mistaken for a workspace head signature (those start "omega/v1/head").
const ORDER: (keyof Snapshot)[] = ["v", "wallet", "url", "finalUrl", "fetchedAt", "status", "contentType", "bytes", "sha256", "textChars", "textSha256", "title", "truncated"];
export function snapshotMessage(s: Snapshot): string {
  return `${SNAPSHOT_TAG}\n${JSON.stringify(ORDER.map((k) => s[k]))}`;
}

export class TargetError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

const BLOCKED_SUFFIX = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|private|arpa|test|invalid)$/;

/**
 * Only public web pages by name: http(s), default ports, no credentials, no IP literals, no internal-looking
 * names, and never this service itself. (Workers cannot reach private networks; this keeps it that way by design.)
 */
export function checkTarget(raw: string, selfHost?: string): URL {
  if (typeof raw !== "string" || raw.length > 2048) throw new TargetError("bad_url");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new TargetError("bad_url");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new TargetError("url_scheme_not_allowed");
  if (u.username || u.password) throw new TargetError("url_credentials_not_allowed");
  if (u.port) throw new TargetError("url_port_not_allowed"); // URL drops default ports, so any port here is non-default
  const h = u.hostname.toLowerCase().replace(/\.$/, "");
  // The URL parser turns every IPv4 spelling (0x7f.1, 2130706433, ...) into dotted form, and IPv6 into [..].
  if (h.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(h)) throw new TargetError("ip_address_not_allowed");
  if (!h.includes(".") || BLOCKED_SUFFIX.test(h)) throw new TargetError("host_not_allowed");
  if (selfHost && h === selfHost.toLowerCase()) throw new TargetError("host_not_allowed");
  u.hash = "";
  return u;
}

const escapeRe = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
function ruleMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  return new RegExp("^" + body.split("*").map(escapeRe).join(".*") + (anchored ? "$" : "")).test(path);
}

/**
 * RFC 9309: the group naming our token wins, else the "*" group; within it the longest matching rule wins, and
 * Allow wins a tie. No matching rule (or no robots.txt) means allowed. `path` is pathname + search.
 */
export function robotsAllows(txt: string, path: string, token = ROBOTS_TOKEN): boolean {
  type Group = { agents: string[]; rules: { allow: boolean; pattern: string }[] };
  const groups: Group[] = [];
  let cur: Group | null = null;
  let collectingAgents = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === "user-agent") {
      if (!cur || !collectingAgents) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(value.toLowerCase());
      collectingAgents = true;
    } else if (field === "allow" || field === "disallow") {
      collectingAgents = false;
      if (cur && value) cur.rules.push({ allow: field === "allow", pattern: value });
    }
  }
  const t = token.toLowerCase();
  const mine = groups.filter((g) => g.agents.includes(t));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  let best: { allow: boolean; len: number } | null = null;
  for (const g of chosen) {
    for (const r of g.rules) {
      if (!ruleMatches(r.pattern, path)) continue;
      const len = r.pattern.length;
      if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len };
    }
  }
  return best ? best.allow : true;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", copy: "©", reg: "®", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** Trims each line, collapses runs of spaces, and keeps at most one blank line in a row. */
export function tidyText(s: string): string {
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t\f\v ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Text types the snapshot accepts. Images, PDFs and other binaries are refused (not charged). */
export function isTextual(contentType: string): boolean {
  const t = contentType.split(";")[0].trim().toLowerCase();
  return !t || t.startsWith("text/") || /^application\/([a-z0-9.+-]*\+)?(json|xml)$/.test(t) || t === "application/xhtml+xml" || t === "application/javascript";
}
