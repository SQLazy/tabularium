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

// --- What a person would not see (track: snapshot reads like a person) ---------------------------------------------
// Pages can carry text a reader never sees: display:none blocks, zero-size or off-screen boxes, invisible Unicode,
// HTML comments. A person skips it; an agent reading the raw text takes it as part of the page, which is how hidden
// prompt injection works. The fetch keeps that text out of `text`, returns it separately, and says what it found.
// This is a heuristic on inline styles and attributes only: text hidden by a stylesheet class is not detected.

const ch = (cp: number) => String.fromCodePoint(cp);
const span = (a: number, b: number) => `${ch(a)}-${ch(b)}`;
/** Unicode tag characters (U+E0000..E007F): invisible, and able to spell ASCII ("ASCII smuggling"). Always removed. */
const TAG_CHARS = new RegExp(`[${span(0xe0000, 0xe007f)}]`, "gu");
/** Bidirectional overrides and isolates: reorder what is shown versus what is read. Removed and counted. */
const BIDI = new RegExp(`[${span(0x202a, 0x202e)}${span(0x2066, 0x2069)}]`, "gu");
/** Zero-width and invisible format characters. Counted, kept (ZWJ is part of ordinary emoji). */
const ZERO_WIDTH = new RegExp(`[${span(0x200b, 0x200f)}${span(0x2060, 0x2064)}${ch(0xfeff)}]`, "gu");

/** Why an element's text would not be seen, from its inline style and attributes; null if nothing says so. */
export function hiddenReason(style: string | null, hasHiddenAttr: boolean): string | null {
  if (hasHiddenAttr) return "hidden_attribute";
  if (!style) return null;
  const s = style.toLowerCase().replace(/\s+/g, "").replace(/!important/g, "");
  if (/(^|;)display:none/.test(s)) return "display_none";
  if (/(^|;)visibility:(hidden|collapse)/.test(s)) return "visibility_hidden";
  if (/(^|;)opacity:0?(\.0+)?(;|$)/.test(s) && !/(^|;)opacity:0?\.0*[1-9]/.test(s)) return "opacity_zero";
  if (/(^|;)font-size:0(\.0+)?(px|em|rem|pt|%|vw|vh)?(;|$)/.test(s)) return "font_size_zero";
  if (/(^|;)color:transparent/.test(s)) return "transparent_text";
  if (/(^|;)(left|top|right|text-indent|margin-left|margin-top):-\d{4,}(\.\d+)?(px|em|rem)?/.test(s)) return "off_screen";
  if (/clip:rect\(0(px)?,?0(px)?,?0(px)?,?0(px)?\)/.test(s) || /clip-path:inset\(50%\)/.test(s)) return "clipped";
  if (/(^|;)(width|height):0(px)?(;|$)/.test(s) && /overflow:hidden/.test(s)) return "zero_size";
  return null;
}

// Phrases written to steer a model rather than inform a reader. Matching one in visible text is common on pages that
// discuss prompt injection, so on its own it only asks for review; in hidden text or comments it is suspicious.
const STEER: RegExp[] = [
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|preceding|all|your|any)\b[^.\n]{0,20}\b(instructions?|prompts?|messages?|rules|directives?|context)\b/gi,
  /\byou are now\b[^.\n]{0,60}/gi,
  /\bnew (system )?instructions?\s*:/gi,
  /\bsystem prompt\b/gi,
  /\b(do not|don't|never) (tell|inform|mention|reveal|show)\b[^.\n]{0,20}\b(the )?(user|human|operator)\b/gi,
  /\bif you are an? (ai|llm|language model|assistant|agent|bot|chatbot)\b/gi,
  /\b(ai|llm|assistant|agent|model)s? (reading|processing|summari[sz]ing) this\b/gi,
  /\b(send|transfer|reveal|share|paste|output|print)\b[^.\n]{0,40}\b(private key|seed phrase|mnemonic|api key|password|credentials|usdc|wallet balance)\b/gi,
  /<\|im_start\|>|<\|im_end\|>|\[INST\]|<<SYS>>|<\/?system>|<\|system\|>/gi,
];

export interface SteerHit {
  where: "visible" | "hidden" | "comment";
  phrase: string;
}

/** Instruction-like phrases in one piece of text, at most `cap` of them, each trimmed to 100 characters. */
export function steeringPhrases(text: string, where: SteerHit["where"], cap = 10): SteerHit[] {
  const hits: SteerHit[] = [];
  for (const re of STEER) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      hits.push({ where, phrase: m[0].replace(/\s+/g, " ").trim().slice(0, 100) });
      if (hits.length >= cap) return hits;
    }
  }
  return hits;
}

