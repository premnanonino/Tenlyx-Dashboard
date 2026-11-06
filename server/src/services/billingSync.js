import { retry } from '../infra/retry.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const HISTORY_CHUNK_MS = 6 * HOUR;

/**
 * Pulls data from the provider into the store, batch by batch.
 *
 * Three lanes share one adaptive pacer (see infra/adaptivePacer.js):
 *
 *   live       every poll reads [watermark - overlap, now]. On a cold start
 *              it reads only the last hour, so the dashboard has numbers
 *              within seconds instead of after a multi-day download.
 *   backfill   walks backwards from that point, one small chunk per step,
 *              newest first, until it reaches the retention target. Each
 *              upstream page is ingested the moment it arrives.
 *   history    once the backfill is done, fills monthly rollups for older
 *              months, one chunk per step (lowest priority).
 *
 * A throttle or failure only costs the current page: everything already
 * ingested stays, cursors only move after a chunk completes, and the store's
 * primary-key index de-duplicates anything that gets re-read.
 */
export class BillingSync {
  constructor({ provider, store, breaker, flight, bus, logger, config, rollups }) {
    Object.assign(this, { provider, store, breaker, flight, bus, logger, config, rollups });
    this.watermark = null;
    this.backfill = null;
    this.retries = 0;
    this.lastSync = { balance: 0, records: 0, groups: 0 };
  }

