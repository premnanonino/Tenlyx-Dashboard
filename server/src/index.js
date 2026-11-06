import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

import { config } from './config.js';
import { createLogger } from './core/logger.js';
import { EventBus } from './core/eventBus.js';
import { LRUCache } from './dsa/LRUCache.js';
import { TokenBucketLimiter, PacedBucket } from './dsa/TokenBucket.js';
import { CircuitBreaker } from './infra/circuitBreaker.js';
import { SingleFlight } from './infra/singleFlight.js';
import { Scheduler } from './infra/scheduler.js';
import { TelnyxClient } from './providers/telnyxClient.js';
import { BillingStore } from './services/billingStore.js';
import { BillingSync } from './services/billingSync.js';
import { Analytics } from './services/analytics.js';
import { AlertEngine } from './services/alertEngine.js';
import { AiAnalytics } from './services/aiAnalytics.js';
import { MonthlyRollups } from './services/monthlyRollups.js';
import { Reports } from './services/reports.js';
import { SseHub } from './api/sseHub.js';
import { buildRouter } from './api/routes.js';
import { requestContext, rateLimit, notFound, errorHandler, securityHeaders } from './api/middleware.js';
import { createAuth } from './auth/auth.js';

// ---------------------------------------------------------------------------
// Composition root: every dependency is constructed here and injected.
// Nothing below reaches for a global, which keeps each piece testable alone.
// ---------------------------------------------------------------------------
const log = createLogger('tlxmon');

// Fail closed: never serve billing data without a configured login.
if (!config.auth.email || !config.auth.passwordHash.startsWith('scrypt$')) {
  log.error('login not configured', { fix: 'run: npm --prefix server run set-password -- you@example.com' });
  process.exit(1);
}
// Fail closed: there is no demo mode; without a key there is nothing to show.
if (!config.telnyx.apiKey) {
  log.error('TELNYX_API_KEY not set', { fix: 'add TELNYX_API_KEY=<v2 key> to .env (Mission Control → Auth → API Keys)' });
  process.exit(1);
}
const auth = createAuth({ config, logger: log.child('auth') });
const bus = new EventBus();

const provider = new TelnyxClient({ config, pacer: new PacedBucket({ ratePerSec: config.telnyx.outboundRps, burst: config.telnyx.outboundRps }), logger: log.child('telnyx') });

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
  .add({ name: 'history', everyMs: 5 * 60_000, run: () => sync.backfillHistory() }) // resumes if interrupted
  .add({ name: 'rollup-flush', everyMs: config.reports.flushMs, jitter: 0, run: async () => rollups.flush() })
  .add({ name: 'housekeeping', everyMs: 60_000, run: async () => { limiter.sweep(); auth.sessions.sweep(); auth.attempts.sweep(); } });

// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(securityHeaders({ hsts: config.auth.secureCookie }));
app.use(requestContext(log.child('http')));
app.use('/api', auth.sameOrigin, rateLimit(limiter), auth.router, auth.requireAuth, buildRouter({
  config, store, analytics, alerts, sync, scheduler, breaker, flight, cache, limiter, sse, bus, provider, aiAnalytics, reports, rollups, auth,
}));

// Serve the built frontend when present (single-process production deploy).
const dist = path.resolve(config.serverRoot, '..', 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { maxAge: '1h', index: false }));
  // Client routes get the SPA shell with 200; anything else still gets the
  // shell (it renders the 404 page) but with a real 404 status for crawlers,
  // monitors and logs.
  const CLIENT_ROUTE = /^\/(?:login|dashboard(?:\/(?:ai|reports(?:\/\d{4}-\d{2})?))?)?\/?$/;
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    res.status(CLIENT_ROUTE.test(req.path) ? 200 : 404).sendFile(path.join(dist, 'index.html'));
  });
}
app.use(notFound);
app.use(errorHandler(log));

const server = app.listen(config.port, async () => {
  log.info('listening', { port: config.port, mode: config.mode, provider: provider.kind });
  await sync.bootstrap();
  alerts.evaluate();
  scheduler.start();
  rollups.flush();
  // Fill report history in the background; the API is already serving.
  sync.backfillHistory().catch((err) => log.warn('history backfill paused', { err: err.message }));
});

function shutdown(signal) {
  log.info('shutting down', { signal });
  scheduler.stop();
  sse.closeAll();
  try { rollups.flush(); } catch (err) { log.error('rollup flush failed', { err: err.message }); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
