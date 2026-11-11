import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReportBuilder } from '../src/services/reportBuilder.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const clone = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v))); // like jsonb

/**
 * In-memory stand-in for PgRepo with the same semantics as its SQL:
 * PK dedupe, identity seq, ts filters, transactional saveRollups that never
 * overwrites a finalized month, and prune limited by seq / ts.
 */
class FakeRepo {
  constructor() {
    this.records = []; this.seq = 0; this.balances = [];
    this.kv = new Map(); this.rollups = new Map();
    this.calls = { monthRecords: 0, watermarks: 0, recordsAfter: 0 };
    this.failSave = false;
  }

  insert(recs) { for (const r of recs) if (!this.records.some((x) => x.data.id === r.id)) this.records.push({ seq: ++this.seq, data: clone(r) }); }
  addBalance(b) { if (!this.balances.some((x) => x.ts === b.ts)) this.balances.push(clone(b)); this.balances.sort((a, c) => a.ts - c.ts); }

  async recordsAfter(seq, { limit = 5000 } = {}) {
    this.calls.recordsAfter++;
    return this.records.filter((x) => x.seq > seq).sort((a, b) => a.seq - b.seq).slice(0, limit).map((x) => ({ seq: x.seq, data: clone(x.data) }));
  }
  async balancesAfter(ts, limit = 6000) { return this.balances.filter((b) => b.ts > ts).slice(0, limit).map(clone); }
  async balancesBetween(from, to, maxTs = null) { return this.balances.filter((b) => b.ts >= from && b.ts < to && (maxTs === null || b.ts <= maxTs)).map(clone); }
  async getKv(k) { return clone(this.kv.get(k)); }
  async loadRollupState() { return [...this.rollups].sort().map(([month, v]) => ({ month, data: clone(v.data), finalizedAt: v.finalizedAt })); }

  async watermarks() {
    this.calls.watermarks++;
    const ts = this.records.map((x) => x.data.ts);
    const bt = this.balances.map((b) => b.ts);
    return {
      seq: this.records.length ? Math.max(...this.records.map((x) => x.seq)) : 0,
      minTs: ts.length ? Math.min(...ts) : null, maxTs: ts.length ? Math.max(...ts) : null,
      minBalanceTs: bt.length ? Math.min(...bt) : null, maxBalanceTs: bt.length ? Math.max(...bt) : null,
    };
  }

  async* monthRecords(from, to, { maxSeq = null } = {}) {
    this.calls.monthRecords++;
    yield this.records.filter((x) => x.data.ts >= from && x.data.ts < to && (maxSeq === null || x.seq <= maxSeq))
      .sort((a, b) => a.data.ts - b.data.ts).map((x) => clone(x.data));
  }

  async saveRollups(months, cursor) {
    if (this.failSave) throw new Error('db down');
    for (const m of months) {
      const cur = this.rollups.get(m.month);
      if (cur?.finalizedAt) continue;
      this.rollups.set(m.month, { data: clone(m.data), count: m.count, finalizedAt: null });
    }
    this.kv.set('rollup_cursor', clone(cursor));
  }

  async finalizeMonth(month) { const r = this.rollups.get(month); if (!r || r.finalizedAt) return false; r.finalizedAt = Date.now(); return true; }

  async pruneRecords(cutoff, maxSeq) {
    const before = this.records.length;
    this.records = this.records.filter((x) => !(x.data.ts < cutoff && x.seq <= maxSeq));
    return before - this.records.length;
  }

  async pruneBalances(cutoff, maxTs) {
    const before = this.balances.length;
    this.balances = this.balances.filter((b) => !(b.ts < cutoff && b.ts <= maxTs));
    return before - this.balances.length;
  }

  summary(month) { return this.rollups.get(month)?.data ?? null; }
}

let n = 0;
const rec = (ts, cost = 1, extra = {}) => ({
  id: `messaging:${++n}`, ts, product: 'messaging', direction: 'outbound', destination: `+1555${n % 7}`,
  country: 'US', billingGroupId: null, units: 1, unitLabel: 'seg', rate: cost, cost, currency: 'USD', status: 'delivered', ...extra,
});
const bal = (ts, balance) => ({ ts, balance, availableCredit: balance, creditLimit: 0, pending: 0, currency: 'USD' });

/** Records every 6 hours from `from` to `to`. */
const series = (from, to, cost = 1) => { const out = []; for (let t = from; t < to; t += 6 * HOUR) out.push(rec(t, cost)); return out; };

const NOW = Date.UTC(2026, 10, 10, 12); // 2026-11-10 12:00 UTC
const AUG = Date.UTC(2026, 7, 1); const SEP = Date.UTC(2026, 8, 1); const OCT = Date.UTC(2026, 9, 1); const NOV = Date.UTC(2026, 10, 1);
const complete = () => true;

