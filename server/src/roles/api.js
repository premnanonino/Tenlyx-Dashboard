import { createLogger } from '../core/logger.js';
import { EventBus } from '../core/eventBus.js';
import { LRUCache } from '../dsa/LRUCache.js';
import { TokenBucketLimiter } from '../dsa/TokenBucket.js';
import { SingleFlight } from '../infra/singleFlight.js';
import { Scheduler } from '../infra/scheduler.js';
import { BillingStore } from '../services/billingStore.js';
import { Analytics } from '../services/analytics.js';
import { AlertEngine } from '../services/alertEngine.js';
import { AiAnalytics } from '../services/aiAnalytics.js';
import { Reports } from '../services/reports.js';
import { SseHub } from '../api/sseHub.js';
import { CallsStore } from '../services/callsStore.js';
import { CourserevCalls } from '../providers/courserevCalls.js';
import { createAuth } from '../auth/auth.js';
import { openDatabase } from '../db/index.js';
import { PgRollupsView } from '../persistence/pgRollupsView.js';
import { createHttpApp, listen, onShutdown, requireLoginConfig } from '../http.js';

const RECENT_MS = 2 * 3_600_000; // newer than this counts as "live" for the ticker tape
const CLOSED_BREAKER = { name: 'telnyx', state: 'CLOSED', failureRatio: 0, windowSize: 0, trips: 0, shortCircuited: 0, reopensInMs: 0 };

/**
 * Production dashboard API. Reads PostgreSQL only: it has no Telnyx key and
 * makes no Telnyx calls, so the dashboard keeps working when the worker is
 * down (data just stops advancing, and the UI says so).
 *
 * The existing in-memory indexes (time-sorted log, segment trees, trie)
 * are kept and fed from the database: hydrated at start, then tailed by
 * insertion order (`seq`).
 */
