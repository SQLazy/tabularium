import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { GENESIS, entryHash, sha256Hex, type Entry } from "./chain";
import { POLICY } from "./policy";

export type WorkspaceState = "new" | "active" | "grace" | "gone";

export interface Head {
  seq: number;
  hash: string;
}

type Fail = { ok: false; status: 404 | 409 | 413; error: string; expiresAt?: number; graceEndsAt?: number };

const ENTRY_COLS = "seq, ts, op, key, value_hash AS valueHash, prev, hash";

/**
 * One Durable Object per paying wallet. SQLite-backed.
 * Every mutation appends to a hash chain; the kv table is a materialized view of it.
 */
export class Workspace extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
  }

  // Mutex for mutations. blockConcurrencyWhile is NOT one: it only stops *new* events from being
  // delivered, so invocations already in flight still interleave at any await that yields (a timer,
  // R2, fetch) and fork the chain (we reproduced "UNIQUE constraint failed: log.seq" with it).
  // All invocations of one Durable Object share this instance, so a promise chain is a real lock.
  private queue: Promise<void> = Promise.resolve();
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // deleteAll() (purge) drops the schema while the instance may stay alive, so ensure on every call.
  private ensureSchema(): void {
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS log (seq INTEGER PRIMARY KEY, ts INTEGER NOT NULL, op TEXT NOT NULL, key TEXT NOT NULL, value_hash TEXT NOT NULL, prev TEXT NOT NULL, hash TEXT NOT NULL)",
    );
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, seq INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    // Idempotency: id -> the entry it produced, plus a fingerprint of (key, value) to catch id reuse.
    this.sql.exec("CREATE TABLE IF NOT EXISTS idem (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, fp TEXT NOT NULL, ts INTEGER NOT NULL)");
    // Payment nonces this workspace has served. One signed payment buys one call (see claimPayment).
    this.sql.exec("CREATE TABLE IF NOT EXISTS pay_nonces (nonce TEXT PRIMARY KEY, ts INTEGER NOT NULL)");
  }

  private getMeta(k: string): string | null {
    const r = this.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray();
    return r.length ? (r[0].v as string) : null;
  }

  private setMeta(k: string, v: string): void {
    this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
  }

  private last(): Entry | null {
    const r = this.sql.exec(`SELECT ${ENTRY_COLS} FROM log ORDER BY seq DESC LIMIT 1`).toArray();
    return r.length ? (r[0] as unknown as Entry) : null;
  }

  private status(now: number): { state: WorkspaceState; expiresAt: number; graceEndsAt: number } {
    const exp = this.getMeta("expires_at");
    if (exp === null) return { state: "new", expiresAt: 0, graceEndsAt: 0 };
    const expiresAt = Number(exp);
    const graceEndsAt = expiresAt + POLICY.GRACE_MS;
    if (now <= expiresAt) return { state: "active", expiresAt, graceEndsAt };
    if (now <= graceEndsAt) return { state: "grace", expiresAt, graceEndsAt };
    return { state: "gone", expiresAt, graceEndsAt };
  }

  /** Computes the next chain entry without writing. Only call inside serialize(). */
  protected async nextEntry(now: number, op: Entry["op"], key: string, valueHash: string): Promise<Entry> {
    const prevEntry = this.last();
    const base = {
      seq: prevEntry ? prevEntry.seq + 1 : 1,
      ts: now,
      op,
      key,
      valueHash,
      prev: prevEntry ? prevEntry.hash : GENESIS,
    };
    return { ...base, hash: await entryHash(base) };
  }

  private insertLog(e: Entry): void {
    this.sql.exec(
      "INSERT INTO log (seq, ts, op, key, value_hash, prev, hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
      e.seq,
      e.ts,
      e.op,
      e.key,
      e.valueHash,
      e.prev,
      e.hash,
    );
  }

  private async scheduleAlarm(expiresAt: number): Promise<void> {
    await this.ctx.storage.setAlarm(expiresAt + POLICY.GRACE_MS + 1000);
  }

  /**
   * Claims a payment nonce for one call. False if it was already used.
   * Why: with settle-after-handler, the same signed payment sent N times at once passes verification N times and
   * runs N handlers, but settles only once. Every request paying from one wallet lands in this one object, and this
   * check-and-insert is a single synchronous statement, so concurrent claims cannot both win.
   */
  claimPayment(nonce: string): boolean {
    this.ensureSchema();
    const now = Date.now();
    // Look-up then insert, with no await in between: atomic within this object. (rowsWritten is not a usable
    // "did the insert happen" flag: it also counts index writes.)
    if (this.sql.exec("SELECT 1 FROM pay_nonces WHERE nonce = ?", nonce).toArray().length) return false;
    this.sql.exec("INSERT INTO pay_nonces (nonce, ts) VALUES (?, ?)", nonce, now);
    const won = true;
    // An authorization is valid for minutes (maxTimeoutSeconds); a day of history is plenty.
    this.sql.exec("DELETE FROM pay_nonces WHERE ts < ?", now - 86_400_000);
    return won;
  }

  // ---- the four paid calls (+ head, free) -------------------------------------------------

  async write(
    key: string,
    value: string,
    idempotencyKey?: string,
  ): Promise<{ ok: true; entry: Entry; expiresAt: number; replayed?: true } | Fail> {
    // Serialized per workspace: two writes must never read the same chain head.
    return this.serialize(async () => {
      this.ensureSchema();
      const now = Date.now();
      const st = this.status(now);
      const fp = idempotencyKey ? await sha256Hex(`${key}\n${value}`) : undefined;
      if (idempotencyKey && fp && (st.state === "active" || st.state === "grace")) {
        const prior = this.sql.exec("SELECT seq, fp FROM idem WHERE id = ?", idempotencyKey).toArray()[0];
        if (prior) {
          // Same id, different request: refuse rather than silently return someone else's entry.
          if (prior.fp !== fp) return { ok: false, status: 409, error: "idempotency_key_reuse" } as Fail;
          const entry = this.sql.exec(`SELECT ${ENTRY_COLS} FROM log WHERE seq = ?`, prior.seq as number).toArray()[0] as unknown as Entry;
          return { ok: true as const, entry, expiresAt: st.expiresAt, replayed: true as const };
        }
      }
      if (st.state === "gone") return this.purgedAsNew(now, key, value, idempotencyKey, fp);
      if (st.state === "grace") {
        return { ok: false, status: 409, error: "workspace_lapsed", expiresAt: st.expiresAt, graceEndsAt: st.graceEndsAt } as Fail;
      }
      if (new TextEncoder().encode(value).length > POLICY.MAX_VALUE_BYTES) {
        return { ok: false, status: 413, error: "value_too_large" } as Fail;
      }
      return this.commitWrite(now, key, value, st.state === "new", idempotencyKey, fp);
    });
  }

  // "gone" is only reachable if the purge alarm hasn't run yet; treat as a fresh workspace.
  private async purgedAsNew(now: number, key: string, value: string, idempotencyKey?: string, fp?: string) {
    await this.ctx.storage.deleteAll();
    this.ensureSchema();
    return this.commitWrite(now, key, value, true, idempotencyKey, fp);
  }

  private async commitWrite(now: number, key: string, value: string, isNew: boolean, idempotencyKey?: string, fp?: string) {
    const valueHash = await sha256Hex(value);
    const entry = await this.nextEntry(now, "write", key, valueHash);
    const expiresAt = isNew ? now + POLICY.TERM_MS : Number(this.getMeta("expires_at"));
    // One transaction: the chain, the value view, and the term can never disagree, even across a crash.
    this.ctx.storage.transactionSync(() => {
      this.insertLog(entry);
      this.sql.exec(
        "INSERT INTO kv (key, value, seq) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, seq = excluded.seq",
        key,
        value,
        entry.seq,
      );
      if (isNew) {
        this.setMeta("created_at", String(now));
        this.setMeta("expires_at", String(expiresAt));
      }
      if (idempotencyKey && fp) {
        this.sql.exec("INSERT INTO idem (id, seq, fp, ts) VALUES (?, ?, ?, ?)", idempotencyKey, entry.seq, fp, now);
        this.sql.exec("DELETE FROM idem WHERE ts < ?", now - POLICY.IDEMPOTENCY_MS); // keep the table bounded
      }
    });
    if (isNew) await this.scheduleAlarm(expiresAt);
    return { ok: true as const, entry, expiresAt };
  }

  async read(
    key: string,
  ): Promise<{ ok: true; key: string; value: string; entry: Entry; expiresAt: number; state: WorkspaceState } | Fail> {
    this.ensureSchema();
    const st = this.status(Date.now());
    if (st.state === "new" || st.state === "gone") return { ok: false, status: 404, error: "no_workspace" };
    const row = this.sql.exec("SELECT value, seq FROM kv WHERE key = ?", key).toArray()[0];
    if (!row) return { ok: false, status: 404, error: "no_such_key" };
    const entry = this.sql
      .exec(`SELECT ${ENTRY_COLS} FROM log WHERE seq = ?`, row.seq as number)
      .toArray()[0] as unknown as Entry;
    return { ok: true, key, value: row.value as string, entry, expiresAt: st.expiresAt, state: st.state };
  }

  async renew(): Promise<{ ok: true; entry: Entry; expiresAt: number } | Fail> {
    return this.serialize(async () => {
      this.ensureSchema();
      const now = Date.now();
      const st = this.status(now);
      if (st.state === "new" || st.state === "gone") return { ok: false, status: 404, error: "no_workspace" } as Fail;
      // Extend from the later of now and the current expiry: renewing early never wastes paid time.
      const expiresAt = Math.max(now, st.expiresAt) + POLICY.TERM_MS;
      const entry = await this.nextEntry(now, "renew", "", GENESIS);
      this.ctx.storage.transactionSync(() => {
        this.insertLog(entry);
        this.setMeta("expires_at", String(expiresAt));
      });
      await this.scheduleAlarm(expiresAt);
      return { ok: true, entry, expiresAt };
    });
  }

  async export(since: number): Promise<
    | {
        ok: true;
        state: WorkspaceState;
        expiresAt: number;
        anchor: string;
        entries: Entry[];
        values: Record<string, { value: string; seq: number }>;
        head: Head;
      }
    | Fail
  > {
    this.ensureSchema();
    const st = this.status(Date.now());
    if (st.state === "new" || st.state === "gone") return { ok: false, status: 404, error: "no_workspace" };
    const entries = this.sql
      .exec(`SELECT ${ENTRY_COLS} FROM log WHERE seq > ? ORDER BY seq ASC`, since)
      .toArray() as unknown as Entry[];
    const anchorRow = since > 0 ? this.sql.exec("SELECT hash FROM log WHERE seq = ?", since).toArray()[0] : null;
    const values: Record<string, { value: string; seq: number }> = {};
    for (const r of this.sql.exec("SELECT key, value, seq FROM kv WHERE seq > ?", since).toArray()) {
      values[r.key as string] = { value: r.value as string, seq: r.seq as number };
    }
    const head = this.last()!;
    return {
      ok: true,
      state: st.state,
      expiresAt: st.expiresAt,
      anchor: anchorRow ? (anchorRow.hash as string) : GENESIS,
      entries,
      values,
      head: { seq: head.seq, hash: head.hash },
    };
  }

  async head(): Promise<{ ok: true; head: Head; state: WorkspaceState; expiresAt: number } | Fail> {
    this.ensureSchema();
    const st = this.status(Date.now());
    const last = this.last();
    if (!last || st.state === "new" || st.state === "gone") return { ok: false, status: 404, error: "no_workspace" };
    return { ok: true, head: { seq: last.seq, hash: last.hash }, state: st.state, expiresAt: st.expiresAt };
  }

  /** The only irreversible operation: runs once, after term + grace have both elapsed. */
  async alarm(): Promise<void> {
    await this.serialize(async () => {
      this.ensureSchema();
      const st = this.status(Date.now());
      if (st.state === "gone") {
        await this.ctx.storage.deleteAll();
      } else if (st.state !== "new") {
        await this.scheduleAlarm(st.expiresAt);
      }
    });
  }
}
