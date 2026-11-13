import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BillingSync } from '../src/services/billingSync.js';
import { BillingStore } from '../src/services/billingStore.js';
import { MonthlyRollups } from '../src/services/monthlyRollups.js';
import { CircuitBreaker } from '../src/infra/circuitBreaker.js';
import { SingleFlight } from '../src/infra/singleFlight.js';
import { Scheduler } from '../src/infra/scheduler.js';
import { EventBus } from '../src/core/eventBus.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const quiet = { info() {}, warn() {}, debug() {}, error() {} };

/** Fake Telnyx: one record every 20 min for 80 days; every 5th page call is throttled. */
function fakeProvider(now) {
  const all = [];
  for (let ts = now - 80 * DAY; ts < now; ts += 20 * 60_000) {
    all.push({ id: `messaging:${ts}`, ts, cost: 0.01, product: 'messaging', country: 'US', direction: 'outbound', destination: '+1', units: 1, status: 'delivered', currency: 'USD' });
  }
  let calls = 0;
  return {
    all,
    pacer: { stats: () => ({ rps: 1 }), coolingDownMs: () => 0 },
    getBalance: async () => ({ balance: 100, availableCredit: 100, creditLimit: 0, pending: 0, currency: 'USD', ts: now }),
    listBillingGroups: async () => [],
    listAssistants: async () => [],
    async* recordBatches({ since, until }) {
      const rows = all.filter((r) => r.ts >= since && r.ts < until);
      for (let i = 0; i < rows.length; i += 5) {
        if (++calls % 5 === 0) {
          throw Object.assign(new Error('telnyx 429'), { status: 429, throttled: true, retryable: true, countsAsFailure: false });
        }
        yield rows.slice(i, i + 5);
      }
    },
  };
}

function rig(now, file) {
  const provider = fakeProvider(now);
  const store = new BillingStore({ retentionMs: 35 * DAY });
  const rollups = new MonthlyRollups({ file });
  rollups.load();
  const config = {
    telnyx: { backfillDays: 7 },
    retentionDays: 35,
    sync: { liveHeadMs: HOUR, chunkMs: 6 * HOUR },
    poll: { overlapMs: 30 * 60_000 },
    reports: { historyMonths: 1 },
  };
  const sync = new BillingSync({
    provider, store, rollups, config, logger: quiet, bus: new EventBus(), flight: new SingleFlight(),
    breaker: new CircuitBreaker({ name: 't' }),
  });
  return { provider, store, rollups, sync };
}

const totalCount = (rollups) => rollups.keys().reduce((s, k) => s + rollups.get(k).count, 0);

async function drain(step, max = 2_000) {
  for (let i = 0; i < max; i++) {
    try { if (!(await step())) return; } catch { /* throttled: the next step retries the same chunk */ }
  }
  throw new Error('did not finish');
}

test('batched sync: throttling never loses or double-counts records', async () => {
  const now = Date.now();
  const file = `${process.env.TMPDIR || '/tmp'}/tlxmon-sync-test-${process.pid}.json`;
  const { provider, store, rollups, sync } = rig(now, file);

  // Cold start reads only the newest hour; the live head may itself be throttled.
  for (let i = 0; i < 5 && sync.watermark === null; i++) await sync.syncRecords().catch(() => {});
  assert.ok(sync.watermark !== null, 'live head eventually succeeds');
  assert.ok(store.records.length <= 4, 'cold start loads only a short head');

  await drain(() => sync.backfillStep());
  const b = sync.backfill;
  assert.equal(b.done, true);
  const expectedRaw = provider.all.filter((r) => r.ts >= b.target && r.ts < now).length;
  assert.equal(store.records.length, expectedRaw, 'store holds every record in the backfill window once');
  assert.equal(new Set(store.records.map((r) => r.id)).size, store.records.length);
  assert.equal(sync.progress().backfill.pct, 1);

  await drain(() => sync.historyStep());
  const historyFrom = rollups.meta.historyFrom;
  const expectedAll = provider.all.filter((r) => r.ts >= historyFrom && r.ts < now).length;
  assert.equal(totalCount(rollups), expectedAll, 'monthly rollups count every record exactly once');

  // Restart: empty store, same rollups file. Re-reading must not double count.
  rollups.flush();
  const again = rig(now, file);
  await drain(async () => { await again.sync.syncRecords(); return false; }).catch(() => {});
  await drain(() => again.sync.backfillStep());
  assert.equal(totalCount(again.rollups), expectedAll, 'no double counting after a restart');
  fs.unlinkSync(file);
});

test('scheduler: a run that never settles times out and the job keeps running', async () => {
  const scheduler = new Scheduler();
  let calls = 0;
  // First run hangs forever (like a query on a dropped connection); later runs succeed.
  scheduler.add({ name: 'hang', everyMs: 5, jitter: 0, maxBackoffMs: 5, timeoutMs: 20, run: () => (++calls === 1 ? new Promise(() => {}) : Promise.resolve()) });
  scheduler.start();
  const deadline = Date.now() + 2_000;
  while (calls < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  scheduler.stop();
  const [s] = scheduler.stats();
  assert.ok(calls >= 3, `job stalled after ${calls} run(s)`);
  assert.equal(s.failures, 1);
  assert.match(s.lastError ?? 'hang timed out', /timed out/);
});

test('Scheduler.runNow: runs a backed-off job at once and resets its backoff on success', async () => {
  const scheduler = new Scheduler();
  let fail = true;
  let runs = 0;
  scheduler.add({ name: 'j', everyMs: 50, jitter: 0, maxBackoffMs: 60_000, run: async () => { runs++; if (fail) throw new Error('down'); } });
  scheduler.start();
  await new Promise((r) => setTimeout(r, 400)); // fails a few times, backing off
  const job = scheduler.stats()[0];
  assert.ok(job.consecutiveFailures >= 2, 'job is in backoff');
  fail = false;
  const before = runs;
  assert.equal(scheduler.runNow('j'), true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(runs, before + 1, 'ran immediately, without waiting out the backoff');
  assert.equal(scheduler.stats()[0].consecutiveFailures, 0, 'backoff reset');
  scheduler.stop();
  assert.equal(scheduler.runNow('j'), false, 'no-op once stopped');
});
