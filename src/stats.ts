import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

const DAY = 86_400_000;
const utcDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);

export interface StatsSummary {
  asOf: number;
  wallets: number;
  activeLast7d: number;
  /** Success metric: of wallets whose first paid call is at least 14 days old, the share that paid again on a later UTC day within 14 days. */
  return14d: { cohort: number; returned: number; rate: number | null };
  /** Early signal while the cohort is small: wallets that have paid on two or more UTC days. */
  multiDayWallets: number;
  /** Charged calls from our own excluded test wallets: proves recording works without polluting the metric. */
  excludedTestCalls: number;
  paidCalls: number;
  callsPerWallet: number | null;
  revenueUsd: number;
  byCall: Record<string, { calls: number; usd: number }>;
}

/**
 * One global instance. Records settled (charged) calls only, keyed by a hashed wallet id; never keys or values.
 * All SQL is synchronous inside one invocation, so no lock is needed (there is no await between read and write).
 */
export class Stats extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS wallets (id TEXT PRIMARY KEY, first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL, calls INTEGER NOT NULL, micro INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS days (id TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY (id, day))");
    this.sql.exec("CREATE TABLE IF NOT EXISTS calls (call TEXT PRIMARY KEY, n INTEGER NOT NULL, micro INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL)");
  }

  record(id: string, call: string, micro: number, ts: number): void {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT INTO wallets (id, first_ts, last_ts, calls, micro) VALUES (?, ?, ?, 1, ?) " +
          "ON CONFLICT(id) DO UPDATE SET first_ts = MIN(first_ts, excluded.first_ts), last_ts = MAX(last_ts, excluded.last_ts), calls = calls + 1, micro = micro + excluded.micro",
        id,
        ts,
        ts,
        micro,
      );
      this.sql.exec("INSERT OR IGNORE INTO days (id, day) VALUES (?, ?)", id, utcDay(ts));
      this.sql.exec(
        "INSERT INTO calls (call, n, micro) VALUES (?, 1, ?) ON CONFLICT(call) DO UPDATE SET n = n + 1, micro = micro + excluded.micro",
        call,
        micro,
      );
    });
  }

  recordExcluded(): void {
    this.sql.exec("INSERT INTO counters (k, n) VALUES ('excluded', 1) ON CONFLICT(k) DO UPDATE SET n = n + 1");
  }

  // /stats is public. The cohort-style queries scan every wallet and day, so for live reads they are cached for a
  // minute; the cheap totals (a handful of rows) stay live, so a fresh call shows up at once.
  private heavyCache: { at: number; value: Pick<StatsSummary, "activeLast7d" | "return14d" | "multiDayWallets"> } | null = null;

  summary(now: number, live = true): StatsSummary {
    const fresh = live && this.heavyCache && now - this.heavyCache.at < 60_000;
    const heavy = fresh ? this.heavyCache!.value : this.heavy(now);
    if (live && !fresh) this.heavyCache = { at: now, value: heavy };
    return { asOf: now, ...this.light(), ...heavy };
  }

  private light(): Pick<StatsSummary, "wallets" | "excludedTestCalls" | "paidCalls" | "callsPerWallet" | "revenueUsd" | "byCall"> {
    const wallets = (this.sql.exec("SELECT COUNT(*) AS n FROM wallets").one() as { n: number }).n;
    const byCall: StatsSummary["byCall"] = {};
    let calls = 0;
    let micro = 0;
    for (const r of this.sql.exec("SELECT call, n, micro FROM calls ORDER BY call").toArray()) {
      byCall[r.call as string] = { calls: r.n as number, usd: (r.micro as number) / 1e6 };
      calls += r.n as number;
      micro += r.micro as number;
    }
    return {
      wallets,
      excludedTestCalls: (this.sql.exec("SELECT n FROM counters WHERE k = 'excluded'").toArray()[0]?.n as number) ?? 0,
      paidCalls: calls,
      callsPerWallet: wallets ? calls / wallets : null,
      revenueUsd: micro / 1e6,
      byCall,
    };
  }

  private heavy(now: number): Pick<StatsSummary, "activeLast7d" | "return14d" | "multiDayWallets"> {
    const one = (q: string, ...b: unknown[]) => this.sql.exec(q, ...b).one() as Record<string, number>;
    const active = one("SELECT COUNT(*) AS n FROM wallets WHERE last_ts >= ?", now - 7 * DAY).n;
    // Cohort: first paid call at least 14 days before now. Returned: any paid day after the first day, within 14 days.
    const cohort = this.sql
      .exec(
        "SELECT w.id, (SELECT COUNT(*) FROM days d WHERE d.id = w.id AND d.day > date(w.first_ts / 1000, 'unixepoch') " +
          "AND d.day <= date(w.first_ts / 1000, 'unixepoch', '+14 days')) AS later FROM wallets w WHERE w.first_ts <= ?",
        now - 14 * DAY,
      )
      .toArray();
    const returned = cohort.filter((r) => (r.later as number) > 0).length;
    const multi = one("SELECT COUNT(*) AS n FROM (SELECT id FROM days GROUP BY id HAVING COUNT(*) >= 2)").n;
    return {
      activeLast7d: active,
      return14d: { cohort: cohort.length, returned, rate: cohort.length ? returned / cohort.length : null },
      multiDayWallets: multi,
    };
  }
}
