import { NOW_MS } from '../db/libsql.js';

/**
 * All libSQL / SQLite access (local file or Turso). Same methods and return
 * shapes as PgRepo, so the API, worker, sync target, rollups view and report
 * builder work unchanged on either database.
 *
 * Differences from PostgreSQL, handled here:
 *   timestamps are INTEGER epoch ms, JSON is TEXT (parsed on read),
 *   bulk inserts are multi-row VALUES inside one batch transaction,
 *   transactions are `client.batch(..., 'write')`.
 *
 * Idempotency and ordering are the same as PgRepo: `id` is UNIQUE with
 * ON CONFLICT DO NOTHING ... RETURNING id, and inserts are serialised so
 * rows commit in `seq` order (AUTOINCREMENT: never reused).
 */
const clean = ({ _tokens, ...r }) => r;
const parse = (v) => (v === null || v === undefined ? null : JSON.parse(v));
const PRUNE_EVERY = 200;
const INSERT_CHUNK = 500; // rows per INSERT statement (6 params each, well under SQLite's limit)

export class LibsqlRepo {
  constructor({ client, logger }) {
    this.client = client;
    this.logger = logger;
    this.chain = Promise.resolve();
    this.events = 0;
  }

  #q(sql, args = []) {
    return this.client.execute({ sql, args });
  }

  /** @returns {Promise<object[]>} the records that were not already stored */
  insertRecords(batch) {
    const run = this.chain.then(() => this.#insert(batch));
    this.chain = run.catch(() => {});
    return run;
  }

  async #insert(batch) {
    const uniq = new Map();
    for (const r of batch) if (r && !uniq.has(r.id)) uniq.set(r.id, r);
    if (!uniq.size) return [];
    const recs = [...uniq.values()];
    const stmts = [];
    for (let i = 0; i < recs.length; i += INSERT_CHUNK) {
      const part = recs.slice(i, i + INSERT_CHUNK);
      stmts.push({
        sql: `INSERT INTO billing_records (id, ts, product, cost, data) VALUES ${part.map(() => '(?, ?, ?, ?, ?)').join(', ')}
              ON CONFLICT (id) DO NOTHING RETURNING id`,
        args: part.flatMap((r) => [r.id, r.ts, r.product, r.cost, JSON.stringify(clean(r))]),
      });
    }
    const results = await this.client.batch(stmts, 'write');
    const fresh = new Set(results.flatMap((rs) => rs.rows.map((x) => x.id)));
    return recs.filter((r) => fresh.has(r.id));
  }

  async recordCount() {
    const rs = await this.#q('SELECT count(*) AS n FROM billing_records');
    return Number(rs.rows[0].n);
  }

  /** Rows inserted after `seq`, in insertion order (API tail + hydration). */
  async recordsAfter(seq, { sinceTs = null, limit = 5_000 } = {}) {
    const rs = await this.#q(
      `SELECT seq, data FROM billing_records
        WHERE seq > ? AND (? IS NULL OR ts >= ?)
        ORDER BY seq LIMIT ?`,
      [seq, sinceTs, sinceTs, limit],
    );
    return rs.rows.map((r) => ({ seq: Number(r.seq), data: parse(r.data) }));
  }

  // ---- key/value documents --------------------------------------------
  async getKv(key) {
    const rs = await this.#q('SELECT value FROM kv WHERE key = ?', [key]);
    return rs.rows[0] ? parse(rs.rows[0].value) : null;
  }

  async setKv(key, value) {
    await this.#q(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ${NOW_MS})
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, JSON.stringify(value)],
    );
  }

  // ---- balance -----------------------------------------------------------
  async insertBalance(b) {
    await this.#q('INSERT INTO balance_snapshots (ts, data) VALUES (?, ?) ON CONFLICT (ts) DO NOTHING', [b.ts, JSON.stringify(b)]);
  }

  async latestBalances(limit = 6_000) {
    const rs = await this.#q('SELECT data FROM balance_snapshots ORDER BY ts DESC LIMIT ?', [limit]);
    return rs.rows.map((r) => parse(r.data)).reverse();
  }

  async balancesAfter(ts, limit = 6_000) {
    const rs = await this.#q('SELECT data FROM balance_snapshots WHERE ts > ? ORDER BY ts LIMIT ?', [ts, limit]);
    return rs.rows.map((r) => parse(r.data));
  }

  async balancesBetween(from, to, maxTs = null) {
    const rs = await this.#q(
      'SELECT data FROM balance_snapshots WHERE ts >= ? AND ts < ? AND (? IS NULL OR ts <= ?) ORDER BY ts',
      [from, to, maxTs, maxTs],
    );
    return rs.rows.map((r) => parse(r.data));
  }

  // ---- manual sync requests ------------------------------------------
  /** Queue a manual sync unless one ran or is pending within the cooldown. */
  async requestSync(by, cooldownMs) {
    const rs = await this.#q('SELECT requested_at, handled_at FROM sync_requests ORDER BY id DESC LIMIT 1');
    const last = rs.rows[0];
    const now = Date.now();
    if (last) {
      const at = Number(last.handled_at ?? last.requested_at);
      if (last.handled_at === null) return { queued: true, pending: true, retryInMs: 0 };
      if (now - at < cooldownMs) return { queued: false, retryInMs: cooldownMs - (now - at) };
    }
    await this.#q('INSERT INTO sync_requests (requested_by) VALUES (?)', [by ?? null]);
    return { queued: true, retryInMs: 0 };
  }

  /** Worker: claim all pending requests; true if there were any. */
  async claimSyncRequests() {
    const rs = await this.#q(`UPDATE sync_requests SET handled_at = ${NOW_MS} WHERE handled_at IS NULL`);
    return rs.rowsAffected > 0;
  }

  // ---- events ------------------------------------------------------------
  async logEvent(level, lane, message) {
    try {
      await this.#q('INSERT INTO sync_events (level, lane, message) VALUES (?, ?, ?)', [level, lane ?? null, String(message).slice(0, 500)]);
      if (++this.events % PRUNE_EVERY === 0) {
        await this.#q('DELETE FROM sync_events WHERE id < (SELECT max(id) - 500 FROM sync_events)');
      }
    } catch (err) {
      this.logger?.warn('could not record sync event', { err: err.message });
    }
  }

  async recentEvents(limit = 20) {
    const rs = await this.#q('SELECT at, level, lane, message FROM sync_events ORDER BY id DESC LIMIT ?', [limit]);
    return rs.rows.map((r) => ({ at: Number(r.at), level: r.level, lane: r.lane, message: r.message }));
  }

  // ---- monthly rollups ---------------------------------------------------
  /** Cheap bounds for the report builder (index-backed: seq rowid, ts indexes). */
  async watermarks() {
    const rs = await this.#q(
      `SELECT (SELECT max(seq) FROM billing_records)   AS seq,
              (SELECT min(ts)  FROM billing_records)   AS min_ts,
              (SELECT max(ts)  FROM billing_records)   AS max_ts,
              (SELECT min(ts)  FROM balance_snapshots) AS min_bal_ts,
              (SELECT max(ts)  FROM balance_snapshots) AS max_bal_ts`,
    );
    const r = rs.rows[0];
    const t = (v) => (v === null ? null : Number(v));
    return { seq: Number(r.seq ?? 0), minTs: t(r.min_ts), maxTs: t(r.max_ts), minBalanceTs: t(r.min_bal_ts), maxBalanceTs: t(r.max_bal_ts) };
  }

  /** Every stored month with its aggregate and whether it is finalized. */
  async loadRollupState() {
    const rs = await this.#q('SELECT month, data, finalized_at FROM rollup_months ORDER BY month');
    return rs.rows.map((r) => ({ month: r.month, data: parse(r.data), finalizedAt: r.finalized_at === null ? null : Number(r.finalized_at) }));
  }

  /** Stream one month's records in (ts, id) order via keyset pagination, pinned to `maxSeq`. */
  async* monthRecords(from, to, { maxSeq = null, pageSize = 5_000 } = {}) {
    let after = [from - 1, ''];
    for (;;) {
      const rs = await this.#q(
        `SELECT id, ts, data FROM billing_records
          WHERE ts >= ? AND ts < ? AND (ts, id) > (?, ?) AND (? IS NULL OR seq <= ?)
          ORDER BY ts, id LIMIT ?`,
        [from, to, after[0], after[1], maxSeq, maxSeq, pageSize],
      );
      if (!rs.rows.length) return;
      yield rs.rows.map((r) => parse(r.data));
      const last = rs.rows[rs.rows.length - 1];
      after = [Number(last.ts), last.id];
      if (rs.rows.length < pageSize) return;
    }
  }

  /** Changed months + the report cursor in one transaction; finalized months are never overwritten. */
  async saveRollups(months, cursor) {
    await this.client.batch([
      ...months.map((m) => ({
        sql: `INSERT INTO rollup_months (month, data, source_count, built_at) VALUES (?, ?, ?, ${NOW_MS})
              ON CONFLICT (month) DO UPDATE SET data = excluded.data, source_count = excluded.source_count, built_at = excluded.built_at
              WHERE rollup_months.finalized_at IS NULL`,
        args: [m.month, JSON.stringify(m.data), m.count],
      })),
      {
        sql: `INSERT INTO kv (key, value, updated_at) VALUES ('rollup_cursor', ?, ${NOW_MS})
              ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        args: [JSON.stringify(cursor)],
      },
    ], 'write');
  }

  /** Freeze a closed month: no rebuild or late record can change it afterwards. */
  async finalizeMonth(month) {
    const rs = await this.#q(`UPDATE rollup_months SET finalized_at = ${NOW_MS} WHERE month = ? AND finalized_at IS NULL`, [month]);
    return rs.rowsAffected > 0;
  }

  /** Retention: delete counted (seq <= maxSeq) raw records older than `cutoffTs`, in batches. */
  async pruneRecords(cutoffTs, maxSeq, batch = 10_000) {
    let total = 0;
    for (;;) {
      const rs = await this.#q(
        'DELETE FROM billing_records WHERE seq IN (SELECT seq FROM billing_records WHERE ts < ? AND seq <= ? LIMIT ?)',
        [cutoffTs, maxSeq, batch],
      );
      total += rs.rowsAffected;
      if (rs.rowsAffected < batch) return total;
    }
  }

  /** Retention for balance snapshots already applied to the monthly summaries. */
  async pruneBalances(cutoffTs, maxTs, batch = 10_000) {
    let total = 0;
    for (;;) {
      const rs = await this.#q(
        'DELETE FROM balance_snapshots WHERE ts IN (SELECT ts FROM balance_snapshots WHERE ts < ? AND ts <= ? LIMIT ?)',
        [cutoffTs, maxTs, batch],
      );
      total += rs.rowsAffected;
      if (rs.rowsAffected < batch) return total;
    }
  }

  /** Months rebuilt after `since` (API view of the rollups). */
  async loadRollups(since = 0) {
    const rs = await this.#q('SELECT month, data, built_at FROM rollup_months WHERE built_at > ? ORDER BY month', [since]);
    return rs.rows.map((r) => ({ month: r.month, data: parse(r.data), builtAt: Number(r.built_at) }));
  }

  // ---- call history (slim copy of CourseRev conversations) --------------
  /** Upsert slim calls; unchanged rows are not rewritten. Returns how many were inserted or changed. */
  async upsertCalls(calls) {
    const uniq = new Map();
    for (const c of calls) if (c?.callId) uniq.set(c.callId, c);
    if (!uniq.size) return 0;
    const list = [...uniq.values()];
    const stmts = [];
    for (let i = 0; i < list.length; i += 300) {
      const part = list.slice(i, i + 300);
      stmts.push({
        sql: `INSERT INTO calls (call_id, ts, data) VALUES ${part.map(() => '(?, ?, ?)').join(', ')}
              ON CONFLICT (call_id) DO UPDATE SET ts = excluded.ts, data = excluded.data, synced_at = ${NOW_MS}
              WHERE calls.data IS NOT excluded.data`,
        args: part.flatMap((c) => [c.callId, c.ts, JSON.stringify(c)]),
      });
    }
    const results = await this.client.batch(stmts, 'write');
    return results.reduce((s, rs) => s + rs.rowsAffected, 0);
  }

  /** Calls inserted or changed after `since` (ms), oldest change first (API tail). */
  async callsChangedSince(since, limit = 5_000) {
    const rs = await this.#q('SELECT data, synced_at FROM calls WHERE synced_at > ? ORDER BY synced_at LIMIT ?', [since, limit]);
    return rs.rows.map((r) => ({ data: parse(r.data), syncedAt: Number(r.synced_at) }));
  }

  /**
   * Calls with ts >= sinceTs, keyset-paged (API hydration). Oldest first by
   * default; `newestFirst` pages backwards from now (afterTs/afterId = the
   * last row of the previous page in either direction).
   */
  async loadCalls(sinceTs, { afterTs = null, afterId = '', limit = 5_000, newestFirst = false } = {}) {
    const rs = newestFirst
      ? await this.#q(
        'SELECT data, synced_at FROM calls WHERE ts >= ? AND (ts, call_id) < (?, ?) ORDER BY ts DESC, call_id DESC LIMIT ?',
        [sinceTs, afterTs ?? Number.MAX_SAFE_INTEGER, afterTs === null ? '' : afterId, limit],
      )
      : await this.#q(
        'SELECT data, synced_at FROM calls WHERE ts >= ? AND (ts, call_id) > (?, ?) ORDER BY ts, call_id LIMIT ?',
        [sinceTs, afterTs ?? sinceTs - 1, afterId, limit],
      );
    return rs.rows.map((r) => ({ data: parse(r.data), syncedAt: Number(r.synced_at) }));
  }

  /** Retention for the call copy. */
  async pruneCalls(beforeTs, batch = 10_000) {
    let total = 0;
    for (;;) {
      const rs = await this.#q('DELETE FROM calls WHERE call_id IN (SELECT call_id FROM calls WHERE ts < ? LIMIT ?)', [beforeTs, batch]);
      total += rs.rowsAffected;
      if (rs.rowsAffected < batch) return total;
    }
  }
}
