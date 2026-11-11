import fs from 'node:fs';
import path from 'node:path';
import { SpaceSaving } from '../dsa/SpaceSaving.js';

/**
 * Durable per-month aggregates — the source for monthly reports.
 *
 * Raw records are only kept for the retention window (35 days), so months
 * are rolled up as records stream in and the rollups are persisted to disk
 * (write-behind, atomic tmp+rename). A month's report therefore survives
 * both record eviction and process restarts.
 *
 * Exactly-once counting across restarts:
 *   meta.counted    time intervals [from, to] whose records are fully
 *                   counted (persisted, merged as sync progresses)
 *   bootCounted     those intervals as loaded at startup
 * After a restart the store is empty and the recent backfill re-reads the
 * last days; records inside a boot interval are skipped, so nothing is
 * counted twice, while a downtime gap (outside every interval) is filled.
 * History before meta.liveFrom is filled separately, chunk by chunk, and
 * tracked by meta.historyDoneThrough.
 */
const monthKey = (ts) => new Date(ts).toISOString().slice(0, 7);
const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);

function bump(obj, key, r) {
  const k = key ?? 'unknown';
  const a = obj[k] || (obj[k] = { cost: 0, count: 0, units: 0 });
  a.cost += r.cost;
  a.count += 1;
  a.units += r.units || 0;
}

function emptyAi() {
  return { conversations: 0, cost: 0, minutes: 0, turns: 0, tokensIn: 0, tokensOut: 0, latencySum: 0, latencyN: 0, resolved: 0, transferred: 0, abandoned: 0, outcomeN: 0 };
}

export function addAi(agg, r) {
  const a = r.ai;
  agg.conversations++;
  agg.cost += r.cost;
  agg.minutes += (a.durationSec || 0) / 60;
  agg.turns += a.turns || 0;
  agg.tokensIn += a.tokensIn || 0;
  agg.tokensOut += a.tokensOut || 0;
  if (Number.isFinite(a.latencyMs)) { agg.latencySum += a.latencyMs; agg.latencyN++; }
  if (a.outcome) { agg.outcomeN++; if (agg[a.outcome] !== undefined) agg[a.outcome]++; }
}

export class MonthAgg {
  constructor(key, json) {
    this.key = key;
    Object.assign(this, {
      cost: 0, count: 0, failed: 0, firstTs: null, lastTs: null,
      byProduct: {}, byCountry: {}, byGroup: {}, byDirection: {}, days: {},
      aiModels: {}, aiAssistants: {}, balanceOpen: null, balanceClose: null,
    }, json || {});
    this.dest = SpaceSaving.fromJSON(json?.dest);
  }

  add(r) {
    this.cost += r.cost;
    this.count++;
    if (r.status === 'failed') this.failed++;
    this.firstTs = this.firstTs === null ? r.ts : Math.min(this.firstTs, r.ts);
    this.lastTs = this.lastTs === null ? r.ts : Math.max(this.lastTs, r.ts);
    bump(this.byProduct, r.product, r);
    bump(this.byCountry, r.country, r);
    bump(this.byGroup, r.billingGroupId || 'unassigned', r);
    bump(this.byDirection, r.direction, r);
    const d = this.days[dayKey(r.ts)] || (this.days[dayKey(r.ts)] = { cost: 0, count: 0, byProduct: {} });
    d.cost += r.cost;
    d.count++;
    d.byProduct[r.product] = (d.byProduct[r.product] || 0) + r.cost;
    if (r.product !== 'numbers' && r.ai?.channel !== 'chat' && r.destination) this.dest.add(r.destination, r.cost);
    if (r.ai) {
      addAi(this.aiModels[r.ai.model] || (this.aiModels[r.ai.model] = emptyAi()), r);
      const id = r.ai.assistantId || 'unknown';
      const as = this.aiAssistants[id] || (this.aiAssistants[id] = { ...emptyAi(), models: {} });
      addAi(as, r);
      as.models[r.ai.model] = (as.models[r.ai.model] || 0) + 1;
    }
  }

