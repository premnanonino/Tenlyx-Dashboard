import { MonthAgg } from './monthlyRollups.js';

const DAY = 86_400_000;
const FULL_REBUILD_MS = DAY; // open months are re-derived from raw records at most once a day
const PAGE = 5_000;

const monthBounds = (key) => {
  const [y, m] = key.split('-').map(Number);
  return [Date.UTC(y, m - 1, 1), Date.UTC(y, m, 1)];
};
const monthKey = (ts) => new Date(ts).toISOString().slice(0, 7);
const nextMonth = (key) => monthKey(monthBounds(key)[1]);

/**
 * Monthly statements, built from the stored records (production worker).
 * It never calls Telnyx.
 *
 * Incremental: new rows are followed by insertion order (`seq`), and new
 * balance snapshots by `ts`. Each run reads only what was inserted since the
 * last run, adds it to its month with MonthAgg.add(), and saves the changed
 * months together with the cursor in one transaction. That keeps every
 * record counted exactly once, across crashes and restarts.
 *
 * Full rebuild: once a day (and on the first run, when there is no cursor)
 * every open month is re-derived from its raw records, pinned to a seq
 * snapshot. It is a self-check, not the normal path. A rebuild never
 * replaces a summary with one that counts fewer records.
 *
 * Finalization: a closed month is frozen once its grace period has passed
 * (late call legs, restart backfill) and the sync has read all of it
 * (`monthComplete`). Finalized months are never rebuilt or changed, which
 * is what makes it safe to prune their raw records.
 *
 * Retention (`prune`): deletes raw records and balance snapshots older than
 * the retention window, but only rows the builder has already counted, and
 * never rows of a month that is still open.
 */
export class ReportBuilder {
  constructor({ repo, logger, retentionMs = 35 * DAY, graceMs = 8 * DAY, monthComplete = () => false }) {
    Object.assign(this, { repo, logger, retentionMs, graceMs, monthComplete });
    this.state = null; // { seq, balanceTs, rebuiltAt, months: Map<key, { agg, finalized }> }
    this.chain = Promise.resolve();
    this.stats = {
      runs: 0, monthsBuilt: 0, lastRunAt: null, lastBuiltAt: null,
      fullRebuilds: 0, lastFullRebuildAt: null, incrementalRecords: 0,
      finalized: 0, lateIgnored: 0, rebuildsRejected: 0,
      prunedRecords: 0, prunedBalances: 0, lastPruneAt: null,
    };
  }

