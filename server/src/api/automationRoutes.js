import crypto from 'node:crypto';
import express from 'express';
import { rateLimit } from './middleware.js';
import { ASSERTION_KINDS, CASE_TYPES, RUN_STATUSES, validateCase, validateSuite } from '../services/automation.js';

/**
 * Call Automation API (mounted at /api/automation, behind login like every /api route).
 *
 *   GET    /meta                  allowed test numbers, types, assertion kinds, limits
 *   GET    /overview?since=ms     totals, today's pass/fail, recent failures, per-suite status
 *   GET    /suites                POST /suites      PUT|DELETE /suites/:id
 *   GET    /cases?suiteId=        POST /cases       GET|PUT|DELETE /cases/:id
 *   POST   /runs  { caseIds }     queue one run per case (shared batchId); the worker executes
 *   GET    /runs?caseId&batchId&status&beforeId&limit
 *   GET    /runs/:id              run detail with assertion results
 *   POST   /runs/:id/cancel
 *
 * The API never executes a run: it only queues. Safety rules (allow-listed test
 * numbers, bounded timeouts, path-only API requests) live in services/automation.js
 * and are re-checked when a run is queued, in case the allow-list changed.
 */
const DAY = 86_400_000;

const notFound = () => Object.assign(new Error('not_found'), { status: 404 });
const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });

function idParam(v) {
  if (!/^[1-9]\d{0,15}$/.test(String(v))) throw notFound();
  return Number(v);
}

function optInt(v, field) {
  if (v === undefined || v === '') return null;
  if (!/^[1-9]\d{0,15}$/.test(String(v))) throw badRequest(`${field} must be a positive integer`);
  return Number(v);
}