  noteBalance(b) {
    if (this.balanceOpen === null) this.balanceOpen = b.balance;
    this.balanceClose = b.balance;
  }

  toJSON() {
    const { key, dest, ...rest } = this;
    return { ...rest, dest: dest.toJSON() };
  }
}

export class MonthlyRollups {
  constructor({ file, logger }) {
    this.file = file;
    this.logger = logger;
    this.months = new Map();
    this.meta = { liveFrom: null, highWater: 0, counted: [], historyFrom: null, historyDoneThrough: null };
    this.bootCounted = [];
    this.bootHighWater = 0;
    this.dirty = false;
    this.version = 0;
    this.backfill = { running: false, done: 0, total: 0, month: null };
  }

  load() {
    try {
      const json = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.meta = { ...this.meta, ...json.meta };
      for (const [k, m] of Object.entries(json.months || {})) this.months.set(k, new MonthAgg(k, m));
      this.logger?.info('rollups loaded', { months: this.months.size, highWater: this.meta.highWater });
    } catch (e) {
      if (e.code !== 'ENOENT') this.logger?.warn('rollup file unreadable, starting fresh', { err: e.message });
    }
    // Files written before interval tracking counted [liveFrom, highWater].
    if (!Array.isArray(this.meta.counted)) this.meta.counted = [];
    if (!this.meta.counted.length && this.meta.highWater > 0) {
      this.meta.counted = [[this.meta.liveFrom ?? 0, this.meta.highWater]];
    }
    this.bootCounted = this.meta.counted.map((iv) => [...iv]);
    this.bootHighWater = this.meta.highWater || 0;
  }

  #countedAtBoot(ts) {
    for (const [a, b] of this.bootCounted) if (ts >= a && ts <= b) return true;
    return false;
  }

  /** Record that every record in [from, to] has now been counted. */
  markCovered(from, to) {
    if (!(to >= from)) return;
    const all = [...this.meta.counted, [from, to]].sort((x, y) => x[0] - y[0]);
    const merged = [];
    for (const iv of all) {
      const last = merged[merged.length - 1];
      if (last && iv[0] <= last[1] + 1) last[1] = Math.max(last[1], iv[1]);
      else merged.push([...iv]);
    }
    this.meta.counted = merged;
    this.dirty = true;
  }

  #month(ts) {
    const k = monthKey(ts);
    let m = this.months.get(k);
    if (!m) { m = new MonthAgg(k); this.months.set(k, m); }
    return m;
  }

  /** Records from live polling or the recent backfill (already de-duplicated by the store). */
  addLive(records) {
    let n = 0;
    for (const r of records) {
      if (this.#countedAtBoot(r.ts)) continue;
      this.#month(r.ts).add(r);
      if (r.ts > this.meta.highWater) this.meta.highWater = r.ts;
      n++;
    }
    if (n) { this.dirty = true; this.version++; }
    return n;
  }

  /** One committed history chunk (records outside every interval counted before this boot). */
  addHistory(records) {
    const seen = new Set();
    for (const r of records) {
      if (this.#countedAtBoot(r.ts) || seen.has(r.id)) continue;
      seen.add(r.id);
      this.#month(r.ts).add(r);
    }
    this.dirty = true;
    this.version++;
  }

  noteBalance(b) {
    const m = this.#month(b.ts);
    if (m.balanceOpen === null) m.balanceOpen = b.balance;
    m.balanceClose = b.balance;
    this.dirty = true;
  }

  get(key) { return this.months.get(key) || null; }

  keys() { return [...this.months.keys()].sort(); }

  flush() {
    if (!this.dirty) return false;
    const json = { meta: this.meta, months: Object.fromEntries([...this.months].map(([k, m]) => [k, m.toJSON()])) };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(json));
    fs.renameSync(tmp, this.file); // atomic on POSIX: readers never see a half-written file
    this.dirty = false;
    return true;
  }
}
