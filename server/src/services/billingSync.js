import { retry } from '../infra/retry.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const HISTORY_CHUNK_MS = 6 * HOUR;
const GAP_REPLAN_MS = 2 * HOUR; // a restored watermark older than this is filled by the backfill lane

/**
 * Pulls data from the provider into a store, batch by batch.
 *
 * Three lanes share one adaptive pacer (see infra/adaptivePacer.js):
 *
 *   live       every poll reads [watermark - overlap, now]. On a cold start
 *              it reads only the last hour, so numbers appear within seconds.
 *   backfill   walks a queue of time ranges newest-first, one small chunk
 *              per step, ingesting each upstream page as it arrives.
 *   history    once the backfill is done, fetches older months (lowest
 *              priority).
 *
 * Two storage modes:
 *
 *   memory      (local dev) `store` is the in-memory BillingStore and
 *               monthly rollups are fed directly.
 *   persistent  (production worker) `store` writes PostgreSQL with
 *               ON CONFLICT DO NOTHING, and `checkpoints` saves the position
 *               after every page: a restart resumes at the next page, a
 *               downtime gap is queued for the backfill, and monthly reports
 *               are built separately from the stored records.
 */
export class BillingSync {
  constructor({ provider, store, breaker, flight, bus, logger, config, rollups = null, checkpoints = null }) {
    Object.assign(this, { provider, store, breaker, flight, bus, logger, config, rollups, checkpoints });
    this.persistent = !!checkpoints;
    this.watermark = null;
    this.backfill = null;
    this.history = null;
    this.retries = 0;
    this.lastSync = { balance: 0, records: 0, groups: 0 };
    this.counters = { inserted: 0, duplicates: 0, pages: 0 };
  }