/** Wrap async handlers so rejections reach the error handler. */
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function buildAutomationRouter({ automation, config, limiter, logger }) {
  const r = express.Router();
  const json = express.json({ limit: '64kb' });

  if (!automation) {
    // No database (local in-memory mode): the page explains instead of failing.
    r.get('/meta', (req, res) => res.json({ enabled: false, reason: 'Call Automation needs a database (DATABASE_URL or LIBSQL_URL).' }));
    r.use((req, res) => res.status(404).json({ error: 'not_found', enabled: false }));
    return r;
  }

  const repo = automation.repo;
  const cfg = config.automation;
  const rules = { testNumbers: cfg.testNumbers, defaultTimeoutSec: cfg.defaultTimeoutSec, maxTimeoutSec: cfg.maxTimeoutSec };
  const allowed = new Set(cfg.testNumbers.map((n) => n.number));
  const who = (req) => req.user?.email ?? null;
  // A case saved under an older allow-list may now point at a number that is no longer allowed.
  const present = (c) => (c ? { ...c, targetAllowed: c.targetNumber === null || allowed.has(c.targetNumber) } : c);

  r.get('/meta', (req, res) => res.json({
    enabled: true,
    testNumbers: cfg.testNumbers,
    caseTypes: CASE_TYPES,
    runStatuses: RUN_STATUSES,
    assertionKinds: Object.entries(ASSERTION_KINDS).map(([kind, d]) => ({ kind, group: d.group, on: d.on })),
    limits: { defaultTimeoutSec: cfg.defaultTimeoutSec, maxTimeoutSec: cfg.maxTimeoutSec, maxRunsPerRequest: cfg.maxRunsPerRequest },
    worker: automation.workerInfo?.() ?? null,
  }));

  r.get('/overview', h(async (req, res) => {
    const now = Date.now();
    // `since` = the viewer's local midnight (sent by the UI); default the last 24 h, never more than 90 days.
    const since = Math.max(now - 90 * DAY, Math.min(now, optInt(req.query.since, 'since') ?? now - DAY));
    res.json(await repo.overview({ since }));
  }));

  // ---- suites ---------------------------------------------------------------
  r.get('/suites', h(async (req, res) => res.json({ items: await repo.listSuites() })));

  r.post('/suites', json, h(async (req, res) => {
    const suite = await repo.createSuite(validateSuite(req.body));
    logger?.info('automation suite created', { id: suite.id, by: who(req) });
    res.status(201).json(suite);
  }));

  r.put('/suites/:id', json, h(async (req, res) => {
    const suite = await repo.updateSuite(idParam(req.params.id), validateSuite(req.body));
    if (!suite) throw notFound();
    res.json(suite);
  }));

  r.delete('/suites/:id', h(async (req, res) => {
    if (!(await repo.deleteSuite(idParam(req.params.id)))) throw notFound();
    logger?.info('automation suite deleted', { id: Number(req.params.id), by: who(req) });
    res.status(204).end();
  }));

  // ---- cases ----------------------------------------------------------------
  r.get('/cases', h(async (req, res) => {
    const items = await repo.listCases({ suiteId: optInt(req.query.suiteId, 'suiteId') });
    res.json({ items: items.map(present) });
  }));

  r.get('/cases/:id', h(async (req, res) => {
    const c = await repo.getCase(idParam(req.params.id));
    if (!c) throw notFound();
    res.json(present(c));
  }));

  r.post('/cases', json, h(async (req, res) => {
    const c = await repo.createCase(validateCase(req.body, rules), who(req));
    logger?.info('automation case created', { id: c.id, type: c.type, by: who(req) });
    res.status(201).json(present(c));
  }));

  r.put('/cases/:id', json, h(async (req, res) => {
    const id = idParam(req.params.id);
    const version = req.body?.version === undefined ? null : optInt(req.body.version, 'version');
    try {
      const c = await repo.updateCase(id, validateCase(req.body, rules), { version, by: who(req) });
      if (!c) throw notFound();
      logger?.info('automation case updated', { id, version: c.version, by: who(req) });
      res.json(present(c));
    } catch (err) {
      if (err.currentVersion !== undefined) return res.status(409).json({ error: err.message, currentVersion: err.currentVersion });
      throw err;
    }
  }));

  r.delete('/cases/:id', h(async (req, res) => {
    if (!(await repo.deleteCase(idParam(req.params.id)))) throw notFound();
    logger?.info('automation case deleted', { id: Number(req.params.id), by: who(req) });
    res.status(204).end();
  }));

  // ---- runs -----------------------------------------------------------------
  // Queuing places real calls later: charge 5 rate-limit tokens.
  r.post('/runs', rateLimit(limiter, 5), json, h(async (req, res) => {
    const raw = req.body?.caseIds;
    if (!Array.isArray(raw) || !raw.length) throw badRequest('caseIds must be a non-empty array');
    if (raw.length > cfg.maxRunsPerRequest) throw badRequest(`at most ${cfg.maxRunsPerRequest} tests per run`);
    const ids = [...new Set(raw.map((v) => optInt(v, 'caseIds[]')))];

    const cases = await repo.getCases(ids);
    const byId = new Map(cases.map((c) => [c.id, c]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) return res.status(404).json({ error: 'some tests do not exist', missing });

    const entries = [];
    for (const id of ids) {
      const c = byId.get(id);
      if (!c.enabled) throw badRequest(`"${c.name}" is disabled`);
      // Re-check against today's rules: the allow-list or limits may have changed since it was saved.
      let checked;
      try { checked = validateCase(c, rules); } catch (err) { throw badRequest(`"${c.name}": ${err.message}`); }
      entries.push({ caseId: id, snapshot: { ...checked, id, version: c.version, suiteName: c.suiteName } });
    }

    const active = await repo.countActiveRuns();
    if (active + entries.length > cfg.maxActiveRuns) {
      return res.status(429).json({ error: `too many runs waiting (${active}); try again when some finish`, active, limit: cfg.maxActiveRuns });
    }

    const batchId = crypto.randomUUID();
    const runs = await repo.queueRuns(entries, { batchId, by: who(req) });
    logger?.info('automation runs queued', { batchId, cases: ids, by: who(req) });
    res.status(202).json({ batchId, runs });
  }));

  r.get('/runs', h(async (req, res) => {
    const status = req.query.status || null;
    if (status && !RUN_STATUSES.includes(status)) throw badRequest(`status must be one of ${RUN_STATUSES.join(', ')}`);
    const batchId = req.query.batchId ? String(req.query.batchId).slice(0, 64) : null;
    const limit = Math.min(100, optInt(req.query.limit, 'limit') ?? 50);
    const items = await repo.listRuns({
      caseId: optInt(req.query.caseId, 'caseId'), batchId, status, beforeId: optInt(req.query.beforeId, 'beforeId'), limit,
    });
    res.json({ items, nextBeforeId: items.length === limit ? items[items.length - 1].id : null });
  }));

  r.get('/runs/:id', h(async (req, res) => {
    const run = await repo.getRun(idParam(req.params.id));
    if (!run) throw notFound();
    res.json(run);
  }));

  r.post('/runs/:id/cancel', h(async (req, res) => {
    const { run, cancelled } = await repo.cancelRun(idParam(req.params.id), { by: who(req) });
    if (!run) throw notFound();
    if (!cancelled) return res.status(409).json({ error: `run is already ${run.status}`, run });
    logger?.info('automation run cancelled', { id: run.id, by: who(req) });
    res.json(run);
  }));

  return r;
}
