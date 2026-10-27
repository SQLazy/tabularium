import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import type { FunnelKind } from "./core/funnel";

const DAY = 86_400_000;
const utcDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);

export interface Cohort {
  activeLast7d: number;
  /** Success metric: of wallets whose first paid call is at least 14 days old, the share that paid again on a later UTC day within 14 days. */
  return14d: { cohort: number; returned: number; rate: number | null };
  /** Early signal while the cohort is small: wallets that have paid on two or more UTC days. */
  multiDayWallets: number;
}

export interface Funnel {
  /** 402 price quotes served to clients that sent no payment: the earliest demand signal. */
  quoted: number;
  quotedLast7d: number;
  /** Sum over the last 7 UTC days of distinct askers per day (IP + User-Agent, hashed with a salt deleted daily). */
  dailyUniqueAskersLast7d: number;
  paid: number;
  /** A payment was sent but the call was not charged (bad or reused payment, invalid request). */
  rejected: number;
  /** quoted, by coarse client family (agentcash, x402scan, node, python, browser, ...). */
  quotedByClient: Record<string, number>;
}

export interface ServiceStats extends Cohort {
  wallets: number;
  paidCalls: number;
  revenueUsd: number;
  byCall: Record<string, { calls: number; usd: number }>;
  funnel: Funnel;
}

export interface StatsSummary extends Cohort {
  asOf: number;
  /** Distinct paying wallets across all services. */
  wallets: number;
  /** Wallets that have paid for two or more services: the platform's reuse signal. */
  crossServiceWallets: number;
  /** Charged calls from our own excluded test wallets: proves recording works without polluting the metric. */
  excludedTestCalls: number;
  /** Funnel events from our own marked test runs, kept out of every funnel. */
  excludedTestFunnelEvents: number;
  paidCalls: number;
  callsPerWallet: number | null;
  revenueUsd: number;
  /** Legacy alias: the memory service's calls (the only service before the platform split). */
  byCall: Record<string, { calls: number; usd: number }>;
  services: Record<string, ServiceStats>;
}

/**
 * One global instance. Records settled (charged) calls by service, keyed by a hashed wallet id; never keys or values.
 * Platform-wide tables (wallets, days) answer "who pays anywhere"; svc_* tables answer it per service.
 * All SQL is synchronous inside one invocation, so no lock is needed (no await between a read and its write).
 */
