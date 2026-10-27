// Snapshot service, pure parts: which URLs may be fetched, robots.txt rules, and the signed record (signed here
// exactly as the Worker does, verified with the zero-dependency verifier).
import { describe, expect, it } from "vitest";
import { b64encode, sha256Hex, toHex } from "../src/chain";
import { checkTarget, decodeEntities, isTextual, robotsAllows, snapshotMessage, tidyText, type Snapshot } from "../src/services/snapshot-core";
// @ts-expect-error plain .mjs without types
import { verifySnapshot } from "../verifier/verify.mjs";

describe("checkTarget", () => {
  it.each(["https://example.com/a?b=1", "http://news.ycombinator.com/", "https://sub.domain.co.uk/x#frag"])("allows %s", (u) => {
    expect(checkTarget(u).hash).toBe("");
  });
  it.each([
    ["ftp://example.com/", "url_scheme_not_allowed"],
    ["file:///etc/passwd", "url_scheme_not_allowed"],
    ["javascript:alert(1)", "url_scheme_not_allowed"],
    ["https://user:pw@example.com/", "url_credentials_not_allowed"],
    ["https://example.com:8443/", "url_port_not_allowed"],
    ["http://127.0.0.1/", "ip_address_not_allowed"],
    ["http://2130706433/", "ip_address_not_allowed"],
    ["http://0x7f.1/", "ip_address_not_allowed"],
    ["http://[::1]/", "ip_address_not_allowed"],
    ["http://169.254.169.254/latest/meta-data", "ip_address_not_allowed"],
    ["http://localhost/", "host_not_allowed"],
    ["http://intranet/", "host_not_allowed"],
    ["http://printer.local/", "host_not_allowed"],
    ["http://db.internal/", "host_not_allowed"],
    ["not a url", "bad_url"],
    ["https://" + "a".repeat(2050) + ".com", "bad_url"],
  ])("refuses %s (%s)", (u, code) => {
    expect(() => checkTarget(u)).toThrow(code);
  });
  it("refuses the service's own host", () => {
    expect(() => checkTarget("https://tabularium.example.dev/write", "tabularium.example.dev")).toThrow("host_not_allowed");
  });
});

describe("robotsAllows", () => {
  const txt = `
User-agent: *
Disallow: /private
Allow: /private/ok
Disallow: /*.pdf$

User-agent: BadBot
User-agent: OtherBot
Disallow: /
`;
  it("follows the * group: longest match wins, Allow wins ties", () => {
    expect(robotsAllows(txt, "/public")).toBe(true);
    expect(robotsAllows(txt, "/private/secret")).toBe(false);
    expect(robotsAllows(txt, "/private/ok/page")).toBe(true);
    expect(robotsAllows(txt, "/doc.pdf")).toBe(false);
    expect(robotsAllows(txt, "/doc.pdf?x=1")).toBe(true);
  });
  it("a group naming our token replaces the * group", () => {
    const mine = "User-agent: *\nDisallow:\n\nUser-agent: TabulariumSnapshot\nDisallow: /\n";
    expect(robotsAllows(mine, "/anything")).toBe(false);
    expect(robotsAllows("User-agent: tabulariumsnapshot\nAllow: /\nUser-agent: *\nDisallow: /\n", "/x")).toBe(true);
  });
  it("no robots.txt, an empty Disallow, or another bot's group allows everything", () => {
    expect(robotsAllows("", "/x")).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow:\n", "/x")).toBe(true);
    expect(robotsAllows("User-agent: BadBot\nDisallow: /\n", "/x")).toBe(true);
  });
});

describe("text helpers", () => {
  it("decodes entities and tidies whitespace", () => {
    expect(decodeEntities("Fish &amp; Chips &#8212; &#x2603; &nbsp;&bogus;")).toBe("Fish & Chips — ☃  &bogus;");
    expect(tidyText("  a   b \n\n\n\n  c\t\td  ")).toBe("a b\n\nc d");
  });
  it("accepts text types and refuses binaries", () => {
    for (const t of ["text/html; charset=utf-8", "application/json", "application/ld+json", "application/rss+xml", "text/plain", ""]) expect(isTextual(t)).toBe(true);
    for (const t of ["application/pdf", "image/png", "application/octet-stream", "video/mp4"]) expect(isTextual(t)).toBe(false);
  });
});

