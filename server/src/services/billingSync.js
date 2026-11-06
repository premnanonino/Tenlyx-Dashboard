import { retry } from '../infra/retry.js';

const HOUR = 3_600_000;

/**
 * Pulls data from the provider into the store.
 *
 * Every upstream call goes through the same policy stack:
 *   singleFlight (coalesce) -> circuitBreaker (fail fast) -> retry (backoff+jitter) -> provider
 *
 * Records are synced incrementally with a high-water mark. Each poll
 * re-reads a small overlap window so late-arriving records are caught;
 * duplicates are removed by the store's primary-key index.
 */
export class BillingSync {
  constructor({ provider, store, breaker, flight, bus, logger, config, rollups }) {
    Object.assign(this, { provider, store, breaker, flight, bus, logger, config, rollups });
    this.watermark = null;
    this.retries = 0;
    this.lastSync = { balance: 0, records: 0, groups: 0 };
  }

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

  async syncRecords() {
    const now = Date.now();
    const since = this.watermark === null
      ? now - this.config.telnyx.backfillDays * 24 * HOUR
      : this.watermark - this.config.poll.overlapMs;

    const batch = await this.#guarded('records', () =>
      this.provider.listDetailRecords({ since, until: now }),
    );
    if (this.rollups && this.rollups.meta.liveFrom === null) this.rollups.meta.liveFrom = since;
    const added = this.store.ingest(batch, now);
    this.rollups?.addLive(added);
    for (const r of batch) if (this.watermark === null || r.ts > this.watermark) this.watermark = r.ts;
    if (this.watermark === null) this.watermark = since; // empty account: still advance

    this.store.evict(now);
    this.store.tick(now);
    this.lastSync.records = Date.now();

    if (added.length) {
      let cost = 0;
      for (const r of added) cost += r.cost;
      this.bus.publish('records', {
        added: added.length,
        cost,
        latest: added.slice(-12).reverse().map((r) => this.store.present(r)),
      });
    }
    return added.length;
  }

  /**
   * Startup: groups first (so search tokens include group names), then
   * the record backfill, then balance. Failures here are logged, not fatal —
   * the scheduler keeps retrying with backoff.
   */
  async bootstrap() {
    const t0 = performance.now();
    for (const [name, fn] of [['groups', () => this.syncGroups()], ['assistants', () => this.syncAssistants()], ['records', () => this.syncRecords()], ['balance', () => this.syncBalance()]]) {
      try { await fn(); } catch (err) { this.logger.warn('bootstrap step failed', { step: name, err: err.message }); }
    }
    this.logger.info('bootstrap complete', {
      ms: Math.round(performance.now() - t0),
      records: this.store.records.length,
      balance: this.store.balance?.balance ?? null,
    });
  }

  /**
   * Monthly-report history: walk day by day from the start of
   * (current month − N) up to the first live sync, feeding only the
   * rollups (raw records are older than retention). Progress is persisted
   * via meta.historyDoneThrough, so a restart resumes where it stopped.
   */
  async backfillHistory() {
    const R = this.rollups;
    if (!R || R.meta.liveFrom === null) return;
    const d = new Date();
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - this.config.reports.historyMonths, 1);
    if (R.meta.historyFrom === null || start < R.meta.historyFrom) {
      R.meta.historyFrom = start;
      R.meta.historyDoneThrough = start;
    }
    const end = R.meta.liveFrom;
    let cursor = R.meta.historyDoneThrough;
    if (cursor >= end) return;
    const DAY = 24 * HOUR;
    R.backfill = { running: true, done: 0, total: Math.ceil((end - cursor) / DAY), month: null };
    this.logger.info('history backfill start', { from: new Date(cursor).toISOString(), to: new Date(end).toISOString() });
    try {
      while (cursor < end) {
        const until = Math.min(cursor + DAY, end);
        const batch = await this.#guarded(`history:${cursor}`, () => this.provider.listDetailRecords({ since: cursor, until }));
        R.addHistory(batch);
        cursor = until;
        R.meta.historyDoneThrough = cursor;
        R.backfill.done++;
        R.backfill.month = new Date(cursor).toISOString().slice(0, 7);
        await new Promise((r) => setImmediate(r)); // yield to request handling
      }
      R.flush();
      this.logger.info('history backfill complete', { months: R.months.size });
    } finally {
      R.backfill.running = false;
    }
  }

  stats() {
    return { watermark: this.watermark, retries: this.retries, lastSync: this.lastSync };
  }
}
