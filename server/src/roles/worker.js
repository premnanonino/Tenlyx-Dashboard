import { createLogger } from '../core/logger.js';
import { EventBus } from '../core/eventBus.js';
import { AdaptivePacer } from '../infra/adaptivePacer.js';
import { CircuitBreaker } from '../infra/circuitBreaker.js';
import { SingleFlight } from '../infra/singleFlight.js';
import { Scheduler } from '../infra/scheduler.js';
import { TelnyxClient } from '../providers/telnyxClient.js';
import { BillingSync } from '../services/billingSync.js';
import { ReportBuilder } from '../services/reportBuilder.js';
import { CallsSync } from '../services/callsSync.js';
import { CourserevCalls } from '../providers/courserevCalls.js';
import { openDatabase } from '../db/index.js';
import { PgSyncTarget, pgCheckpoints } from '../persistence/pgSyncTarget.js';
import { onShutdown, requireTelnyxKey } from '../http.js';

const DAY = 86_400_000;
const RETENTION_EVERY_MS = 60 * 60_000;

/**
 * Production sync worker: the only process that talks to Telnyx.
 * Telnyx → adaptive pacer / retry / checkpoints → PostgreSQL.
 * It serves no HTTP; its status lives in kv('sync_status').
 */
export async function start(config) {
  const log = createLogger('tlxmon.worker');
  requireTelnyxKey(config, log);

  const db = await openDatabase(config, { logger: log });

  // One worker per database, ever: a second one waits on standby.
  // PostgreSQL: session advisory lock. libSQL: a renewed lease row in kv.
  let lock = await db.workerLock();
  while (!lock) {
    log.warn('another sync worker holds the lock; standing by');
    await new Promise((r) => setTimeout(r, 30_000));
    lock = await db.workerLock();
  }

  // libSQL lease: renew it from the moment it is held (bootstrap and the first
  // report build can outlast the TTL). If it is ever lost, stop at once so two
  // workers never sync together.
  let leaseTimer = null;
  if (lock.renewEveryMs) {
    const renew = async () => {
      if (await lock.renew()) {
        // Normally every renewEveryMs; while the database is unreachable, check
        // again no later than the lease's own expiry, so this worker always
        // stops before a standby worker can take the lease over.
        leaseTimer = setTimeout(renew, Math.max(0, Math.min(lock.renewEveryMs, lock.validUntil() - Date.now())));
        return;
      }
      log.error('worker lease lost; stopping so the new holder runs alone');
      process.exit(1);
    };
    leaseTimer = setTimeout(renew, lock.renewEveryMs);
  }

  const { repo } = db;
  const bus = new EventBus();
  const pacer = new AdaptivePacer({ startRps: Math.min(1, config.telnyx.outboundRps), maxRps: config.telnyx.outboundRps });
  const provider = new TelnyxClient({ config, pacer, logger: log.child('telnyx') });
  const flight = new SingleFlight();
  const breaker = new CircuitBreaker({
    name: 'telnyx',
    onChange: (e) => { log.warn('breaker transition', e); repo.logEvent('warn', 'breaker', `circuit ${e.from} → ${e.to}`); },
  });
  const scheduler = new Scheduler({ logger: log.child('scheduler') });
  const sync = new BillingSync({
    provider, store: new PgSyncTarget({ repo }), breaker, flight, bus, logger: log.child('sync'), config,
    checkpoints: pgCheckpoints(repo),
  });
  // A closed month can be finalized once the sync has read all of it: it lies
  // before the history window (nothing more will ever be fetched for it), or
  // inside what the backfill and history lanes have fully covered.
  const monthComplete = (from, to) => {
    const b = sync.backfill;
    const h = sync.history;
    if (!b?.done) return false;
    if (h?.from != null && to <= h.from) return true;
    const historyDone = !!h && h.doneThrough >= b.target;
    const coveredFrom = historyDone ? Math.min(h.from, b.target) : b.target;
    return from >= coveredFrom;
  };
  const reports = new ReportBuilder({
    repo,
    logger: log.child('reports'),
    retentionMs: config.retentionDays * DAY,
    // Late call legs and the restart backfill can still add to a closed month.
    graceMs: (config.telnyx.backfillDays + 1) * DAY,
    monthComplete,
  });
  // Call History: read-only copy of CourseRev's conversations (optional).
  const callsSource = config.calls.url ? new CourserevCalls({ url: config.calls.url, max: 1, logger: log.child('calls') }) : null;
  const callsSync = callsSource
    ? new CallsSync({ source: callsSource, repo, logger: log.child('calls'), historyDays: config.calls.historyDays, batch: config.calls.batch })
    : null;
  const startedAt = Date.now();
  let totalRecords = await repo.recordCount();
  bus.on('records', (e) => { totalRecords += e.payload.added; });

  /** Run a lane; failures are logged to sync_events so the dashboard can show them. */
  const lane = (name, fn) => async () => {
    try {
      return await fn();
    } catch (err) {
      await repo.logEvent(err.throttled ? 'warn' : 'error', name, err.message);
      throw err;
    }
  };

  const publishStatus = async () => {
    const s = sync.stats();
    await repo.setKv('sync_status', {
      heartbeatAt: Date.now(),
      startedAt,
      pid: process.pid,
      progress: sync.progress(),
      sync: { retries: s.retries + provider.metrics.retries, lastSync: s.lastSync, counters: s.counters },
      telnyx: provider.metrics,
      pacer: pacer.stats(),
      breaker: breaker.stats(),
      jobs: scheduler.stats(),
      reports: reports.stats,
      totalRecords,
      calls: callsSync ? { ...callsSync.progress(), source: callsSource.metrics } : null,
      reportMeta: {
        liveFrom: sync.backfill?.target ?? null,
        historyFrom: sync.history?.from ?? null,
        historyDoneThrough: sync.history?.doneThrough ?? null,
        highWater: sync.watermark ?? 0,
      },
    });
  };

  // Progress events are frequent during backfill: publish at most every 2 s.
  let statusTimer = null;
  bus.on('sync', () => {
    if (statusTimer) return;
    statusTimer = setTimeout(() => { statusTimer = null; publishStatus().catch(() => {}); }, 2_000);
  });

  scheduler
    .add({ name: 'records', everyMs: config.poll.recordsMs, run: lane('records', () => sync.syncRecords()) })
    .add({ name: 'balance', everyMs: config.poll.balanceMs, run: lane('balance', () => sync.syncBalance()) })
    .add({ name: 'groups', everyMs: config.poll.groupsMs, run: lane('groups', () => sync.syncGroups()) })
    .add({ name: 'assistants', everyMs: config.poll.groupsMs, run: lane('assistants', () => sync.syncAssistants()) })
    .add({ name: 'backfill', everyMs: 500, jitter: 0, maxBackoffMs: 60_000, run: lane('backfill', () => sync.backfillStep()) })
    .add({ name: 'history', everyMs: 2_000, jitter: 0, maxBackoffMs: 5 * 60_000, run: lane('history', () => sync.historyStep()) })
    // Monthly statements: built from PostgreSQL, never from Telnyx.
    .add({ name: 'reports', everyMs: config.worker.reportsEveryMs, run: lane('reports', () => reports.run()) })
    // Retention: raw records and balance snapshots older than the window, once counted and finalized.
    .add({ name: 'retention', everyMs: RETENTION_EVERY_MS, run: lane('retention', () => reports.prune()) })
    .add({ name: 'status', everyMs: config.worker.heartbeatMs, jitter: 0, run: publishStatus })
    // "Sync now" from the dashboard (queued by the API, rate-limited there).
    .add({
      name: 'sync-requests', everyMs: 5_000, jitter: 0,
      run: async () => {
        if (!(await repo.claimSyncRequests())) return;
        log.info('manual sync requested');
        await Promise.allSettled([lane('records', () => sync.syncRecords())(), lane('balance', () => sync.syncBalance())()]);
      },
    });

  // Call History: one small read-only batch from CourseRev per tick (see services/callsSync.js).
  if (callsSync) {
    scheduler.add({ name: 'calls', everyMs: config.calls.tickMs, jitter: 0, maxBackoffMs: 5 * 60_000, run: lane('calls', () => callsSync.tick()) });
  }

  log.info('sync worker started', { rps: config.telnyx.outboundRps, types: provider.recordTypes, records: totalRecords });
  await sync.bootstrap();
  await reports.run().catch((err) => log.warn('initial report build failed', { err: err.message }));
  await publishStatus().catch(() => {});
  scheduler.start();

  onShutdown(async () => {
    scheduler.stop();
    await publishStatus().catch(() => {});
    clearTimeout(leaseTimer);
    await lock.release();
    await callsSource?.close().catch(() => {});
    await db.close().catch(() => {});
  }, log);
}