export class Stats extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    const x = (q: string) => this.sql.exec(q);
    x("CREATE TABLE IF NOT EXISTS wallets (id TEXT PRIMARY KEY, first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL, calls INTEGER NOT NULL, micro INTEGER NOT NULL)");
    x("CREATE TABLE IF NOT EXISTS days (id TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY (id, day))");
    // Legacy (memory-only, before the platform split); read once by the backfill below, no longer written.
    x("CREATE TABLE IF NOT EXISTS calls (call TEXT PRIMARY KEY, n INTEGER NOT NULL, micro INTEGER NOT NULL)");
    x("CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL)");
    x("CREATE TABLE IF NOT EXISTS svc_wallets (service TEXT NOT NULL, id TEXT NOT NULL, first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL, calls INTEGER NOT NULL, micro INTEGER NOT NULL, PRIMARY KEY (service, id))");
    x("CREATE TABLE IF NOT EXISTS svc_days (service TEXT NOT NULL, id TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY (service, id, day))");
    x("CREATE TABLE IF NOT EXISTS svc_calls (service TEXT NOT NULL, call TEXT NOT NULL, n INTEGER NOT NULL, micro INTEGER NOT NULL, PRIMARY KEY (service, call))");
    x("CREATE TABLE IF NOT EXISTS funnel (service TEXT NOT NULL, call TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, family TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (service, call, day, kind, family))");
    x("CREATE TABLE IF NOT EXISTS askers (day TEXT NOT NULL, service TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (day, service, id))");
    x("CREATE TABLE IF NOT EXISTS salts (day TEXT PRIMARY KEY, salt TEXT NOT NULL)");
    // Every call recorded before the split belongs to the memory service: copy it over once.
    ctx.storage.transactionSync(() => {
      if (this.sql.exec("SELECT 1 FROM counters WHERE k = 'svc_backfill'").toArray().length) return;
      this.sql.exec("INSERT OR IGNORE INTO svc_wallets SELECT 'memory', id, first_ts, last_ts, calls, micro FROM wallets");
      this.sql.exec("INSERT OR IGNORE INTO svc_days SELECT 'memory', id, day FROM days");
      this.sql.exec("INSERT OR IGNORE INTO svc_calls SELECT 'memory', call, n, micro FROM calls");
      this.sql.exec("INSERT INTO counters (k, n) VALUES ('svc_backfill', 1)");
    });
  }

  record(id: string, service: string, call: string, micro: number, ts: number): void {
    const day = utcDay(ts);
    this.ctx.storage.transactionSync(() => {
      const upsert =
        "VALUES (?, ?, ?, 1, ?) ON CONFLICT DO UPDATE SET first_ts = MIN(first_ts, excluded.first_ts), last_ts = MAX(last_ts, excluded.last_ts), calls = calls + 1, micro = micro + excluded.micro";
      this.sql.exec(`INSERT INTO wallets (id, first_ts, last_ts, calls, micro) ${upsert}`, id, ts, ts, micro);
      this.sql.exec("INSERT OR IGNORE INTO days (id, day) VALUES (?, ?)", id, day);
      this.sql.exec(
        "INSERT INTO svc_wallets (service, id, first_ts, last_ts, calls, micro) VALUES (?, ?, ?, ?, 1, ?) " +
          "ON CONFLICT DO UPDATE SET first_ts = MIN(first_ts, excluded.first_ts), last_ts = MAX(last_ts, excluded.last_ts), calls = calls + 1, micro = micro + excluded.micro",
        service,
        id,
        ts,
        ts,
        micro,
      );
      this.sql.exec("INSERT OR IGNORE INTO svc_days (service, id, day) VALUES (?, ?, ?)", service, id, day);
      this.sql.exec(
        "INSERT INTO svc_calls (service, call, n, micro) VALUES (?, ?, 1, ?) ON CONFLICT DO UPDATE SET n = n + 1, micro = micro + excluded.micro",
        service,
        call,
        micro,
      );
    });
  }

  recordExcluded(): void {
    this.bump("excluded");
  }

  recordExcludedFunnel(): void {
    this.bump("excluded_funnel");
  }

  private bump(k: string): void {
    this.sql.exec("INSERT INTO counters (k, n) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET n = n + 1", k);
  }

  /** One funnel event. `asker` (IP + User-Agent) is only hashed with today's salt, never stored as given. */
  async funnel(service: string, call: string, kind: FunnelKind, family: string, ts: number, asker?: string): Promise<void> {
    const day = utcDay(ts);
    this.sql.exec(
      "INSERT INTO funnel (service, call, day, kind, family, n) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT DO UPDATE SET n = n + 1",
      service,
      call,
      day,
      kind,
      family,
    );
    if (kind !== "quoted" || !asker) return;
    // Today's salt: created on first use, and every older salt deleted, so yesterday's hashes become unlinkable.
    // Read-then-insert with no await between: atomic within this object.
    let salt = this.sql.exec("SELECT salt FROM salts WHERE day = ?", day).toArray()[0]?.salt as string | undefined;
    if (!salt) {
      salt = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
      this.sql.exec("INSERT OR IGNORE INTO salts (day, salt) VALUES (?, ?)", day, salt);
      salt = this.sql.exec("SELECT salt FROM salts WHERE day = ?", day).one().salt as string;
    }
    this.sql.exec("DELETE FROM salts WHERE day < ?", day);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}\n${asker}`));
    const id = Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
    this.sql.exec("INSERT OR IGNORE INTO askers (day, service, id) VALUES (?, ?, ?)", day, service, id);
  }

  // /stats is public. The cohort-style queries scan every wallet and day, so for live reads they are cached for a
  // minute; the cheap totals stay live, so a fresh call shows up at once.
  private heavyCache: { at: number; value: { platform: Cohort; services: Record<string, Cohort>; crossServiceWallets: number } } | null = null;

  /** `serviceIds`: every registered service, so each appears in /stats even before its first event. */
  summary(now: number, live = true, serviceIds: string[] = []): StatsSummary {
    const fresh = live && this.heavyCache && now - this.heavyCache.at < 60_000;
    const heavy = fresh ? this.heavyCache!.value : this.heavy(now);
    if (live && !fresh) this.heavyCache = { at: now, value: heavy };
    const counter = (k: string) => (this.sql.exec("SELECT n FROM counters WHERE k = ?", k).toArray()[0]?.n as number) ?? 0;
    const wallets = (this.sql.exec("SELECT COUNT(*) AS n FROM wallets").one() as { n: number }).n;

    const services: Record<string, ServiceStats> = {};
    const ids = new Set<string>([
      ...serviceIds,
      ...this.sql.exec("SELECT DISTINCT service FROM svc_calls").toArray().map((r) => r.service as string),
      ...this.sql.exec("SELECT DISTINCT service FROM funnel").toArray().map((r) => r.service as string),
      ...Object.keys(heavy.services),
    ]);
    let calls = 0;
    let micro = 0;
    for (const s of [...ids].sort()) {
      const byCall: ServiceStats["byCall"] = {};
      let sc = 0;
      let sm = 0;
      for (const r of this.sql.exec("SELECT call, n, micro FROM svc_calls WHERE service = ? ORDER BY call", s).toArray()) {
        byCall[r.call as string] = { calls: r.n as number, usd: (r.micro as number) / 1e6 };
        sc += r.n as number;
        sm += r.micro as number;
      }
      calls += sc;
      micro += sm;
      services[s] = {
        wallets: (this.sql.exec("SELECT COUNT(*) AS n FROM svc_wallets WHERE service = ?", s).one() as { n: number }).n,
        paidCalls: sc,
        revenueUsd: sm / 1e6,
        byCall,
        ...(heavy.services[s] ?? { activeLast7d: 0, return14d: { cohort: 0, returned: 0, rate: null }, multiDayWallets: 0 }),
        funnel: this.funnelFor(s, now),
      };
    }
    return {
      asOf: now,
      wallets,
      crossServiceWallets: heavy.crossServiceWallets,
      excludedTestCalls: counter("excluded"),
      excludedTestFunnelEvents: counter("excluded_funnel"),
      paidCalls: calls,
      callsPerWallet: wallets ? calls / wallets : null,
      revenueUsd: micro / 1e6,
      byCall: services.memory?.byCall ?? {},
      ...heavy.platform,
      services,
    };
  }

  private funnelFor(service: string, now: number): Funnel {
    const since = utcDay(now - 6 * DAY); // today and the 6 UTC days before it
    const sum = (where: string, ...b: unknown[]) =>
      (this.sql.exec(`SELECT COALESCE(SUM(n), 0) AS n FROM funnel WHERE service = ? AND ${where}`, service, ...b).one() as { n: number }).n;
    const quotedByClient: Record<string, number> = {};
    for (const r of this.sql.exec("SELECT family, SUM(n) AS n FROM funnel WHERE service = ? AND kind = 'quoted' GROUP BY family ORDER BY family", service).toArray()) {
      quotedByClient[r.family as string] = r.n as number;
    }
    return {
      quoted: sum("kind = 'quoted'"),
      quotedLast7d: sum("kind = 'quoted' AND day >= ?", since),
      dailyUniqueAskersLast7d: (this.sql.exec("SELECT COUNT(*) AS n FROM askers WHERE service = ? AND day >= ?", service, since).one() as { n: number }).n,
      paid: sum("kind = 'paid'"),
      rejected: sum("kind = 'rejected'"),
      quotedByClient,
    };
  }

  private cohort(walletsTable: string, daysTable: string, where: string, now: number, ...b: unknown[]): Cohort {
    const one = (q: string, ...p: unknown[]) => this.sql.exec(q, ...p).one() as Record<string, number>;
    const and = where ? ` AND ${where}` : "";
    const active = one(`SELECT COUNT(*) AS n FROM ${walletsTable} w WHERE w.last_ts >= ?${and}`, now - 7 * DAY, ...b).n;
    // Cohort: first paid call at least 14 days before now. Returned: any paid day after the first day, within 14 days.
    const dayJoin = where ? " AND d.service = w.service" : "";
    const rows = this.sql
      .exec(
        `SELECT w.id, (SELECT COUNT(*) FROM ${daysTable} d WHERE d.id = w.id${dayJoin} AND d.day > date(w.first_ts / 1000, 'unixepoch') ` +
          `AND d.day <= date(w.first_ts / 1000, 'unixepoch', '+14 days')) AS later FROM ${walletsTable} w WHERE w.first_ts <= ?${and}`,
        now - 14 * DAY,
        ...b,
      )
      .toArray();
    const returned = rows.filter((r) => (r.later as number) > 0).length;
    const multiWhere = where ? ` WHERE ${where.replace(/w\./g, "")}` : "";
    const multi = one(`SELECT COUNT(*) AS n FROM (SELECT id FROM ${daysTable}${multiWhere} GROUP BY id HAVING COUNT(*) >= 2)`, ...b).n;
    return { activeLast7d: active, return14d: { cohort: rows.length, returned, rate: rows.length ? returned / rows.length : null }, multiDayWallets: multi };
  }

  private heavy(now: number) {
    const services: Record<string, Cohort> = {};
    for (const r of this.sql.exec("SELECT DISTINCT service FROM svc_wallets").toArray()) {
      const s = r.service as string;
      services[s] = this.cohort("svc_wallets", "svc_days", "w.service = ?", now, s);
    }
    const cross = (this.sql.exec("SELECT COUNT(*) AS n FROM (SELECT id FROM svc_wallets GROUP BY id HAVING COUNT(*) >= 2)").one() as { n: number }).n;
    return { platform: this.cohort("wallets", "days", "", now), services, crossServiceWallets: cross };
  }
}