  /** Coalesce + breaker + retry, for cheap single calls (balance, groups). */
  #guarded(key, fn) {
    return this.flight.do(key, () =>
      this.breaker.exec(() =>
        retry(fn, {
          retries: 2,
          // The client already waited out 429s and retried 5xx: only retry what's left.
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

  // ---- checkpoints -------------------------------------------------------
  async restore() {
    if (!this.persistent) return;
    const cp = await this.checkpoints.load();
    if (!cp) return;
    this.watermark = cp.watermark ?? null;
    this.backfill = cp.backfill ?? null;
    this.history = cp.history ?? null;
    this.logger.info('sync checkpoint restored', {
      watermark: this.watermark && new Date(this.watermark).toISOString(),
      backfillPending: this.backfill?.pending?.length ?? 0,
      historyDoneThrough: this.history?.doneThrough && new Date(this.history.doneThrough).toISOString(),
    });
  }

  #save() {
    if (!this.persistent) return Promise.resolve();
    return this.checkpoints.save({ watermark: this.watermark, backfill: this.backfill, history: this.history });
  }

  // ---- metadata ----------------------------------------------------------
  async syncGroups() {
    const groups = await this.#guarded('groups', () => this.provider.listBillingGroups());
    await this.store.setGroups(groups);
    this.lastSync.groups = Date.now();
  }

  async syncAssistants() {
    if (!this.provider.listAssistants || this.assistantsUnsupported) return;
    try {
      const list = await this.#guarded('assistants', () => this.provider.listAssistants());
      await this.store.setAssistants(list);
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
    if (this.store.balanceHistory && !this.store.balanceHistory.length) this.#seedBalanceHistory(b);
    await this.store.setBalance(b);
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

  // ---- records -----------------------------------------------------------
  /** Stream [since, until) into the store page by page; `onPage` checkpoints. */
  async #ingestRange({ since, until, live, resume = null, onPage = null }) {
    let added = 0;
    for await (const batch of this.provider.recordBatches({ since, until, resume })) {
      const now = Date.now();
      const fresh = await this.store.ingest(batch, now);
      this.rollups?.addLive(fresh);
      this.counters.pages++;
      this.counters.inserted += fresh.length;
      this.counters.duplicates += batch.length - fresh.length;
      if (onPage && batch.pos) await onPage(batch.pos);
      if (!fresh.length) continue;
      added += fresh.length;
      let cost = 0;
      for (const r of fresh) cost += r.cost;
      this.bus.publish('records', {
        added: fresh.length,
        cost,
        backfill: !live,
        // Only genuinely new activity goes on the ticker tape.
        latest: live && this.store.present ? fresh.slice(-12).reverse().map((r) => this.store.present(r)) : [],
      });
    }
    return added;
  }

  /** Live lane: the newest records. Cold start reads only a short head. */
  async syncRecords() {
    return this.#streamed('records', async () => {
      const now = Date.now();
      let since;
      if (this.watermark === null) {
        since = now - this.config.sync.liveHeadMs;
        this.#planBackfill(since, now);
      } else if (now - this.watermark > GAP_REPLAN_MS) {
        // Back after downtime: read a short live head now, queue the gap for the backfill lane.
        since = now - this.config.sync.liveHeadMs;
        this.#queueGap(this.watermark - this.config.poll.overlapMs, since);
      } else {
        since = this.watermark - this.config.poll.overlapMs;
      }

      const added = await this.#ingestRange({ since, until: now, live: true });
      // Advance only after the whole window succeeded; a failed poll re-reads it.
      this.watermark = now;
      this.rollups?.markCovered(since, now);
      this.store.evict?.(now);
      this.store.tick?.(now);
      this.lastSync.records = Date.now();
      await this.#save();
      this.bus.publish('sync', this.progress());
      return added;
    });
  }

  /**
   * Decide how far back to fill: the configured backfill window. In memory
   * mode it also extends over downtime since the rollups were last counted
   * (bounded by the store's retention).
   */
  #planBackfill(headStart, now) {
    const raw = now - this.config.telnyx.backfillDays * DAY;
    let target = raw;
    if (!this.persistent) {
      const floor = now - this.config.retentionDays * DAY + HOUR;
      const lastCounted = this.rollups?.bootHighWater || 0;
      target = Math.max(floor, lastCounted > 0 ? Math.min(raw, lastCounted) : raw);
    }
    this.backfill = {
      from: headStart, target, cursor: headStart, done: target >= headStart,
      pending: target < headStart ? [[target, headStart]] : [],
      pos: null, chunks: 0, startedAt: now, finishedAt: null,
    };
    if (this.rollups) this.rollups.meta.liveFrom = target;
    this.logger.info('backfill planned', { from: new Date(target).toISOString(), to: new Date(headStart).toISOString() });
  }

  /** Queue [lo, hi) for the backfill lane (newest first), e.g. after downtime. */
  #queueGap(lo, hi) {
    if (!(hi > lo)) return;
    const b = this.backfill ?? { from: hi, target: lo, cursor: hi, pending: [], pos: null, chunks: 0, startedAt: Date.now(), finishedAt: null };
    b.pending = [[lo, hi], ...(b.pending || [])];
    b.from = Math.max(b.from, hi);
    b.cursor = hi;
    b.done = false;
    b.finishedAt = null;
    b.pos = null;
    this.backfill = b;
    this.logger.info('downtime gap queued for backfill', { from: new Date(lo).toISOString(), to: new Date(hi).toISOString() });
  }

