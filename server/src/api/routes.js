import express from 'express';
import { cached, rateLimit } from './middleware.js';
import { parseWindow } from '../services/analytics.js';
import { csvCell } from '../core/csv.js';

const clampInt = (v, lo, hi, d) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });

export function buildRouter(ctx) {
  const { config, store, analytics, alerts, sync, scheduler, breaker, flight, cache, limiter, sse, bus, aiAnalytics, reports, rollups } = ctx;
  const r = express.Router();
  const memo = cached(cache, store);
  const startedAt = Date.now();

  // ---- probes -----------------------------------------------------------
  r.get('/health', (req, res) => res.json({ ok: true, uptimeS: Math.round(process.uptime()) }));
  r.get('/ready', (req, res) => {
    const ready = store.balance !== null;
    res.status(ready ? 200 : 503).json({ ready });
  });

  // ---- billing reads (cached) ------------------------------------------
  r.get('/overview', memo(() => ({ mode: config.mode, ...analytics.overview() })));

  r.get('/spend/series', memo((req) => analytics.spendSeries(parseWindow(req.query))));

  r.get('/spend/products', memo((req) => analytics.productSplit(parseWindow(req.query))));

  r.get('/spend/heatmap', memo((req) => analytics.heatmap(parseWindow({ range: '7d', ...req.query }))));

  r.get('/spend/pace', memo(() => reports.pace()));

  r.get('/top', memo((req) => {
    const w = parseWindow(req.query);
    const by = req.query.by || 'destination';
    const k = clampInt(req.query.k, 1, 50, 8);
    return { by, k, range: w.key, from: w.from, to: w.to, ...store.top(by, k, w.from, w.to) };
  }));

  r.get('/balance/history', memo((req) => analytics.balanceHistory(parseWindow(req.query))));

  r.get('/billing-groups', memo(() => ({
    items: [...store.groups.values()].map((g) => ({ ...g })),
  })));

  const recordFilters = (req) => ({
    q: String(req.query.q || '').slice(0, 64),
    product: req.query.product || undefined,
    country: req.query.country ? String(req.query.country).toUpperCase() : undefined,
    direction: req.query.direction || undefined,
  });

  /**
   * Filtered ledger as CSV. Streams rows straight from the store's
   * generator in chunks and honours socket back-pressure (waits for
   * 'drain'), so a 200k-row export never sits in memory.
   */
  r.get('/records/export.csv', rateLimit(limiter, 5), async (req, res, next) => {
    try {
      const w = parseWindow(req.query);
      const f = recordFilters(req);
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');
      res.type('text/csv').attachment(`tlxmon-ledger-${stamp}.csv`);
      const esc = csvCell;
      res.write('time_utc,id,product,direction,destination,country,billing_group,units,unit,rate,cost,currency,status,ai_model,ai_assistant,ai_outcome\n');
      let buf = [];
      let n = 0;
      for (const rec of store.scan({ from: w.from, to: w.to, ...f })) {
        buf.push([new Date(rec.ts).toISOString(), rec.id, rec.product, rec.direction, rec.destination, rec.country,
          store.groupName(rec.billingGroupId), rec.units, rec.unitLabel, rec.rate, rec.cost, rec.currency, rec.status,
          rec.ai?.model, rec.ai ? store.assistantName(rec.ai.assistantId) : '', rec.ai?.outcome].map(esc).join(','));
        if (++n >= 200_000) break;
        if (buf.length === 1000) {
          if (!res.write(`${buf.join('\n')}\n`)) await new Promise((ok) => res.once('drain', ok));
          buf = [];
          if (res.destroyed) return;
        }
      }
      if (buf.length) res.write(`${buf.join('\n')}\n`);
      res.end();
    } catch (err) {
      if (res.headersSent) res.destroy(err); else next(err);
    }
  });

  r.get('/records', memo((req) => {
    const w = parseWindow(req.query);
    const before = req.query.before ? Number(req.query.before) : undefined;
    if (before !== undefined && !Number.isFinite(before)) throw badRequest('before must be a timestamp');
    const t0 = performance.now();
    const result = store.query({
      from: w.from,
      to: w.to,
      ...recordFilters(req),
      limit: clampInt(req.query.limit, 1, 500, 100),
      before,
    });
    return { ...result, tookMs: +(performance.now() - t0).toFixed(2) };
  }));

  r.get('/search/suggest', (req, res) => {
    res.json({ items: store.suggest(String(req.query.q || '').slice(0, 32), clampInt(req.query.limit, 1, 20, 8)) });
  });

  // ---- conversational AI ----------------------------------------------
  r.get('/ai/overview', memo((req) => aiAnalytics.overview(parseWindow(req.query))));

  // ---- monthly reports (from durable rollups, not the 35-day log) ------
  r.get('/reports', (req, res) => res.json(reports.list()));
  r.get('/reports/summary.csv', (req, res) => {
    res.type('text/csv').attachment('tlxmon-monthly-summary.csv').send(reports.summaryCsv());
  });
  r.get('/reports/:month', (req, res) => res.json(reports.build(req.params.month)));
  r.get('/reports/:month/csv', (req, res) => {
    const csv = reports.csv(req.params.month);
    res.type('text/csv').attachment(`tlxmon-statement-${req.params.month}.csv`).send(csv);
  });

  // ---- alerts -----------------------------------------------------------
  r.get('/alerts', (req, res) => res.json(alerts.list()));
  r.put('/alerts/thresholds', express.json({ limit: '4kb' }), (req, res) => {
    res.json({ thresholds: alerts.setThresholds(req.body || {}) });
  });

  // ---- operations -------------------------------------------------------
  // Manual refresh is expensive upstream: charge 10 tokens.
  // Manual refresh runs in the background (it may have to wait out a
  // Telnyx rate limit); progress arrives over the live stream.
  r.post('/sync', rateLimit(limiter, 10), (req, res) => {
    const throttledForMs = ctx.provider.pacer?.coolingDownMs?.() ?? 0;
    Promise.all([sync.syncRecords(), sync.syncBalance()])
      .then(() => alerts.evaluate())
      .catch((err) => ctx.logger?.warn('manual sync failed', { err: err.message }));
    res.status(202).json({ ok: true, queued: true, throttledForMs });
  });

  r.get('/sync/status', (req, res) => res.json(sync.progress()));

  r.get('/system', (req, res) => {
    const mem = process.memoryUsage();
    res.json({
      mode: config.mode,
      provider: ctx.provider.kind,
      startedAt,
      uptimeS: Math.round(process.uptime()),
      memoryMb: { rss: +(mem.rss / 1e6).toFixed(1), heap: +(mem.heapUsed / 1e6).toFixed(1) },
      store: {
        records: store.records.length,
        oldestTs: store.oldestTs,
        newestTs: store.newestTs,
        trieTokens: store.trie.tokens,
        products: store.products,
        version: store.version,
        ...store.stats,
      },
      jobs: scheduler.stats(),
      breaker: breaker.stats(),
      cache: cache.stats(),
      singleFlight: flight.stats(),
      rateLimiter: limiter.stats(),
      sse: sse.stats(),
      bus: bus.stats(),
      sync: sync.stats(),
      auth: { sessions: ctx.auth.sessions.sessions.size, loginRejected: ctx.auth.attempts.rejected },
      rollups: { months: rollups.months.size, highWater: rollups.meta.highWater, backfill: rollups.backfill, aiRecords: store.aiRecords.length },
    });
  });

  // ---- live stream ------------------------------------------------------
  r.get('/stream', (req, res) => {
    sse.handle(req, res, { mode: config.mode, version: store.version, ts: Date.now() });
  });

  return r;
}