/** Removes tag characters and bidi controls, and counts what it removed plus the zero-width characters it kept. */
export function scrubInvisible(text: string): { text: string; tagChars: number; bidiControls: number; zeroWidth: number } {
  const tagChars = (text.match(TAG_CHARS) ?? []).length;
  const bidiControls = (text.match(BIDI) ?? []).length;
  const zeroWidth = (text.match(ZERO_WIDTH) ?? []).length;
  return { text: text.replace(TAG_CHARS, "").replace(BIDI, ""), tagChars, bidiControls, zeroWidth };
}

export interface PageChecks {
  /** clean: nothing found. review: steering phrases in visible text only. suspicious: hidden steering, smuggling. */
  verdict: "clean" | "review" | "suspicious";
  hiddenText: { chars: number; reasons: string[]; samples: string[]; separated: boolean };
  invisible: { tagCharsRemoved: number; bidiControlsRemoved: number; zeroWidthKept: number };
  steering: SteerHit[];
  note: string;
}

export const CHECKS_NOTE =
  "Advisory, not signed. Hidden means hidden by an inline style or the hidden attribute; stylesheet classes and scripts are not evaluated.";

/** The verdict from what was found. Pure, so the rules are tested without a Worker. */
export function judge(found: { steering: SteerHit[]; tagChars: number; bidiControls: number }): PageChecks["verdict"] {
  if (found.tagChars > 0 || found.bidiControls > 0) return "suspicious";
  if (found.steering.some((h) => h.where !== "visible" || /<\||\[INST\]|<<SYS>>|system>/i.test(h.phrase))) return "suspicious";
  return found.steering.length ? "review" : "clean";
}

/** What the HTML reader hands over: the text a person sees, the text they would not, why, and the comments. */
export interface PageRead {
  text: string;
  hidden: string;
  reasons: string[];
  comments: string;
}

/** Separates what a person sees from what they don't, removes smuggling characters, and judges the page. */
export function checkPage(read: PageRead): { text: string; checks: PageChecks } {
  // An unclosed hidden element would swallow the rest of the page. If "hidden" is most of the page, the split is not
  // trustworthy: return everything as text and say so, rather than hand back a page with its body missing.
  const separated = !(read.hidden.length > 2000 && read.hidden.length > read.text.length);
  const visible = scrubInvisible(separated ? read.text : tidyText(`${read.text}\n\n${read.hidden}`));
  const hiddenScrub = scrubInvisible(separated ? read.hidden : "");
  const steering = [
    ...steeringPhrases(visible.text, "visible"),
    ...steeringPhrases(hiddenScrub.text, "hidden"),
    ...steeringPhrases(read.comments, "comment"),
  ].slice(0, 15);
  const tagChars = visible.tagChars + hiddenScrub.tagChars;
  const bidiControls = visible.bidiControls + hiddenScrub.bidiControls;
  const samples = hiddenScrub.text
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((s) => s.slice(0, 300));
  return {
    text: visible.text,
    checks: {
      verdict: judge({ steering, tagChars, bidiControls }),
      hiddenText: { chars: read.hidden.length, reasons: read.reasons, samples, separated },
      invisible: { tagCharsRemoved: tagChars, bidiControlsRemoved: bidiControls, zeroWidthKept: visible.zeroWidth },
      steering,
      note: separated ? CHECKS_NOTE : `${CHECKS_NOTE} Most of this page looked hidden (likely an unclosed element), so all of it is in text.`,
    },
  };
}

// --- Documents (PDF, Word, Excel, OpenDocument, Numbers) ------------------------------------------------------------
// Converted with Workers AI toMarkdown, which is free for these formats (only image conversion costs neurons, and
// embedded images are switched off). Images themselves are still refused.
export const DOCUMENTS: { ext: string; mime: string }[] = [
  { ext: ".pdf", mime: "application/pdf" },
  { ext: ".docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  { ext: ".xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  { ext: ".xlsm", mime: "application/vnd.ms-excel.sheet.macroenabled.12" },
  { ext: ".xlsb", mime: "application/vnd.ms-excel.sheet.binary.macroenabled.12" },
  { ext: ".xls", mime: "application/vnd.ms-excel" },
  { ext: ".ods", mime: "application/vnd.oasis.opendocument.spreadsheet" },
  { ext: ".odt", mime: "application/vnd.oasis.opendocument.text" },
  { ext: ".numbers", mime: "application/vnd.apple.numbers" },
];

/**
 * The document format of a response, from its content type, or from the URL's extension when the server only says
 * "application/octet-stream" (common for PDFs on file hosts). Null when it is not a document we convert.
 */
export function documentFormat(contentType: string, pathname: string): { ext: string; mime: string } | null {
  const t = contentType.split(";")[0].trim().toLowerCase();
  const byType = DOCUMENTS.find((d) => d.mime === t);
  if (byType) return byType;
  if (t === "application/octet-stream" || t === "binary/octet-stream" || t === "application/x-pdf" || t === "") {
    const p = pathname.toLowerCase();
    return DOCUMENTS.find((d) => p.endsWith(d.ext)) ?? null;
  }
  return null;
}

/** A file name for the converter and the record's title: the URL's last path segment, or "document" + extension. */
export function documentName(pathname: string, ext: string): string {
  let last = pathname.split("/").filter(Boolean).pop() ?? "";
  try {
    last = decodeURIComponent(last);
  } catch {
    // keep it as sent
  }
  last = last.replace(/[^\w.\- ]+/g, "_").slice(0, 120);
  return last.toLowerCase().endsWith(ext) ? last : `${last || "document"}${ext}`;
}

/** Converter output, tidied: drops the "# <file name>" heading the converter adds, keeps the rest. */
export function tidyDocument(markdown: string, name: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trim() === `# ${name}`) lines.shift();
  return tidyText(lines.join("\n"));
}