  /** Cheap single calls (balance, groups): coalesce + breaker + retry. */
  #guarded(key, fn) {
    return this.flight.do(key, () =>
      this.breaker.exec(() =>
        retry(fn, {
          retries: 3,
          onRetry: ({ attempt, delay, err }) => {
            this.retries++;
            this.logger.debug('retrying', { key, attempt, delay: Math.round(delay), err: err.message });
          },
        }),
      ),
    );
  }

  /** Record streams retry per request inside the client, so no outer retry here. */
  #streamed(key, fn) {
    return this.flight.do(key, () => this.breaker.exec(fn));
  }

  async syncGroups() {
    const groups = await this.#guarded('groups', () => this.provider.listBillingGroups());
    this.store.setGroups(groups);
    this.lastSync.groups = Date.now();
  }

  async syncAssistants() {
    if (!this.provider.listAssistants || this.assistantsUnsupported) return;
    try {
      const list = await this.#guarded('assistants', () => this.provider.listAssistants());
      this.store.setAssistants(list);
    } catch (err) {
      if (err.status >= 400 && err.status < 500 && err.status !== 429) {
        this.assistantsUnsupported = true; // account has no AI assistants API access
        this.logger.warn('AI assistants endpoint unavailable', { status: err.status });
        return;
      }
      throw err;
    }
  }

  async syncBalance() {
    const b = await this.#guarded('balance', () => this.provider.getBalance());
    if (!this.store.balanceHistory.length) this.#seedBalanceHistory(b);
    this.store.setBalance(b);
    this.rollups?.noteBalance(b);
    this.lastSync.balance = Date.now();
    this.bus.publish('balance', b);
  }

  /**
   * On a cold start there is no balance history yet. Reconstruct an
   * estimate for the last 48h by walking back from the current balance and
   * adding back what was spent since each hour (ignores top-ups; flagged).
   */
  #seedBalanceHistory(b) {
    const hourStart = Math.floor(b.ts / HOUR) * HOUR;
    for (let k = 48; k >= 1; k--) {
      const ts = hourStart - k * HOUR;
      const spentSince = this.store.total.sum(ts, b.ts);
      this.store.balanceHistory.push({
        ts, balance: b.balance + spentSince, available: b.availableCredit + spentSince, pending: 0, estimated: true,
      });
    }
  }

  /** Stream [since, until) into the store page by page. */
  async #ingestRange({ since, until, live }) {
    let added = 0;
    for await (const batch of this.provider.recordBatches({ since, until })) {
      const now = Date.now();
      const fresh = this.store.ingest(batch, now);
      this.rollups?.addLive(fresh);
      if (!fresh.length) continue;
      added += fresh.length;
      let cost = 0;
      for (const r of fresh) cost += r.cost;
      this.bus.publish('records', {
        added: fresh.length,
        cost,
        backfill: !live,
        // Only genuinely new activity goes on the ticker tape.
        latest: live ? fresh.slice(-12).reverse().map((r) => this.store.present(r)) : [],
      });
    }
    return added;
  }

  /** Live lane: the newest records. Cold start reads only a short head. */
  async syncRecords() {
    return this.#streamed('records', async () => {
      const now = Date.now();
      const cold = this.watermark === null;
      const since = cold ? now - this.config.sync.liveHeadMs : this.watermark - this.config.poll.overlapMs;
      if (cold) this.#planBackfill(since, now);

      const added = await this.#ingestRange({ since, until: now, live: true });
      // Advance only after the whole window succeeded; a failed poll re-reads it.
      this.watermark = now;
      this.rollups?.markCovered(since, now);
      this.store.evict(now);
      this.store.tick(now);
      this.lastSync.records = Date.now();
      this.bus.publish('sync', this.progress());
      return added;
    });
  }

  /**
   * Decide how far back to fill: the configured backfill window, extended
   * over any downtime since the rollups were last counted (bounded by the
   * store's retention).
   */
  #planBackfill(headStart, now) {
    const raw = now - this.config.telnyx.backfillDays * DAY;
    const floor = now - this.config.retentionDays * DAY + HOUR;
    const lastCounted = this.rollups?.bootHighWater || 0;
    const target = Math.max(floor, lastCounted > 0 ? Math.min(raw, lastCounted) : raw);
    this.backfill = {
      from: headStart, target, cursor: headStart, done: target >= headStart,
      chunks: 0, startedAt: now, finishedAt: null,
    };
    if (this.rollups) this.rollups.meta.liveFrom = target;
    this.logger.info('backfill planned', { from: new Date(target).toISOString(), to: new Date(headStart).toISOString() });
  }

  /** Backfill lane: one chunk, newest first. Called repeatedly by the scheduler. */
  async backfillStep() {
    const b = this.backfill;
    if (!b || b.done) return false;
    return this.#streamed('backfill', async () => {
      const until = b.cursor;
      const since = Math.max(b.target, until - this.config.sync.chunkMs);
      await this.#ingestRange({ since, until, live: false });
      b.cursor = since;
      b.chunks++;
      this.rollups?.markCovered(since, until);
      if (since <= b.target) {
        b.done = true;
        b.finishedAt = Date.now();
        this.rollups?.flush();
        this.logger.info('backfill complete', { chunks: b.chunks, records: this.store.records.length, ms: b.finishedAt - b.startedAt });
      }
      this.bus.publish('sync', this.progress());
      return true;
    });
  }

  /**
   * History lane (monthly reports): from the start of (current month − N)
   * up to the backfill target, one 6-hour chunk per step, feeding only the
   * rollups. A chunk is buffered and committed whole, so a failure mid-way
   * never half-counts it. Progress persists in meta.historyDoneThrough.
   */
  async historyStep() {
    const R = this.rollups;
    if (!R || !this.backfill?.done) return false;
    const d = new Date();
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - this.config.reports.historyMonths, 1);
    if (R.meta.historyFrom === null || start < R.meta.historyFrom) {
      R.meta.historyFrom = start;
      R.meta.historyDoneThrough = start;
    }
    const end = this.backfill.target;
    const cursor = Math.max(R.meta.historyDoneThrough ?? start, R.meta.historyFrom);
    if (cursor >= end) {
      if (R.backfill.running) { R.backfill = { ...R.backfill, running: false }; R.flush(); this.logger.info('history backfill complete', { months: R.months.size }); }
      return false;
    }
    const until = Math.min(cursor + HISTORY_CHUNK_MS, end);
    const total = Math.max(1, Math.ceil((end - R.meta.historyFrom) / DAY));
    R.backfill = { running: true, done: Math.floor((cursor - R.meta.historyFrom) / DAY), total, month: new Date(cursor).toISOString().slice(0, 7) };

    await this.#streamed('history', async () => {
      const buf = [];
      for await (const batch of this.provider.recordBatches({ since: cursor, until })) buf.push(...batch);
      R.addHistory(buf);
      R.markCovered(cursor, until - 1);
      R.meta.historyDoneThrough = until;
    });
    R.backfill = { ...R.backfill, done: Math.floor((until - R.meta.historyFrom) / DAY) };
    return true;
  }

  /**
   * Startup: the cheap, high-value calls first (balance, groups), then a
   * short live head of records. Everything older streams in afterwards.
   * Failures are logged, not fatal: the scheduler keeps retrying.
   */
  async bootstrap() {
    const t0 = performance.now();
    for (const [name, fn] of [['balance', () => this.syncBalance()], ['groups', () => this.syncGroups()], ['assistants', () => this.syncAssistants()], ['records', () => this.syncRecords()]]) {
      try { await fn(); } catch (err) { this.logger.warn('bootstrap step failed', { step: name, err: err.message }); }
    }
    this.logger.info('bootstrap complete', {
      ms: Math.round(performance.now() - t0),
      records: this.store.records.length,
      balance: this.store.balance?.balance ?? null,
    });
  }

  /** What the UI shows: how far back data reaches and whether we're throttled. */
  progress() {
    const b = this.backfill;
    const span = b ? b.from - b.target : 0;
    const R = this.rollups;
    return {
      live: { watermark: this.watermark, lastSyncAt: this.lastSync.records || null },
      backfill: b ? {
        done: b.done,
        coveredFrom: b.cursor,
        target: b.target,
        pct: span > 0 ? Math.min(1, (b.from - b.cursor) / span) : 1,
      } : null,
      history: R ? { ...R.backfill } : null,
      throttle: this.provider.pacer?.stats?.() ?? null,
    };
  }

  stats() {
    return { watermark: this.watermark, retries: this.retries, lastSync: this.lastSync, progress: this.progress() };
  }
}