  /** run() and prune() share state: never let them interleave. */
  #exclusive(fn) {
    const p = this.chain.then(fn);
    this.chain = p.catch(() => {});
    return p;
  }

  async #load() {
    const [rows, cursor] = await Promise.all([this.repo.loadRollupState(), this.repo.getKv('rollup_cursor')]);
    const months = new Map(rows.map((r) => [r.month, { agg: new MonthAgg(r.month, r.data), finalized: r.finalizedAt !== null }]));
    this.state = {
      seq: cursor?.seq ?? null,
      balanceTs: cursor?.balanceTs ?? 0,
      rebuiltAt: cursor?.rebuiltAt ?? 0,
      months,
    };
  }

  /** Scheduled job: incremental update (or the daily rebuild), then finalization. */
  run(now = Date.now()) {
    return this.#exclusive(async () => {
      this.stats.runs++;
      try {
        if (!this.state) await this.#load();
        const s = this.state;
        const built = s.seq === null || now - s.rebuiltAt >= FULL_REBUILD_MS
          ? await this.#fullRebuild(now)
          : await this.#incremental();
        await this.#finalize(now);
        this.stats.lastRunAt = Date.now();
        if (built) {
          this.stats.monthsBuilt += built;
          this.stats.lastBuiltAt = Date.now();
        }
        return built;
      } catch (err) {
        this.state = null; // in-memory months may be ahead of the database: reload next time
        throw err;
      }
    });
  }

  #open(key) {
    const s = this.state;
    let m = s.months.get(key);
    if (!m) { m = { agg: new MonthAgg(key), finalized: false }; s.months.set(key, m); }
    return m;
  }

  async #incremental() {
    const s = this.state;
    const touched = new Set();
    let seq = s.seq;
    let balanceTs = s.balanceTs;
    let added = 0;

    for (;;) {
      const rows = await this.repo.recordsAfter(seq, { limit: PAGE });
      for (const row of rows) {
        seq = row.seq;
        const key = monthKey(row.data.ts);
        const m = s.months.get(key);
        if (m?.finalized) { this.stats.lateIgnored++; continue; }
        this.#open(key).agg.add(row.data);
        touched.add(key);
        added++;
      }
      if (rows.length < PAGE) break;
    }
    for (;;) {
      const balances = await this.repo.balancesAfter(balanceTs, PAGE);
      for (const b of balances) {
        balanceTs = b.ts;
        const key = monthKey(b.ts);
        if (s.months.get(key)?.finalized) continue;
        this.#open(key).agg.noteBalance(b);
        touched.add(key);
      }
      if (balances.length < PAGE) break;
    }

    if (seq === s.seq && balanceTs === s.balanceTs) return 0;
    await this.repo.saveRollups(this.#docs(touched), { seq, balanceTs, rebuiltAt: s.rebuiltAt });
    s.seq = seq;
    s.balanceTs = balanceTs;
    this.stats.incrementalRecords += added;
    return touched.size;
  }

  /**
   * Re-derive every open month from raw rows, pinned to the cursor: rows
   * after it are left for the next incremental run, so nothing is counted
   * twice, and a month whose rebuild is rejected is still current up to it.
   */
  async #fullRebuild(now) {
    const s = this.state;
    const w = await this.repo.watermarks();
    if (s.seq === null) {
      // First run (no cursor yet): adopt the current end of the table as the snapshot.
      s.seq = w.seq;
      s.balanceTs = w.maxBalanceTs ?? 0;
    } else {
      await this.#incremental();
    }
    const lo = [w.minTs, w.minBalanceTs].filter((v) => v !== null);
    const hi = [w.maxTs, w.maxBalanceTs].filter((v) => v !== null);
    const touched = new Set();

    if (lo.length) {
      const last = monthKey(Math.max(...hi));
      for (let key = monthKey(Math.min(...lo)); key <= last; key = nextMonth(key)) {
        const cur = s.months.get(key);
        if (cur?.finalized) continue;
        const [from, to] = monthBounds(key);
        const agg = new MonthAgg(key);
        for await (const rows of this.repo.monthRecords(from, to, { maxSeq: s.seq })) for (const r of rows) agg.add(r);
        for (const b of await this.repo.balancesBetween(from, to, s.balanceTs)) agg.noteBalance(b);
        if (!cur && agg.count === 0 && agg.balanceOpen === null) continue;
        // Records are only ever deleted from finalized months, so a rebuild
        // counting fewer than the summary means raw data is missing: keep the summary.
        if (cur && agg.count < cur.agg.count) {
          this.stats.rebuildsRejected++;
          this.logger?.warn('rebuild has fewer records than the stored summary; keeping the summary', { month: key, stored: cur.agg.count, rebuilt: agg.count });
          continue;
        }
        s.months.set(key, { agg, finalized: false });
        touched.add(key);
      }
    }

    await this.repo.saveRollups(this.#docs(touched), { seq: s.seq, balanceTs: s.balanceTs, rebuiltAt: now });
    s.rebuiltAt = now;
    this.stats.fullRebuilds++;
    this.stats.lastFullRebuildAt = Date.now();
    if (touched.size) this.logger?.info('monthly reports rebuilt', { months: touched.size });
    return touched.size;
  }

  #docs(keys) {
    return [...keys].map((k) => {
      const { agg } = this.state.months.get(k);
      return { month: k, data: agg.toJSON(), count: agg.count };
    });
  }

  async #finalize(now) {
    for (const [key, m] of this.state.months) {
      if (m.finalized) continue;
      const [from, to] = monthBounds(key);
      if (now < to + this.graceMs || !this.monthComplete(from, to)) continue;
      await this.repo.finalizeMonth(key);
      m.finalized = true;
      this.stats.finalized++;
      this.logger?.info('monthly report finalized', { month: key, records: m.agg.count });
    }
  }

  /**
   * Retention job. Deletes rows older than the retention window, but never
   * rows of an open month and never rows the builder hasn't counted yet.
   */
  prune(now = Date.now()) {
    return this.#exclusive(async () => {
      if (!this.state) await this.#load();
      const s = this.state;
      if (s.seq === null) return { records: 0, balances: 0 }; // nothing counted yet
      let cutoff = now - this.retentionMs;
      for (const [key, m] of s.months) if (!m.finalized) cutoff = Math.min(cutoff, monthBounds(key)[0]);
      const records = await this.repo.pruneRecords(cutoff, s.seq);
      const balances = await this.repo.pruneBalances(cutoff, s.balanceTs);
      this.stats.prunedRecords += records;
      this.stats.prunedBalances += balances;
      this.stats.lastPruneAt = Date.now();
      if (records || balances) this.logger?.info('retention pruned', { records, balances, before: new Date(cutoff).toISOString() });
      return { records, balances, cutoff };
    });
  }
}