describe("signed record", async () => {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pubHex = toHex((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
  const raw = new TextEncoder().encode("<html><title>T</title><p>Hello</p></html>");
  const text = "Hello";
  const record: Snapshot = {
    v: 1, wallet: "0xabc", url: "https://example.com/", finalUrl: "https://example.com/", fetchedAt: 1790000000000, status: 200,
    contentType: "text/html", bytes: raw.byteLength, sha256: await sha256Hex(raw), textChars: text.length, textSha256: await sha256Hex(text), title: "T", truncated: false,
  };
  const sign = async (s: Snapshot) => b64encode(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, new TextEncoder().encode(snapshotMessage(s)))));
  const sig = await sign(record);

  it("the verifier accepts what the Worker signs, with and without the raw bytes", async () => {
    expect(await verifySnapshot({ snapshot: record, text, sig }, pubHex)).toMatchObject({ ok: true });
    expect(await verifySnapshot({ snapshot: record, text, sig }, pubHex, raw)).toMatchObject({ ok: true });
  });
  it("any change to the text, the record or the raw bytes is caught", async () => {
    expect((await verifySnapshot({ snapshot: record, text: "Hellp", sig }, pubHex)).ok).toBe(false);
    for (const [k, v] of Object.entries({ finalUrl: "https://evil.example/", fetchedAt: 1, status: 404, title: "X", truncated: true, wallet: "0xdef" })) {
      expect((await verifySnapshot({ snapshot: { ...record, [k]: v }, text, sig }, pubHex)).ok, k).toBe(false);
    }
    expect((await verifySnapshot({ snapshot: record, text, sig }, pubHex, new TextEncoder().encode("other"))).ok).toBe(false);
  });
  it("a workspace head signature can never pass as a snapshot signature (different domain tag)", () => {
    expect(snapshotMessage(record).startsWith("tabularium/snapshot/v1\n")).toBe(true);
  });
});

describe("fetchPage: every redirect hop and its robots.txt are checked again", async () => {
  const { fetchPage, clearRobotsCache } = await import("../src/services/snapshot");
  type Route = (url: URL) => Response;
  const withFetch = async (routes: Record<string, Route>, run: () => Promise<unknown>) => {
    const real = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      seen.push(url.href);
      const route = routes[url.origin + url.pathname] ?? routes[url.pathname];
      return route ? route(url) : new Response("not found", { status: 404 });
    }) as typeof fetch;
    clearRobotsCache();
    try {
      return { result: await run(), seen };
    } finally {
      globalThis.fetch = real;
    }
  };
  const redirect = (to: string) => () => new Response(null, { status: 302, headers: { location: to } });
  const page = () => new Response("<p>ok</p>", { status: 200, headers: { "content-type": "text/html" } });

  it("a redirect to localhost, an IP or an internal name is refused before it is fetched", async () => {
    for (const [to, code] of [["http://localhost/admin", "redirect_host_not_allowed"], ["http://127.0.0.1/", "redirect_ip_address_not_allowed"], ["http://169.254.169.254/latest", "redirect_ip_address_not_allowed"], ["http://db.internal/", "redirect_host_not_allowed"]]) {
      const { result, seen } = await withFetch({ "https://a.example.com/start": redirect(to) }, () => fetchPage(new URL("https://a.example.com/start"), "self.example.com"));
      expect(result).toMatchObject({ status: 400, error: code });
      expect(seen.some((u) => u.startsWith(to.replace(/\/[^/]*$/, "")))).toBe(false);
    }
  });
  it("a redirect into a robots.txt-disallowed path on another site is refused", async () => {
    const { result } = await withFetch(
      {
        "https://a.example.com/start": redirect("https://b.example.com/private/x"),
        "https://b.example.com/robots.txt": () => new Response("User-agent: *\nDisallow: /private\n", { status: 200 }),
        "https://b.example.com/private/x": page,
      },
      () => fetchPage(new URL("https://a.example.com/start"), "self.example.com"),
    );
    expect(result).toMatchObject({ status: 403, error: "robots_disallowed" });
  });
  it("follows allowed redirects to the final page, and gives up after five", async () => {
    const ok = await withFetch({ "https://a.example.com/1": redirect("/2"), "https://a.example.com/2": redirect("https://b.example.com/end"), "https://b.example.com/end": page }, () =>
      fetchPage(new URL("https://a.example.com/1"), "self.example.com"),
    );
    expect((ok.result as { finalUrl: URL }).finalUrl.href).toBe("https://b.example.com/end");
    const loop = await withFetch({ "/loop": redirect("/loop") }, () => fetchPage(new URL("https://a.example.com/loop"), "self.example.com"));
    expect(loop.result).toMatchObject({ status: 502, error: "too_many_redirects" });
  });
});