function builder(repo, opts = {}) {
  return new ReportBuilder({ repo, retentionMs: 35 * DAY, graceMs: 8 * DAY, monthComplete: complete, ...opts });
}

test('reports: first run builds from raw rows, later runs only read new rows', async () => {
  const repo = new FakeRepo();
  repo.insert(series(OCT, NOW - DAY));
  const rb = builder(repo);

  await rb.run(NOW);
  const octCount = series(OCT, NOV).length;
  assert.equal(repo.summary('2026-10').count, octCount);
  assert.equal(rb.stats.fullRebuilds, 1);
  const scans = repo.calls.monthRecords;
  const marks = repo.calls.watermarks;

  // New rows arrive; the next run is incremental: no month scan, no table bounds.
  const fresh = series(NOW - DAY, NOW, 2);
  repo.insert(fresh);
  await rb.run(NOW + 5 * 60_000);
  assert.equal(repo.calls.monthRecords, scans, 'incremental run must not rescan a month');
  assert.equal(repo.calls.watermarks, marks, 'incremental run must not read table bounds');
  const novExpected = series(NOV, NOW - DAY).length + fresh.length;
  assert.equal(repo.summary('2026-11').count, novExpected);
  assert.equal(rb.stats.incrementalRecords, fresh.length);

  // A run with nothing new writes nothing.
  const saved = JSON.stringify(repo.summary('2026-11'));
  await rb.run(NOW + 10 * 60_000);
  assert.equal(JSON.stringify(repo.summary('2026-11')), saved);
});

test('reports: incremental result equals a from-scratch rebuild (cost, days, products, balances)', async () => {
  const repo = new FakeRepo();
  const rb = builder(repo);
  repo.insert(series(NOV, NOV + 2 * DAY));
  repo.addBalance(bal(NOV + HOUR, 500));
  await rb.run(NOW);

  // Several incremental steps, mixed products and balances.
  for (let i = 1; i <= 5; i++) {
    repo.insert([rec(NOV + (2 + i) * DAY, 0.5, { product: i % 2 ? 'voice' : 'messaging' }), rec(NOV + (2 + i) * DAY + HOUR, 0.25)]);
    repo.addBalance(bal(NOV + (2 + i) * DAY, 500 - i));
    await rb.run(NOW + i * HOUR);
  }
  const incremental = repo.summary('2026-11');

  const scratch = new FakeRepo();
  scratch.records = repo.records.map((x) => ({ ...x }));
  scratch.seq = repo.seq;
  scratch.balances = repo.balances.map(clone);
  await builder(scratch).run(NOW);
  const rebuilt = scratch.summary('2026-11');

  assert.equal(incremental.count, rebuilt.count);
  assert.ok(Math.abs(incremental.cost - rebuilt.cost) < 1e-9);
  assert.deepEqual(incremental.days, rebuilt.days);
  assert.deepEqual(incremental.byProduct, rebuilt.byProduct);
  assert.equal(incremental.balanceOpen, 500);
  assert.equal(incremental.balanceClose, 495);
  assert.equal(rebuilt.balanceClose, 495);
});

test('reports: full rebuild runs at most once a day', async () => {
  const repo = new FakeRepo();
  repo.insert(series(NOV, NOW));
  const rb = builder(repo);
  await rb.run(NOW);
  for (let h = 1; h < 24; h++) await rb.run(NOW + h * HOUR);
  assert.equal(rb.stats.fullRebuilds, 1);
  await rb.run(NOW + 24 * HOUR);
  assert.equal(rb.stats.fullRebuilds, 2);
});

test('reports: a failed save neither loses nor double-counts records', async () => {
  const repo = new FakeRepo();
  repo.insert(series(NOV, NOW - DAY));
  const rb = builder(repo);
  await rb.run(NOW);
  const extra = series(NOW - DAY, NOW);
  repo.insert(extra);

  repo.failSave = true;
  await assert.rejects(rb.run(NOW + HOUR), /db down/);
  repo.failSave = false;
  await rb.run(NOW + 2 * HOUR); // reloads state from the "database" and retries
  await rb.run(NOW + 3 * HOUR);
  assert.equal(repo.summary('2026-11').count, series(NOV, NOW - DAY).length + extra.length);
});

