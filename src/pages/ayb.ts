// /allyourbase: a joke with a point. What machines paid over x402 on Base in the last 24 hours (counted hourly by
// .github/workflows/ayb.yml from public chain data into the ayb-data branch), plus a "Wrapped" card for any wallet,
// computed in the visitor's browser from a public Base node. Free; it exists to make people curious about receipts.
// The Zero Wing lines are internet folklore; the page uses no art from the game.
import type { Hono } from "hono";
import type { Env } from "../env";
import { AYB_CLIENT } from "./ayb-client";

const DATA = "https://raw.githubusercontent.com/SQLazy/tabularium/ayb-data";
const RPC = "https://base-rpc.publicnode.com";

type Ticker = { asOf: string; usd: number; payments: number; payers: number; activeSellers: number; listedSellers: number; top: { seller: string; usd: number; payments: number }[]; perHourUsd: number[]; biggest: { usd: number; seller: string } | null; definition: string };

async function upstream(path: string, ttl: number): Promise<Response> {
  const res = await fetch(`${DATA}/${path}`, { cf: { cacheTtl: ttl, cacheEverything: true } } as RequestInit);
  return res;
}

async function ticker(): Promise<Ticker | null> {
  try {
    const res = await upstream("ticker.json", 300);
    return res.ok ? ((await res.json()) as Ticker) : null;
  } catch {
    return null;
  }
}