export async function start(config) {
  const log = createLogger('tlxmon.api');
  requireLoginConfig(config, log);

  const db = await openDatabase(config, { logger: log });
  const { repo } = db;

  const auth = createAuth({ config, logger: log.child('auth'), sessionStore: db.sessionStore(config.auth.sessionTtlMs) });
  const bus = new EventBus();
  const retentionMs = config.retentionDays * 86_400_000;
  const store = new BillingStore({ retentionMs });
  const analytics = new Analytics({ store });
  const aiAnalytics = new AiAnalytics({ store });
  const rollups = new PgRollupsView({ repo });
  const reports = new Reports({ rollups, store });
  const cache = new LRUCache(config.cache);
  const limiter = new TokenBucketLimiter(config.rateLimit);
  const flight = new SingleFlight();
  const scheduler = new Scheduler({ logger: log.child('scheduler') });

  // ---- call history (optional): list from memory, detail from CourseRev ------
  const calls = config.calls.url ? {
    store: new CallsStore({
      retentionMs: config.calls.historyDays * 86_400_000,
      internalDomains: config.calls.internalDomains,
      internalNumbers: config.calls.internalNumbers,
      highVolumePerDay: config.calls.highVolumePerDay,
    }),
    source: new CourserevCalls({ url: config.calls.url, max: 2, logger: log.child('calls') }),
  } : null;

  // ---- worker status, mirrored from kv('sync_status') ----------------------
  const remote = { status: null };
  const breaker = { stats: () => remote.status?.breaker ?? CLOSED_BREAKER };
  const schedulerView = { stats: () => [...scheduler.stats(), ...(remote.status?.jobs ?? [])] };
  const sync = {
    progress: () => remote.status?.progress ?? null,
    stats: () => ({ retries: remote.status?.sync?.retries ?? 0, ...(remote.status?.sync ?? {}) }),
  };
  const workerSummary = (s, now = Date.now()) => (s ? {
    alive: now - s.heartbeatAt < config.worker.staleAfterMs,
    heartbeatAt: s.heartbeatAt,
    startedAt: s.startedAt,
    lastRecordsSyncAt: s.sync?.lastSync?.records || null,
    lastBalanceSyncAt: s.sync?.lastSync?.balance || null,
    totalRecords: s.totalRecords ?? null,
    inserted: s.sync?.counters?.inserted ?? 0,
    duplicatesSkipped: s.sync?.counters?.duplicates ?? 0,
    requests: s.telnyx?.requests ?? 0,
    rateLimited: s.telnyx?.throttled ?? 0,
    retries: s.telnyx?.retries ?? 0,
    failures: s.telnyx?.failures ?? 0,
    lastError: s.telnyx?.lastError ?? null,
    rps: s.pacer?.rps ?? null,
    coolingDownMs: s.pacer?.coolingDownMs ?? 0,
    reports: s.reports ?? null,
  } : { alive: false, heartbeatAt: null });

  const alerts = new AlertEngine({ store, analytics, bus, scheduler: schedulerView, breaker, config });
  const saved = await repo.getKv('alert_thresholds').catch(() => null);
  if (saved) alerts.setThresholds(saved);
  const setThresholds = alerts.setThresholds.bind(alerts);
  alerts.setThresholds = (t) => {
    const next = setThresholds(t);
    repo.setKv('alert_thresholds', next).catch((err) => log.warn('could not save thresholds', { err: err.message }));
    return next;
  };
  const sse = new SseHub({ bus, logger: log.child('sse') });
  bus.on('balance', () => alerts.evaluate());

  // ---- database feed -------------------------------------------------------
  const feed = { lastSeq: 0, lastBalanceTs: 0, hydrated: false, groups: '', assistants: '' };

  const ingestRows = (rows, { announce }) => {
    if (!rows.length) return [];
    feed.lastSeq = rows[rows.length - 1].seq;
    const now = Date.now();
    const fresh = store.ingest(rows.map((r) => r.data), now);
    if (fresh.length && announce) {
      let cost = 0;
      for (const r of fresh) cost += r.cost;
      const recent = fresh.filter((r) => r.ts > now - RECENT_MS);
      bus.publish('records', {
        added: fresh.length, cost, backfill: !recent.length,
        latest: recent.slice(-12).reverse().map((r) => store.present(r)),
      });
    }
    return fresh;
  };

  /** Load the raw-record window in the background; the API is already serving. */
  const hydrate = async () => {
    const t0 = Date.now();
    const since = Date.now() - retentionMs;
    let n = 0;
    for (;;) {
      const rows = await repo.recordsAfter(feed.lastSeq, { sinceTs: since, limit: 10_000 });
      n += ingestRows(rows, { announce: false }).length;
      if (rows.length < 10_000) break;
    }
    for (const b of await repo.latestBalances(6_000)) { store.setBalance(b); feed.lastBalanceTs = b.ts; }
    feed.hydrated = true;
    store.tick(Date.now());
    bus.publish('records', { added: n, cost: 0, backfill: true, latest: [] });
    log.info('store hydrated from postgres', { records: n, ms: Date.now() - t0 });
  };

  const tail = async () => {
    if (!feed.hydrated) return;
    for (;;) {
      const rows = await repo.recordsAfter(feed.lastSeq, { limit: 5_000 });
      ingestRows(rows, { announce: true });
      if (rows.length < 5_000) break;
    }
    const balances = await repo.balancesAfter(feed.lastBalanceTs);
    for (const b of balances) { store.setBalance(b); feed.lastBalanceTs = b.ts; }
    if (balances.length) bus.publish('balance', balances[balances.length - 1]);
    store.evict(Date.now());
    store.tick(Date.now());
  };

  /** Call history: load the copy in pages, then follow changes by synced_at. */
  const hydrateCalls = async () => {
    if (!calls) return;
    const t0 = Date.now();
    const since = Date.now() - config.calls.historyDays * 86_400_000;
    let after = { afterTs: null, afterId: '' };
    for (;;) {
      // Newest first: recent calls (the default 7-day view) are correct within the first page.
      const rows = await repo.loadCalls(since, { ...after, limit: 5_000, newestFirst: true });
      calls.store.upsert(rows);
      if (rows.length < 5_000) break;
      const last = rows[rows.length - 1].data;
      after = { afterTs: last.ts, afterId: last.callId };
    }
    calls.store.hydrated = true;
    log.info('call history hydrated', { calls: calls.store.size, ms: Date.now() - t0 });
  };
  let callsHydrating = null;
  const startCallsHydration = () => {
    if (!calls || calls.store.hydrated || callsHydrating) return callsHydrating;
    callsHydrating = hydrateCalls()
      .catch((err) => log.error('call history hydration failed; retrying', { err: err.message }))
      .finally(() => { callsHydrating = null; });
    return callsHydrating;
  };
  const tailCalls = async () => {
    if (!calls) return;
    if (!calls.store.hydrated) { startCallsHydration(); return; }
    // 10 s overlap: rows committed slightly out of synced_at order are not missed (re-applying is harmless).
    const rows = await repo.callsChangedSince(Math.max(0, calls.store.lastSyncedAt - 10_000));
    calls.store.upsert(rows);
  };

  const refreshMeta = async () => {
    const [groups, assistants] = await Promise.all([repo.getKv('billing_groups'), repo.getKv('assistants')]);
    const g = JSON.stringify(groups ?? []);
    const a = JSON.stringify(assistants ?? []);
    if (g !== feed.groups) { feed.groups = g; store.setGroups(groups ?? []); }
    if (a !== feed.assistants) { feed.assistants = a; store.setAssistants(assistants ?? []); }
  };

  const refreshStatus = async () => {
    const prev = remote.status;
    remote.status = await repo.getKv('sync_status');
    rollups.setStatus(remote.status);
    if (remote.status && remote.status.heartbeatAt !== prev?.heartbeatAt) bus.publish('sync', remote.status.progress);
    if (remote.status?.breaker?.state !== prev?.breaker?.state) bus.publish('breaker', remote.status?.breaker);
  };

  scheduler
    .add({ name: 'api:tail', everyMs: 2_000, jitter: 0, maxBackoffMs: 30_000, run: tail })
    .add({ name: 'api:status', everyMs: 5_000, jitter: 0, run: refreshStatus })
    .add({ name: 'api:meta', everyMs: 30_000, run: refreshMeta })
    .add({ name: 'api:rollups', everyMs: 30_000, run: () => rollups.refresh() })
    .add({ name: 'alerts', everyMs: 15_000, jitter: 0, run: async () => alerts.evaluate() })
    .add({ name: 'api:calls', everyMs: 5_000, jitter: 0, maxBackoffMs: 60_000, run: tailCalls })
    .add({ name: 'api:calls-evict', everyMs: 10 * 60_000, run: async () => calls?.store.evict() })
    .add({ name: 'housekeeping', everyMs: 60_000, run: async () => { limiter.sweep(); await auth.sessions.sweep(); auth.attempts.sweep(); } });

  const app = createHttpApp({
    config, log, auth, limiter,
    routerCtx: {
      config, store, analytics, alerts, sync, scheduler: schedulerView, breaker, flight, cache, limiter, sse, bus,
      provider: { kind: 'telnyx (via sync worker)' }, aiAnalytics, reports, rollups, auth, logger: log.child('routes'),
      calls: calls ? { ...calls, syncInfo: () => remote.status?.calls ?? null } : null,
      automation: { repo: db.automation, workerInfo: () => remote.status?.automation ?? null },
      triggerSync: (by) => repo.requestSync(by, config.worker.syncRequestCooldownMs),
      syncStatus: async () => ({ ...(remote.status?.progress ?? {}), worker: workerSummary(remote.status) }),
      workerStatus: async () => ({ ...workerSummary(remote.status), recentEvents: await repo.recentEvents(10) }),
    },
  });

  const server = listen(app, {
    config, log,
    onListening: async () => {
      log.info('listening', { port: config.port, role: 'api', storage: db.backend });
      await Promise.all([refreshStatus(), refreshMeta(), rollups.refresh()]).catch((err) => log.warn('initial refresh failed', { err: err.message }));
      scheduler.start();
      hydrate().catch((err) => log.error('hydration failed; will retry via tail', { err: err.message })).finally(() => { feed.hydrated = true; });
      startCallsHydration();
      alerts.evaluate();
    },
  });

  onShutdown(async () => {
    scheduler.stop();
    sse.closeAll();
    await new Promise((r) => server.close(r));
    await calls?.source.close().catch(() => {});
    await db.close().catch(() => {});
  }, log);
}
