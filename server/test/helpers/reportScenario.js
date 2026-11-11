import assert from 'node:assert/strict';
import { ReportBuilder } from '../../src/services/reportBuilder.js';

/**
 * One end-to-end report + retention scenario, run unchanged against every
 * repository backend (PostgreSQL, libSQL). The ReportBuilder is the real one.
 *
 *   repo         a PgRepo or LibsqlRepo on an empty database
 *   countOlder   async (table, cutoffMs) => rows older than cutoff (direct SQL)
 */
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let n = 0;
export const rec = (ts, cost = 1) => ({
  id: `messaging:scn-${++n}`, ts, product: 'messaging', direction: 'outbound', destination: `+1555${n % 5}`,
  country: 'US', billingGroupId: null, units: 1, unitLabel: 'seg', rate: cost, cost, currency: 'USD', status: 'delivered',
});
export const series = (from, to, cost = 1) => { const out = []; for (let t = from; t < to; t += 6 * HOUR) out.push(rec(t, cost)); return out; };

export async function reportScenario({ repo, countOlder }) {
  const NOW = Date.UTC(2026, 10, 10, 12);
  const AUG = Date.UTC(2026, 7, 1); const SEP = Date.UTC(2026, 8, 1);
  await repo.insertRecords(series(AUG, NOW - DAY));
  for (let t = AUG; t < NOW; t += DAY) await repo.insertBalance({ ts: t, balance: 1000 - (t - AUG) / DAY, availableCredit: 1, creditLimit: 0, pending: 0, currency: 'USD' });

  const make = () => new ReportBuilder({ repo, retentionMs: 35 * DAY, graceMs: 8 * DAY, monthComplete: () => true });
  const rb = make();
  await rb.run(NOW); // first run: full rebuild + finalization of Aug, Sep, Oct
  const state = async () => Object.fromEntries((await repo.loadRollupState()).map((r) => [r.month, r]));
  let s = await state();
  assert.equal(s['2026-08'].data.count, series(AUG, SEP).length);
  assert.ok(s['2026-08'].finalizedAt && s['2026-10'].finalizedAt, 'closed months finalized');
  assert.equal(s['2026-11'].finalizedAt, null, 'current month open');
  assert.equal(s['2026-08'].data.balanceOpen, 1000);
  const aug = JSON.stringify(s['2026-08'].data);

  // Incremental: new rows only, applied to November; cursor follows seq.
  const fresh = series(NOW - DAY, NOW, 2);
  await repo.insertRecords(fresh);
  await rb.run(NOW + HOUR);
  s = await state();
  assert.equal(s['2026-11'].data.count, series(Date.UTC(2026, 10, 1), NOW - DAY).length + fresh.length);
  assert.equal((await repo.getKv('rollup_cursor')).seq, (await repo.watermarks()).seq);
  assert.equal(rb.stats.incrementalRecords, fresh.length);

  // Retention: nothing older than 35 days remains.
  const res = await rb.prune(NOW + HOUR);
  const cutoff = NOW + HOUR - 35 * DAY;
  assert.ok(res.records > 0 && res.balances > 0);
  assert.equal(await countOlder('billing_records', cutoff), 0);
  assert.equal(await countOlder('balance_snapshots', cutoff), 0);

  // Re-inserted old record + next day's rebuild + a fresh builder: August untouched.
  await repo.insertRecords([rec(Date.UTC(2026, 7, 10), 99)]);
  await rb.run(NOW + 26 * HOUR); // daily rebuild (runs the incremental step first)
  assert.equal(rb.stats.fullRebuilds, 2);
  assert.equal(rb.stats.lateIgnored, 1, 'late row for a finalized month ignored');
  const rb2 = make(); // a fresh process reloads state from the database
  await rb2.run(NOW + 27 * HOUR);
  assert.equal(rb2.stats.fullRebuilds, 0, 'cursor and rebuild time survive a restart');
  s = await state();
  assert.equal(JSON.stringify(s['2026-08'].data), aug);
}
