import { createLogger } from '../core/logger.js';
import { EventBus } from '../core/eventBus.js';
import { LRUCache } from '../dsa/LRUCache.js';
import { TokenBucketLimiter } from '../dsa/TokenBucket.js';
import { AdaptivePacer } from '../infra/adaptivePacer.js';
import { CircuitBreaker } from '../infra/circuitBreaker.js';
import { SingleFlight } from '../infra/singleFlight.js';
import { Scheduler } from '../infra/scheduler.js';
import { TelnyxClient } from '../providers/telnyxClient.js';
import { BillingStore } from '../services/billingStore.js';
import { BillingSync } from '../services/billingSync.js';
import { Analytics } from '../services/analytics.js';
import { AlertEngine } from '../services/alertEngine.js';
import { AiAnalytics } from '../services/aiAnalytics.js';
import { MonthlyRollups } from '../services/monthlyRollups.js';
import { Reports } from '../services/reports.js';
import { SseHub } from '../api/sseHub.js';
import { createAuth } from '../auth/auth.js';
import { createHttpApp, listen, onShutdown, requireLoginConfig, requireTelnyxKey } from '../http.js';

/**
 * Local development: API + Telnyx sync in one process, data in memory,
 * monthly rollups in server/data/rollups.json. No database needed.
 */
export async function start(config) {
  const log = createLogger('tlxmon');
  requireLoginConfig(config, log);
  requireTelnyxKey(config, log);

  const auth = createAuth({ config, logger: log.child('auth') });
  const bus = new EventBus();

  const pacer = new AdaptivePacer({ startRps: Math.min(1, config.telnyx.outboundRps), maxRps: config.telnyx.outboundRps });
  const provider = new TelnyxClient({ config, pacer, logger: log.child('telnyx') });

  const store = new BillingStore({ retentionMs: config.retentionDays * 86_400_000 });
  const analytics = new Analytics({ store });
  const aiAnalytics = new AiAnalytics({ store });
  const rollups = new MonthlyRollups({ file: config.reports.file, logger: log.child('rollups') });
  rollups.load();
  const reports = new Reports({ rollups, store });
  const cache = new LRUCache(config.cache);
  const limiter = new TokenBucketLimiter(config.rateLimit);
  const flight = new SingleFlight();
  const breaker = new CircuitBreaker({
    name: 'telnyx',
    onChange: (e) => { log.warn('breaker transition', e); bus.publish('breaker', e); },
  });
  const scheduler = new Scheduler({ logger: log.child('scheduler') });
  const sync = new BillingSync({ provider, store, breaker, flight, bus, logger: log.child('sync'), config, rollups });
  const alerts = new AlertEngine({ store, analytics, bus, scheduler, breaker, config });
  const sse = new SseHub({ bus, logger: log.child('sse') });

  // Re-evaluate alert rules as soon as fresh data lands (not only on the timer).
  bus.on('balance', () => alerts.evaluate());
  bus.on('breaker', () => alerts.evaluate());

  scheduler
    .add({ name: 'records', everyMs: config.poll.recordsMs, run: () => sync.syncRecords() })
    .add({ name: 'balance', everyMs: config.poll.balanceMs, run: () => sync.syncBalance() })
    .add({ name: 'groups', everyMs: config.poll.groupsMs, run: () => sync.syncGroups() })
    .add({ name: 'alerts', everyMs: 15_000, jitter: 0, run: async () => alerts.evaluate() })
    .add({ name: 'assistants', everyMs: config.poll.groupsMs, run: () => sync.syncAssistants() })
    // Batch lanes: each run is one small chunk; the shared pacer keeps the pace.
    .add({ name: 'backfill', everyMs: 500, jitter: 0, maxBackoffMs: 60_000, run: () => sync.backfillStep() })
    .add({ name: 'history', everyMs: 2_000, jitter: 0, maxBackoffMs: 5 * 60_000, run: () => sync.historyStep() })
    .add({ name: 'rollup-flush', everyMs: config.reports.flushMs, jitter: 0, run: async () => rollups.flush() })
    .add({ name: 'housekeeping', everyMs: 60_000, run: async () => { limiter.sweep(); auth.sessions.sweep(); auth.attempts.sweep(); } });

  const app = createHttpApp({
    config, log, auth, limiter,
    routerCtx: {
      config, store, analytics, alerts, sync, scheduler, breaker, flight, cache, limiter, sse, bus, provider, aiAnalytics, reports, rollups, auth,
      logger: log.child('api'),
      // Manual refresh runs in the background (it may have to wait out a rate limit).
      triggerSync: async () => {
        Promise.all([sync.syncRecords(), sync.syncBalance()])
          .then(() => alerts.evaluate())
          .catch((err) => log.warn('manual sync failed', { err: err.message }));
        return { queued: true, throttledForMs: pacer.coolingDownMs() };
      },
    },
  });

  const server = listen(app, {
    config, log,
    onListening: async () => {
      log.info('listening', { port: config.port, role: 'standalone', storage: 'memory', provider: provider.kind });
      await sync.bootstrap();
      alerts.evaluate();
      scheduler.start();
      rollups.flush();
    },
  });

  onShutdown(async () => {
    scheduler.stop();
    sse.closeAll();
    try { rollups.flush(); } catch (err) { log.error('rollup flush failed', { err: err.message }); }
    await new Promise((r) => server.close(r));
  }, log);
}
