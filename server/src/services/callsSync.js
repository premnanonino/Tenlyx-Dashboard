const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Keeps the dashboard's slim copy of CourseRev's call history in sync, with
 * as little load on production as possible.
 *
 * Calls change after they are created (summary, outcome, booking link), so
 * time windows are re-read on a schedule, newest windows most often:
 *
 *   every 60 s   last 2 h        (most updates land within minutes)
 *   every 15 min last 24 h
 *   every 24 h   last 7 d
 *   every 7 d    last N days     (also the first load; catches rare bulk updates)
 *
 * A due window becomes a "sweep": read oldest-first in keyset batches of
 * `batch` rows (one indexed range query each), one batch per tick, shortest
 * window first. The sweep position is saved after every batch, so a restart
 * resumes where it stopped. Only rows whose data changed are written.
 */
export function defaultWindows(historyDays) {
  return [
    { name: '2h', spanMs: 2 * HOUR, everyMs: MIN },
    { name: '24h', spanMs: DAY, everyMs: 15 * MIN },
    { name: '7d', spanMs: 7 * DAY, everyMs: DAY },
    { name: 'full', spanMs: historyDays * DAY, everyMs: 7 * DAY },
  ];
}

export class CallsSync {
  constructor({ source, repo, logger, historyDays = 90, batch = 1_000, windows = defaultWindows(historyDays), stateKey = 'calls_sync' }) {
    Object.assign(this, { source, repo, logger, historyDays, batch, windows, stateKey });
    this.state = null; // { lastStart: { [window]: ms }, sweeps: [{ window, from, to, afterTs, afterId }], lastPruneAt }
    this.stats = { batches: 0, rowsRead: 0, rowsChanged: 0, sweepsDone: 0, pruned: 0, lastBatchAt: null, lastError: null };
  }

  async #load() {
    const s = await this.repo.getKv(this.stateKey);
    this.state = { lastStart: {}, sweeps: [], lastPruneAt: 0, ...(s || {}) };
  }

  #save() { return this.repo.setKv(this.stateKey, this.state); }

  /** Queue every window that is due (and not already being swept). */
  #schedule(now) {
    const s = this.state;
    for (const w of this.windows) {
      if (s.sweeps.some((x) => x.window === w.name)) continue;
      if (now - (s.lastStart[w.name] || 0) < w.everyMs) continue;
      s.sweeps.push({ window: w.name, from: now - w.spanMs, to: now + MIN, afterTs: null, afterId: 0 });
      s.lastStart[w.name] = now;
    }
    // Shortest window first: fresh data is never stuck behind a long sweep.
    const order = new Map(this.windows.map((w, i) => [w.name, i]));
    s.sweeps.sort((a, b) => order.get(a.window) - order.get(b.window));
  }

  /** Scheduler tick: process at most one batch. Returns true if a batch ran. */
  async tick(now = Date.now()) {
    if (!this.state) await this.#load();
    this.#schedule(now);
    const sweep = this.state.sweeps[0];
    if (!sweep) {
      if (now - this.state.lastPruneAt > HOUR) await this.prune(now);
      return false;
    }
    let rows;
    try {
      rows = await this.source.page({ from: sweep.from, to: sweep.to, afterTs: sweep.afterTs, afterId: sweep.afterId, limit: this.batch });
    } catch (err) {
      this.stats.lastError = err.message;
      throw err;
    }
    const changed = rows.length ? await this.repo.upsertCalls(rows) : 0;
    this.stats.batches++;
    this.stats.rowsRead += rows.length;
    this.stats.rowsChanged += changed;
    this.stats.lastBatchAt = Date.now();
    this.stats.lastError = null;
    if (rows.length < this.batch) {
      this.state.sweeps.shift();
      this.stats.sweepsDone++;
      if (sweep.window === 'full') this.logger?.info('call history sweep complete', { window: sweep.window, changed: this.stats.rowsChanged });
    } else {
      const last = rows[rows.length - 1];
      sweep.afterTs = last.ts;
      sweep.afterId = last.id;
    }
    await this.#save();
    return true;
  }

  /** Drop calls older than the history window from the copy. */
  async prune(now = Date.now()) {
    const n = await this.repo.pruneCalls(now - this.historyDays * DAY);
    this.stats.pruned += n;
    this.state.lastPruneAt = now;
    await this.#save();
    return n;
  }

  progress() {
    const s = this.state;
    return {
      sweeps: s ? s.sweeps.map((x) => ({ window: x.window, at: x.afterTs })) : [],
      backfillDone: !!s && !!s.lastStart.full && !s.sweeps.some((x) => x.window === 'full'),
      ...this.stats,
    };
  }
}