// JSON inside a <script>: escape "<" so a seller name like "</script>" cannot end the script (names come from the
// Bazaar, which anyone can write to).
const BACKSLASH_U = String.fromCharCode(92) + "u";
const LINE_SEPARATORS = new RegExp("[" + String.fromCharCode(0x2028, 0x2029) + "]", "g");
const safeJson = (v: unknown) =>
  JSON.stringify(v)
    .replace(/</g, BACKSLASH_U + "003c")
    .replace(LINE_SEPARATORS, (c) => BACKSLASH_U + c.charCodeAt(0).toString(16));
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const money = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function page(origin: string, t: Ticker | null): string {
  const headline = t ? `Machines paid ${money(t.usd)} on Base in the last 24 hours over x402.` : "Machines are paying each other on Base over x402. Counting...";
  const url = `${origin}/allyourbase`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ALL YOUR BASE ARE BELONG TO US</title>
<meta name="description" content="${esc(headline)} How much did your agent spend?">
<meta property="og:title" content="ALL YOUR BASE ARE BELONG TO US">
<meta property="og:description" content="${esc(headline)} How much did your agent spend?">
<meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="ALL YOUR BASE ARE BELONG TO US">
<meta name="twitter:description" content="${esc(headline)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" rel="stylesheet">
<style>
:root { --bg:#05060a; --fg:#e8e8e8; --dim:#8a8f98; --hot:#ffd43b; --cat:#ff5c5c; --ok:#58e07a; --line:#1c2030; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font-family:"Press Start 2P", ui-monospace, monospace; font-size:13px; line-height:1.9; }
body::after { content:""; position:fixed; inset:0; pointer-events:none; background:repeating-linear-gradient(0deg, rgba(0,0,0,.25) 0 1px, transparent 1px 3px); }
main { max-width:780px; margin:0 auto; padding:32px 16px 64px; }
.script p { margin:0 0 6px; white-space:pre-wrap; }
.who { color:var(--dim); }
.cats .who, .cats { color:var(--cat); }
.big { font-size:clamp(28px, 7vw, 54px); color:var(--hot); margin:28px 0 8px; line-height:1.3; }
.sub { color:var(--dim); font-size:11px; }
.grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:10px; margin:18px 0; }
.box { border:2px solid var(--line); padding:12px; }
.box b { display:block; color:var(--hot); font-size:16px; font-weight:normal; }
.bars { display:flex; gap:2px; align-items:flex-end; height:60px; margin:14px 0 4px; }
.bars span { flex:1; background:var(--ok); min-height:2px; }
ol { padding-left:22px; margin:8px 0; } li { margin-bottom:4px; }
form { display:flex; gap:8px; flex-wrap:wrap; margin:14px 0; }
input { flex:1; min-width:240px; font:inherit; font-size:11px; padding:12px; background:#0d0f17; color:var(--fg); border:2px solid var(--line); }
button, .btn { font:inherit; font-size:11px; padding:12px 14px; background:var(--hot); color:#000; border:0; cursor:pointer; text-decoration:none; display:inline-block; }
.card { border:3px solid var(--hot); padding:18px; margin:16px 0; }
.card h3 { margin:0 0 6px; color:var(--cat); font-weight:normal; font-size:14px; }
.why { margin-top:40px; border-top:2px dashed var(--line); padding-top:20px; }
a { color:var(--ok); }
footer { margin-top:48px; color:var(--dim); font-size:9px; line-height:1.8; }
.hide { display:none; }
@media (prefers-reduced-motion: reduce) { body::after { display:none; } }
</style>
</head>
<body>
<main>
<section class="script" id="intro">
<p>IN A.D. 2026</p>
<p>WAR WAS BEGINNING.</p>
<p><span class="who">CAPTAIN:</span> WHAT HAPPEN ?</p>
<p><span class="who">MECHANIC:</span> SOMEBODY SET UP US THE BOT.</p>
<p><span class="who">OPERATOR:</span> WE GET SIGNAL.</p>
<p><span class="who">CAPTAIN:</span> WHAT !</p>
<p><span class="who">OPERATOR:</span> MAIN SCREEN TURN ON.</p>
<p><span class="who">CAPTAIN:</span> IT'S YOU !!</p>
<p class="cats"><span class="who">AGENTS:</span> HOW ARE YOU GENTLEMEN !!</p>
<p class="cats"><span class="who">AGENTS:</span> ALL YOUR BASE ARE BELONG TO US.</p>
</section>

<section id="ticker">
<div class="big" id="usd">${t ? esc(money(t.usd)) : "COUNTING..."}</div>
<div>PAID BY MACHINES ON BASE IN THE LAST 24 HOURS, OVER x402.</div>
<div class="grid">
<div class="box"><b id="payments">${t ? t.payments.toLocaleString("en-US") : "-"}</b>PAYMENTS</div>
<div class="box"><b id="payers">${t ? t.payers.toLocaleString("en-US") : "-"}</b>PAYING WALLETS</div>
<div class="box"><b id="sellers">${t ? t.activeSellers.toLocaleString("en-US") : "-"}</b>SELLERS PAID</div>
</div>
<div class="bars" id="bars" aria-hidden="true"></div>
<div class="sub">LAST 24 HOURS, ONE BAR PER HOUR. UPDATED HOURLY. <span id="asof">${t ? "AS OF " + esc(new Date(t.asOf).toISOString().slice(0, 16).replace("T", " ")) + " UTC" : ""}</span></div>
<p>TOP SELLERS:</p>
<ol id="top">${t ? t.top.slice(0, 5).map((s) => `<li>${esc(s.seller)}: ${esc(money(s.usd))} (${s.payments.toLocaleString("en-US")})</li>`).join("") : ""}</ol>
</section>

<section class="script">
<p class="cats"><span class="who">AGENTS:</span> YOU ARE ON THE WAY TO DESTRUCTION.</p>
<p><span class="who">CAPTAIN:</span> WHAT YOU SAY !!</p>
<p class="cats"><span class="who">AGENTS:</span> YOU HAVE NO CHANCE TO SURVIVE MAKE YOUR TIME.</p>
</section>

<section id="wrapped">
<p>WHAT DID <span style="color:var(--hot)">YOUR</span> AGENT BUY THIS WEEK?</p>
<form id="f">
<input id="w" placeholder="0x... your agent's wallet on Base" autocomplete="off" spellcheck="false" pattern="0x[0-9a-fA-F]{40}" required>
<button>MAIN SCREEN TURN ON</button>
</form>
<div class="sub" id="status"></div>
<div class="card hide" id="card"></div>
</section>

<section class="why script">
<p class="cats"><span class="who">AGENTS:</span> HA HA HA HA ....</p>
<p><span class="who">CAPTAIN:</span> TAKE OFF EVERY 'ZIG' !!</p>
<p><span class="who">CAPTAIN:</span> YOU KNOW WHAT YOU DOING.</p>
<p><span class="who">CAPTAIN:</span> FOR GREAT JUSTICE.</p>
<p style="margin-top:18px">THE CHAIN SHOWS WHAT YOUR AGENT PAID. IT NEVER SHOWS <span style="color:var(--hot)">WHY</span>.</p>
<p>TABULARIUM GIVES EVERY PURCHASE A SIGNED RECEIPT: THE REASON (SIGNED BY THE WALLET BEFORE IT PAID), THE EXACT TERMS, THE TRANSACTION AND A HASH OF WHAT CAME BACK. VERIFIABLE OFFLINE.</p>
<p><a class="btn" href="https://github.com/SQLazy/tabularium#readme">KEEP RECEIPTS</a> &nbsp; <a href="${esc(origin)}/llms.txt">FOR AGENTS: /llms.txt</a></p>
</section>

<footer>
<p id="def">${t ? esc(t.definition) : ""} YOUR WALLET'S CARD IS COMPUTED IN YOUR BROWSER FROM A PUBLIC BASE NODE; NOTHING IS SENT TO US.</p>
<p>"ALL YOUR BASE ARE BELONG TO US" IS FROM ZERO WING (1989) AND HAS BELONGED TO THE INTERNET SINCE 2001. NO ART FROM THE GAME IS USED. NOT AFFILIATED WITH COINBASE OR BASE.</p>
</footer>
</main>
<script>
${AYB_CLIENT}
const RPC = ${safeJson(RPC)};
const PAGE = ${safeJson(url)};
const fmt = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 });
const T = ${safeJson(t)};
function bars(per) {
  const max = Math.max(...per, 0.0001);
  document.getElementById("bars").innerHTML = per.map((v) => '<span style="height:' + Math.max(3, Math.round((v / max) * 100)) + '%" title="' + fmt(v) + '"></span>').join("");
}
if (T) bars(T.perHourUsd);
let names = null;
const namesReady = fetch("/ayb/names.json").then((r) => (r.ok ? r.json() : {})).then((n) => (names = n)).catch(() => (names = {}));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const w = document.getElementById("w").value.trim();
  const status = document.getElementById("status");
  const card = document.getElementById("card");
  if (!/^0x[0-9a-fA-F]{40}$/.test(w)) { status.textContent = "THAT IS NOT A WALLET. 0x + 40 HEX."; return; }
  status.textContent = "WE GET SIGNAL... READING 7 DAYS OF BASE.";
  card.classList.add("hide");
  try {
    const [payments] = await Promise.all([walletPayments(RPC, w, 7), namesReady]);
    const s = summarize(payments, names);
    const short = w.slice(0, 6) + "…" + w.slice(-4);
    const lines = s.n
      ? [
          "<h3>" + esc(short) + ": " + esc(s.personality.title) + "</h3>",
          "<p>SPENT <b style='color:var(--hot)'>" + fmt(s.usd) + "</b> ON " + s.n + " x402 PURCHASE" + (s.n === 1 ? "" : "S") + " FROM " + s.sellers + " SELLER" + (s.sellers === 1 ? "" : "S") + " IN 7 DAYS.</p>",
          "<p>FAVOURITE: " + esc(s.top[0].seller) + " (" + s.top[0].n + ")</p>",
          "<p>BIGGEST PURCHASE: " + fmt(s.biggest.usd) + " AT " + esc(s.biggest.seller) + "</p>",
          s.busiestDay ? "<p>BUSIEST DAY: " + esc(s.busiestDay.toUpperCase()) + "</p>" : "",
          "<p style='color:var(--cat)'>" + esc(s.personality.line) + "</p>",
          "<p class='sub'>AND WHY DID IT BUY THEM? THE CHAIN WILL NEVER SAY. A RECEIPT WOULD.</p>",
        ]
      : ["<h3>" + esc(short) + ": " + esc(s.personality.title) + "</h3>", "<p>NO x402 PURCHASES IN THE LAST 7 DAYS.</p>", "<p style='color:var(--cat)'>" + esc(s.personality.line) + "</p>"];
    const text = s.n
      ? "My agent spent " + fmt(s.usd) + " on " + s.n + " x402 purchases this week. Personality: " + s.personality.title + ". ALL YOUR BASE ARE BELONG TO US."
      : "My agent has not joined the war yet. Machines paid " + (T ? fmt(T.usd) : "a lot") + " on Base in 24 hours. ALL YOUR BASE ARE BELONG TO US.";
    lines.push("<p><a class='btn' target='_blank' rel='noopener' href='https://x.com/intent/post?text=" + encodeURIComponent(text) + "&url=" + encodeURIComponent(PAGE) + "'>SHARE: FOR GREAT JUSTICE</a></p>");
    card.innerHTML = lines.join("");
    card.classList.remove("hide");
    status.textContent = "";
  } catch (err) {
    status.textContent = "SOMEBODY SET UP US THE BOMB: " + String(err && err.message || err).slice(0, 120).toUpperCase();
  }
});
</script>
</body>
</html>`;
}

/** Registers the free /allyourbase page and its two data files on the app. */
export function registerAyb(app: Hono<{ Bindings: Env }>): void {
  app.get("/allyourbase", async (c) => {
    c.header("Cache-Control", "public, max-age=120");
    return c.html(page(new URL(c.req.url).origin, await ticker()));
  });
  app.get("/ayb", (c) => c.redirect("/allyourbase", 301));
  for (const [name, ttl] of [["ticker.json", 300], ["names.json", 3600]] as const) {
    app.get(`/ayb/${name}`, async (c) => {
      const res = await upstream(name, ttl).catch(() => null);
      if (!res?.ok) return c.json({ error: "not_ready", detail: "counted hourly; the first count may not have landed yet" }, 503);
      return new Response(res.body, { headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttl}`, "access-control-allow-origin": "*" } });
    });
  }
}