  /** Backfill lane: one chunk, newest first. Called repeatedly by the scheduler. */
  async backfillStep() {
    const b = this.backfill;
    if (!b || b.done) return false;
    if (!b.pending) b.pending = b.cursor > b.target ? [[b.target, b.cursor]] : []; // older checkpoint format
    if (!b.pending.length) { b.done = true; return false; }
    return this.#streamed('backfill', async () => {
      const range = b.pending[0];
      const until = range[1];
      const since = Math.max(range[0], until - this.config.sync.chunkMs);
      // Resume mid-chunk only if the saved page belongs to this exact chunk.
      const resume = b.pos && b.pos.since === since && b.pos.until === until ? b.pos.at : null;
      await this.#ingestRange({
        since, until, live: false, resume,
        onPage: async (at) => { b.pos = { since, until, at }; await this.#save(); },
      });
      b.pos = null;
      range[1] = since;
      if (range[1] <= range[0]) b.pending.shift();
      b.cursor = b.pending[0]?.[1] ?? since;
      b.chunks++;
      this.rollups?.markCovered(since, until);
      if (!b.pending.length) {
        b.done = true;
        b.finishedAt = Date.now();
        this.rollups?.flush();
        this.logger.info('backfill complete', { chunks: b.chunks, ms: b.finishedAt - b.startedAt });
      }
      await this.#save();
      this.bus.publish('sync', this.progress());
      return true;
    });
  }

  /**
   * History lane (monthly reports): from the start of (current month − N)
   * up to the backfill target, one 6-hour chunk per step.
   *   memory:      a chunk is buffered and committed whole into the rollups.
   *   persistent:  pages go straight into PostgreSQL (idempotent) with a
   *                checkpoint per page; reports are rebuilt separately.
   */
  async historyStep() {
    if (!this.backfill?.done) return false;
    return this.persistent ? this.#historyStepPersistent() : this.#historyStepMemory();
  }

  #historyStart() {
    const d = new Date();
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - this.config.reports.historyMonths, 1);
  }

  async #historyStepPersistent() {
    const start = this.#historyStart();
    const end = this.backfill.target;
    const h = this.history ?? (this.history = { from: start, doneThrough: start, pos: null, done: false });
    if (start < h.from) { h.from = start; h.doneThrough = start; h.done = false; h.pos = null; } // window widened
    if (h.doneThrough >= end) {
      if (!h.done) { h.done = true; await this.#save(); this.logger.info('history backfill complete'); }
      return false;
    }
    const since = h.doneThrough;
    const until = Math.min(since + HISTORY_CHUNK_MS, end);
    const resume = h.pos && h.pos.since === since && h.pos.until === until ? h.pos.at : null;
    await this.#streamed('history', () => this.#ingestRange({
      since, until, live: false, resume,
      onPage: async (at) => { h.pos = { since, until, at }; await this.#save(); },
    }));
    h.pos = null;
    h.doneThrough = until;
    h.done = until >= end;
    await this.#save();
    return true;
  }

  async #historyStepMemory() {
    const R = this.rollups;
    if (!R) return false;
    const start = this.#historyStart();
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
   * Startup: restore checkpoints, then the cheap, high-value calls first
   * (balance, groups), then a short live head of records. Everything older
   * streams in afterwards. Failures are logged, not fatal.
   */
  async bootstrap() {
    const t0 = performance.now();
    await this.restore();
    for (const [name, fn] of [['balance', () => this.syncBalance()], ['groups', () => this.syncGroups()], ['assistants', () => this.syncAssistants()], ['records', () => this.syncRecords()]]) {
      try { await fn(); } catch (err) { this.logger.warn('bootstrap step failed', { step: name, err: err.message }); }
    }
    this.logger.info('bootstrap complete', { ms: Math.round(performance.now() - t0), inserted: this.counters.inserted });
  }

  /** What the UI shows: how far back data reaches and whether we're throttled. */
  progress() {
    const b = this.backfill;
    let backfill = null;
    if (b) {
      const span = b.from - b.target;
      const left = (b.pending || []).reduce((s, [lo, hi]) => s + Math.max(0, hi - lo), 0);
      backfill = {
        done: !!b.done,
        coveredFrom: b.cursor,
        target: b.target,
        pct: b.done ? 1 : span > 0 ? Math.min(1, Math.max(0, 1 - left / span)) : 1,
      };
    }
    let history;
    if (this.persistent) {
      const h = this.history;
      const end = b?.target ?? null;
      history = h && end ? {
        running: !h.done,
        done: Math.floor((h.doneThrough - h.from) / DAY),
        total: Math.max(1, Math.ceil((end - h.from) / DAY)),
        month: new Date(h.doneThrough).toISOString().slice(0, 7),
      } : null;
    } else {
      history = this.rollups ? { ...this.rollups.backfill } : null;
    }
    return {
      live: { watermark: this.watermark, lastSyncAt: this.lastSync.records || null },
      backfill,
      history,
      throttle: this.provider.pacer?.stats?.() ?? null,
    };
  }

  stats() {
    return { watermark: this.watermark, retries: this.retries, lastSync: this.lastSync, counters: this.counters, progress: this.progress() };
  }
}
