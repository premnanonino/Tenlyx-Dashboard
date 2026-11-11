/**
 * All PostgreSQL access in one place.
 *
 * Idempotency: billing_records.id is the primary key and every insert is
 * `ON CONFLICT DO NOTHING ... RETURNING id`, so re-reading a page (after a
 * retry, a crash or an overlapping poll) can never create a duplicate, and
 * the caller learns exactly which records were new.
 *
 * Ordering: the API follows new rows by `seq` (identity). Inserts are
 * serialised in the (single) worker so rows commit in seq order and the
 * API's "seq > last seen" cursor can never skip a row.
 */
const clean = ({ _tokens, ...r }) => r;
const PRUNE_EVERY = 200;

export class PgRepo {
  constructor({ pool, logger }) {
    this.pool = pool;
    this.logger = logger;
    this.chain = Promise.resolve();
    this.events = 0;
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
    const { rows } = await this.pool.query(
      `INSERT INTO billing_records (id, ts, product, cost, data)
       SELECT * FROM unnest($1::text[], $2::timestamptz[], $3::text[], $4::numeric[], $5::jsonb[])
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        recs.map((r) => r.id),
        recs.map((r) => new Date(r.ts)),
        recs.map((r) => r.product),
        recs.map((r) => r.cost),
        recs.map((r) => JSON.stringify(clean(r))),
      ],
    );
    const fresh = new Set(rows.map((x) => x.id));
    return recs.filter((r) => fresh.has(r.id));
  }

  async recordCount() {
    const { rows } = await this.pool.query('SELECT count(*)::bigint AS n FROM billing_records');
    return rows[0].n;
  }

  /** Rows inserted after `seq`, in insertion order (API tail + hydration). */
  async recordsAfter(seq, { sinceTs = null, limit = 5_000 } = {}) {
    const { rows } = await this.pool.query(
      `SELECT seq, data FROM billing_records
        WHERE seq > $1 AND ($2::timestamptz IS NULL OR ts >= $2)
        ORDER BY seq LIMIT $3`,
      [seq, sinceTs === null ? null : new Date(sinceTs), limit],
    );
    return rows;
  }

  // ---- key/value documents --------------------------------------------
  async getKv(key) {
    const { rows } = await this.pool.query('SELECT value, updated_at FROM kv WHERE key = $1', [key]);
    return rows[0] ? rows[0].value : null;
  }

  async setKv(key, value) {
    await this.pool.query(
      `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }

  // ---- balance -----------------------------------------------------------
  async insertBalance(b) {
    await this.pool.query('INSERT INTO balance_snapshots (ts, data) VALUES ($1, $2) ON CONFLICT (ts) DO NOTHING', [new Date(b.ts), JSON.stringify(b)]);
  }

  async latestBalances(limit = 6_000) {
    const { rows } = await this.pool.query('SELECT data FROM balance_snapshots ORDER BY ts DESC LIMIT $1', [limit]);
    return rows.map((r) => r.data).reverse();
  }

  async balancesAfter(ts, limit = 6_000) {
    const { rows } = await this.pool.query(
      'SELECT data FROM balance_snapshots WHERE ts > $1 ORDER BY ts LIMIT $2',
      [new Date(ts), limit],
    );
    return rows.map((r) => r.data);
  }

  async balancesBetween(from, to, maxTs = null) {
    const { rows } = await this.pool.query(
      'SELECT data FROM balance_snapshots WHERE ts >= $1 AND ts < $2 AND ($3::timestamptz IS NULL OR ts <= $3) ORDER BY ts',
      [new Date(from), new Date(to), maxTs === null ? null : new Date(maxTs)],
    );
    return rows.map((r) => r.data);
  }

  // ---- manual sync requests ------------------------------------------
  /** Queue a manual sync unless one ran or is pending within the cooldown. */
  async requestSync(by, cooldownMs) {
    const { rows } = await this.pool.query(
      `SELECT requested_at, handled_at FROM sync_requests ORDER BY id DESC LIMIT 1`,
    );
    const last = rows[0];
    const now = Date.now();
    if (last) {
      const at = new Date(last.handled_at ?? last.requested_at).getTime();
      if (!last.handled_at) return { queued: true, pending: true, retryInMs: 0 };
      if (now - at < cooldownMs) return { queued: false, retryInMs: cooldownMs - (now - at) };
    }
    await this.pool.query('INSERT INTO sync_requests (requested_by) VALUES ($1)', [by ?? null]);
    return { queued: true, retryInMs: 0 };
  }

  /** Worker: claim all pending requests; true if there were any. */
  async claimSyncRequests() {
    const { rowCount } = await this.pool.query('UPDATE sync_requests SET handled_at = now() WHERE handled_at IS NULL');
    return rowCount > 0;
  }

  // ---- events ------------------------------------------------------------
  async logEvent(level, lane, message) {
    try {
      await this.pool.query('INSERT INTO sync_events (level, lane, message) VALUES ($1, $2, $3)', [level, lane, String(message).slice(0, 500)]);
      if (++this.events % PRUNE_EVERY === 0) {
        await this.pool.query('DELETE FROM sync_events WHERE id < (SELECT max(id) - 500 FROM sync_events)');
      }
    } catch (err) {
      this.logger?.warn('could not record sync event', { err: err.message });
    }
  }

  async recentEvents(limit = 20) {
    const { rows } = await this.pool.query('SELECT at, level, lane, message FROM sync_events ORDER BY id DESC LIMIT $1', [limit]);
    return rows.map((r) => ({ ...r, at: new Date(r.at).getTime() }));
  }

  // ---- monthly rollups ---------------------------------------------------
  // The report builder never counts or scans the whole table: it follows new
  // rows by `seq` and rebuilds only open (not finalized) months, once a day.

  /** Cheap bounds for the report builder (all index-backed: seq unique, ts indexes). */
  async watermarks() {
    const { rows } = await this.pool.query(
      `SELECT (SELECT max(seq) FROM billing_records)        AS seq,
              (SELECT min(ts)  FROM billing_records)        AS min_ts,
              (SELECT max(ts)  FROM billing_records)        AS max_ts,
              (SELECT min(ts)  FROM balance_snapshots)      AS min_bal_ts,
              (SELECT max(ts)  FROM balance_snapshots)      AS max_bal_ts`,
    );
    const r = rows[0];
    const t = (v) => (v === null ? null : new Date(v).getTime());
    return { seq: r.seq ?? 0, minTs: t(r.min_ts), maxTs: t(r.max_ts), minBalanceTs: t(r.min_bal_ts), maxBalanceTs: t(r.max_bal_ts) };
  }

  /** Every stored month with its aggregate and whether it is finalized. */
  async loadRollupState() {
    const { rows } = await this.pool.query('SELECT month, data, finalized_at FROM rollup_months ORDER BY month');
    return rows.map((r) => ({ month: r.month, data: r.data, finalizedAt: r.finalized_at ? new Date(r.finalized_at).getTime() : null }));
  }

  /**
   * Stream one month's records in (ts, id) order via keyset pagination.
   * `maxSeq` pins the read to a snapshot so rows inserted meanwhile are left
   * for the incremental cursor instead of being counted twice.
   */
  async* monthRecords(from, to, { maxSeq = null, pageSize = 5_000 } = {}) {
    let after = [new Date(from - 1), ''];
    for (;;) {
      const { rows } = await this.pool.query(
        `SELECT id, ts, data FROM billing_records
          WHERE ts >= $1 AND ts < $2 AND (ts, id) > ($3, $4) AND ($5::bigint IS NULL OR seq <= $5)
          ORDER BY ts, id LIMIT $6`,
        [new Date(from), new Date(to), after[0], after[1], maxSeq, pageSize],
      );
      if (!rows.length) return;
      yield rows.map((r) => r.data);
      const last = rows[rows.length - 1];
      after = [last.ts, last.id];
      if (rows.length < pageSize) return;
    }
  }

  /**
   * Persist changed months and the report cursor in one transaction, so a
   * crash can never leave a month counted without its cursor (or vice versa).
   * Finalized months are never overwritten.
   */
  async saveRollups(months, cursor) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const m of months) {
        await client.query(
          `INSERT INTO rollup_months (month, data, source_count, built_at) VALUES ($1, $2, $3, clock_timestamp())
           ON CONFLICT (month) DO UPDATE SET data = EXCLUDED.data, source_count = EXCLUDED.source_count, built_at = clock_timestamp()
           WHERE rollup_months.finalized_at IS NULL`,
          [m.month, JSON.stringify(m.data), m.count],
        );
      }
      await client.query(
        `INSERT INTO kv (key, value, updated_at) VALUES ('rollup_cursor', $1, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [JSON.stringify(cursor)],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Freeze a closed month: no rebuild or late record can change it afterwards. */
  async finalizeMonth(month) {
    const { rowCount } = await this.pool.query(
      'UPDATE rollup_months SET finalized_at = now() WHERE month = $1 AND finalized_at IS NULL',
      [month],
    );
    return rowCount > 0;
  }

  /**
   * Retention: delete raw records older than `cutoffTs` that the report
   * builder has already counted (seq <= maxSeq). Batched to keep each
   * transaction small.
   */
  async pruneRecords(cutoffTs, maxSeq, batch = 10_000) {
    let total = 0;
    for (;;) {
      const { rowCount } = await this.pool.query(
        `DELETE FROM billing_records WHERE id IN (
           SELECT id FROM billing_records WHERE ts < $1 AND seq <= $2 LIMIT $3)`,
        [new Date(cutoffTs), maxSeq, batch],
      );
      total += rowCount;
      if (rowCount < batch) return total;
    }
  }

  /** Retention for balance snapshots already applied to the monthly summaries. */
  async pruneBalances(cutoffTs, maxTs, batch = 10_000) {
    let total = 0;
    for (;;) {
      const { rowCount } = await this.pool.query(
        `DELETE FROM balance_snapshots WHERE ts IN (
           SELECT ts FROM balance_snapshots WHERE ts < $1 AND ts <= $2 LIMIT $3)`,
        [new Date(cutoffTs), new Date(maxTs), batch],
      );
      total += rowCount;
      if (rowCount < batch) return total;
    }
  }

  async loadRollups(since = 0) {
    const { rows } = await this.pool.query(
      'SELECT month, data, built_at FROM rollup_months WHERE built_at > $1 ORDER BY month',
      [new Date(since)],
    );
    return rows.map((r) => ({ month: r.month, data: r.data, builtAt: new Date(r.built_at).getTime() }));
  }

  // ---- call history (slim copy of CourseRev conversations) --------------
  /** Upsert slim calls; unchanged rows are not rewritten. Returns how many were inserted or changed. */
  async upsertCalls(calls) {
    const uniq = new Map();
    for (const c of calls) if (c?.callId) uniq.set(c.callId, c);
    if (!uniq.size) return 0;
    const list = [...uniq.values()];
    const { rowCount } = await this.pool.query(
      `INSERT INTO calls (call_id, ts, data)
       SELECT * FROM unnest($1::text[], $2::timestamptz[], $3::jsonb[])
       ON CONFLICT (call_id) DO UPDATE SET ts = EXCLUDED.ts, data = EXCLUDED.data, synced_at = clock_timestamp()
       WHERE calls.data IS DISTINCT FROM EXCLUDED.data`,
      [list.map((c) => c.callId), list.map((c) => new Date(c.ts)), list.map((c) => JSON.stringify(c))],
    );
    return rowCount;
  }

  /** Calls inserted or changed after `since` (ms), oldest change first (API tail). */
  async callsChangedSince(since, limit = 5_000) {
    const { rows } = await this.pool.query(
      'SELECT data, synced_at FROM calls WHERE synced_at > $1 ORDER BY synced_at LIMIT $2',
      [new Date(since), limit],
    );
    return rows.map((r) => ({ data: r.data, syncedAt: new Date(r.synced_at).getTime() }));
  }

  /**
   * Calls with ts >= sinceTs, keyset-paged (API hydration). Oldest first by
   * default; `newestFirst` pages backwards from now (afterTs/afterId = the
   * last row of the previous page in either direction).
   */
  async loadCalls(sinceTs, { afterTs = null, afterId = '', limit = 5_000, newestFirst = false } = {}) {
    const { rows } = newestFirst
      ? await this.pool.query(
        `SELECT data, synced_at FROM calls WHERE ts >= $1 AND (ts, call_id) < ($2, $3) ORDER BY ts DESC, call_id DESC LIMIT $4`,
        [new Date(sinceTs), new Date(afterTs ?? 8.64e15), afterTs === null ? '' : afterId, limit],
      )
      : await this.pool.query(
        `SELECT data, synced_at FROM calls WHERE ts >= $1 AND (ts, call_id) > ($2, $3) ORDER BY ts, call_id LIMIT $4`,
        [new Date(sinceTs), new Date(afterTs ?? sinceTs - 1), afterId, limit],
      );
    return rows.map((r) => ({ data: r.data, syncedAt: new Date(r.synced_at).getTime() }));
  }

  /** Retention for the call copy. */
  async pruneCalls(beforeTs, batch = 10_000) {
    let total = 0;
    for (;;) {
      const { rowCount } = await this.pool.query(
        'DELETE FROM calls WHERE call_id IN (SELECT call_id FROM calls WHERE ts < $1 LIMIT $2)',
        [new Date(beforeTs), batch],
      );
      total += rowCount;
      if (rowCount < batch) return total;
    }
  }
}