test('reports: closed months finalize only after the grace period and once complete', async () => {
  const repo = new FakeRepo();
  repo.insert(series(OCT, Date.UTC(2026, 10, 3)));
  let ready = false;
  const rb = builder(repo, { monthComplete: () => ready });

  await rb.run(Date.UTC(2026, 10, 3)); // 2 days after October closed: inside the 8-day grace
  assert.equal(repo.rollups.get('2026-10').finalizedAt, null);

  await rb.run(Date.UTC(2026, 10, 10)); // grace passed, but the sync hasn't read all of October yet
  assert.equal(repo.rollups.get('2026-10').finalizedAt, null);

  ready = true;
  await rb.run(Date.UTC(2026, 10, 10, 1));
  assert.ok(repo.rollups.get('2026-10').finalizedAt, 'October finalized');
  assert.equal(repo.rollups.get('2026-11').finalizedAt, null, 'current month stays open');
});

test('retention: deletes rows older than 35 days only after their month is finalized', async () => {
  const repo = new FakeRepo();
  repo.insert(series(AUG, NOW));
  for (let t = AUG; t < NOW; t += DAY) repo.addBalance(bal(t, 1000 - (t - AUG) / DAY));
  let ready = false;
  const rb = builder(repo, { monthComplete: () => ready });
  await rb.run(NOW);

  // Nothing finalized yet: August's raw rows must stay, whatever their age.
  await rb.prune(NOW);
  assert.ok(repo.records.some((x) => x.data.ts < SEP), 'open month rows kept');

  ready = true;
  await rb.run(NOW + HOUR);
  const res = await rb.prune(NOW + HOUR);
  const cutoff = NOW + HOUR - 35 * DAY;
  assert.ok(res.records > 0 && res.balances > 0);
  assert.ok(repo.records.every((x) => x.data.ts >= cutoff), 'no raw record older than 35 days');
  assert.ok(repo.balances.every((b) => b.ts >= cutoff), 'no balance snapshot older than 35 days');
  assert.ok(repo.records.some((x) => x.data.ts < cutoff + DAY), 'rows inside the window kept');
});

test('retention: never deletes rows the builder has not counted yet', async () => {
  const repo = new FakeRepo();
  repo.insert(series(SEP, NOW));
  const rb = builder(repo);
  await rb.run(NOW);
  // A late history page lands after the last run: old, but not yet counted.
  const late = rec(Date.UTC(2026, 8, 15), 7);
  repo.insert([late]);
  await rb.prune(NOW);
  assert.ok(repo.records.some((x) => x.data.id === late.id));
});

test('retention: pruning never changes a finalized month, even across rebuilds and re-synced rows', async () => {
  const repo = new FakeRepo();
  repo.insert(series(AUG, NOW));
  for (let t = AUG; t < NOW; t += DAY) repo.addBalance(bal(t, 2000 - (t - AUG) / DAY));
  const rb = builder(repo);
  await rb.run(NOW);
  const before = { aug: clone(repo.summary('2026-08')), sep: clone(repo.summary('2026-09')), oct: clone(repo.summary('2026-10')) };
  assert.equal(before.aug.count, series(AUG, SEP).length);

  await rb.prune(NOW);
  assert.ok(!repo.records.some((x) => x.data.ts < SEP), 'August raw rows gone');

  // Daily full rebuild after pruning: finalized months are skipped, not rebuilt from partial rows.
  await rb.run(NOW + 25 * HOUR);
  assert.equal(rb.stats.fullRebuilds, 2);
  // A fresh process (state reloaded from the database) behaves the same.
  const rb2 = builder(repo);
  await rb2.run(NOW + 26 * HOUR);
  await rb2.prune(NOW + 26 * HOUR);
  await rb2.run(NOW + 51 * HOUR);

  // A pruned record re-inserted by a history re-read is ignored, not double-counted.
  repo.insert([rec(Date.UTC(2026, 7, 10), 99)]);
  await rb2.run(NOW + 52 * HOUR);
  assert.ok(rb2.stats.lateIgnored >= 1);

  assert.deepEqual(repo.summary('2026-08'), before.aug);
  assert.deepEqual(repo.summary('2026-09'), before.sep);
  assert.deepEqual(repo.summary('2026-10'), before.oct);
});

test('reports: a rebuild with fewer records than the stored summary is rejected', async () => {
  const repo = new FakeRepo();
  repo.insert(series(OCT, NOW));
  const rb = builder(repo, { monthComplete: () => false }); // keep October open
  await rb.run(NOW);
  const oct = clone(repo.summary('2026-10'));
  // Simulate raw rows of an open month going missing (e.g. a manual DELETE).
  repo.records = repo.records.filter((x) => x.data.ts >= Date.UTC(2026, 9, 20));
  await rb.run(NOW + 25 * HOUR); // daily full rebuild
  assert.equal(rb.stats.rebuildsRejected, 1);
  assert.deepEqual(repo.summary('2026-10'), oct);
});
