import { MonthAgg } from '../services/monthlyRollups.js';

/**
 * Read-only stand-in for MonthlyRollups in the API process: monthly
 * aggregates come from rollup_months (built by the worker), coverage
 * metadata from the worker's status document.
 */
export class PgRollupsView {
  constructor({ repo }) {
    this.repo = repo;
    this.months = new Map();
    this.meta = { liveFrom: null, highWater: 0, historyFrom: null, historyDoneThrough: null };
    this.backfill = { running: false, done: 0, total: 0, month: null };
    this.lastBuiltAt = 0;
    this.version = 0;
  }

  async refresh() {
    const rows = await this.repo.loadRollups(this.lastBuiltAt);
    for (const r of rows) {
      this.months.set(r.month, new MonthAgg(r.month, r.data));
      this.lastBuiltAt = Math.max(this.lastBuiltAt, r.builtAt);
    }
    if (rows.length) this.version++;
    return rows.length;
  }

  /** Coverage info published by the worker. */
  setStatus(status) {
    const m = status?.reportMeta;
    if (m) this.meta = { ...this.meta, ...m };
    const h = status?.progress?.history;
    if (h) this.backfill = h;
  }

  get(key) { return this.months.get(key) || null; }

  keys() { return [...this.months.keys()].sort(); }

  // The API never writes rollups.
  noteBalance() {}
  addLive() { return 0; }
  flush() { return false; }
}