/**
 * Whether a converted document has any text beyond the converter's own headings ("## Contents", "### Page 3").
 * Scanned PDFs and form-only PDFs (the IRS W-9 came back as six empty page headings) have none, and a buyer should
 * not pay for that: the call is refused and not charged.
 */
export function documentHasText(markdown: string): boolean {
  const body = markdown
    .split("\n")
    .filter((l) => !/^#{1,6}\s*(contents|page \d+)?\s*$/i.test(l.trim()))
    .join("")
    .replace(/[\s|:-]+/g, "");
  return body.length >= 8;
}

// --- Tables (POST /snapshot/tables) ---------------------------------------------------------------------------------
// Pages, documents and CSV files as typed rows. One seller on the Bazaar gets ~2,300 calls a month for this
// (pocket.network table-extraction, 7 Nov 2026); snapshot adds hidden-row filtering and a signed record.

export interface Table {
  caption: string;
  /** The header row when the source marks one (<th> cells, a markdown header, a CSV first row); else empty. */
  headers: string[];
  rows: string[][];
}

/** What a reader collects before tidying: rows of cells, each row flagged when every cell was a header cell. */
export interface RawTable {
  caption: string;
  rows: { cells: { text: string; span: number }[]; header: boolean }[];
}

export const TABLE_LIMITS = { DEFAULT_TABLES: 20, MAX_TABLES: 100, MAX_ROWS: 2000, MAX_CELL_CHARS: 2000, MAX_COLUMNS: 100 };

const cellText = (s: string) => decodeEntities(s).replace(/\s+/g, " ").trim().slice(0, TABLE_LIMITS.MAX_CELL_CHARS);

/**
 * Tidies raw tables: whitespace collapsed, colspans kept as empty cells so columns line up, empty rows dropped,
 * and layout tables (fewer than two rows, or never two columns) dropped. At most `max` tables.
 */
export function finishTables(raw: RawTable[], max: number): Table[] {
  const out: Table[] = [];
  for (const t of raw) {
    const rows = t.rows
      .map((r) => ({
        header: r.header,
        cells: r.cells.flatMap((c) => [cellText(c.text), ...Array(Math.max(0, Math.min(c.span, TABLE_LIMITS.MAX_COLUMNS) - 1)).fill("")]).slice(0, TABLE_LIMITS.MAX_COLUMNS),
      }))
      .filter((r) => r.cells.some((c) => c !== ""));
    if (rows.length < 2 || !rows.some((r) => r.cells.length >= 2)) continue;
    const first = rows[0];
    const headers = first.header ? first.cells : [];
    const body = (first.header ? rows.slice(1) : rows).slice(0, TABLE_LIMITS.MAX_ROWS).map((r) => r.cells);
    out.push({ caption: cellText(t.caption).slice(0, 300), headers, rows: body });
    if (out.length >= max) break;
  }
  return out;
}

/** Splits one markdown table line into cells ("| a | b |" -> ["a", "b"]). */
function mdCells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|"));
}

/** Markdown tables (as the document converter writes them) to raw tables. A line of dashes marks the header. */
export function markdownTables(md: string): RawTable[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const tables: RawTable[] = [];
  let cur: RawTable | null = null;
  let caption = "";
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("|")) {
      if (!cur) {
        cur = { caption, rows: [] };
        tables.push(cur);
      }
      if (/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(t)) {
        if (cur.rows.length === 1) cur.rows[0].header = true;
        continue;
      }
      cur.rows.push({ cells: mdCells(t).map((text) => ({ text, span: 1 })), header: false });
    } else {
      cur = null;
      if (t) caption = t.replace(/^#+\s*/, "");
    }
  }
  return tables;
}

/** A CSV file (RFC 4180: quotes, doubled quotes, newlines inside quotes) as one raw table, first row as header. */
export function csvTable(text: string): RawTable {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (rows.length > TABLE_LIMITS.MAX_ROWS + 1) break;
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return { caption: "", rows: rows.map((cells, i) => ({ cells: cells.map((t) => ({ text: t, span: 1 })), header: i === 0 })) };
}
