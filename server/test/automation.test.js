/**
 * Call Automation: validation rules, storage, the worker's runner, and the HTTP API.
 * Storage, runner and API tests run on libSQL (a local file) and, when
 * TEST_DATABASE_URL names a *test* PostgreSQL database, on PostgreSQL too
 * (its automation tables are truncated). No network, no Telnyx.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { connect, migrate } from '../src/db/libsql.js';
import { connect as pgConnect, migrate as pgMigrate } from '../src/db/pg.js';
import { LibsqlAutomationRepo } from '../src/persistence/libsqlAutomationRepo.js';
import { PgAutomationRepo } from '../src/persistence/pgAutomationRepo.js';
import { AutomationRunner } from '../src/services/automationRunner.js';
import { buildAutomationRouter } from '../src/api/automationRoutes.js';
import { normalizeE164, parseTestNumbers, validateCase, validateResult, validateSuite } from '../src/services/automation.js';

const TEST_NUMBER = '+16312969723';
const rules = { testNumbers: [{ number: TEST_NUMBER, label: 'Dev V2', kind: 'test' }], defaultTimeoutSec: 300, maxTimeoutSec: 900 };

const phoneCase = (over = {}) => ({
  name: 'Basic Booking',
  type: 'PHONE',
  courseName: 'Black Gold Golf Club',
  targetNumber: TEST_NUMBER,
  steps: [{ say: 'I want to book a tee time.', expect: 'CourseRev asks for date' }, { say: 'November 18th.' }],
  assertions: [
    { kind: 'agent_says', label: 'asks for date', pattern: 'what date', afterStep: 1 },
    { kind: 'tool_called', tool: 'booking', expected: false, label: 'booking endpoint must NOT be called' },
  ],
  ...over,
});

const apiCase = (over = {}) => ({
  name: 'Router availability',
  type: 'API',
  request: { method: 'POST', path: '/v2/tool-calls/router', body: { courseId: 243, players: 2, holes: 18 } },
  assertions: [{ kind: 'response_status', equals: 200 }, { kind: 'json_equals', path: 'data.canProceed', equals: true }],
  ...over,
});

// ---- backends ------------------------------------------------------------------
const pgUrl = process.env.TEST_DATABASE_URL;
const pgSafe = !!pgUrl && /test/i.test(new URL(pgUrl).pathname);
let pgPool = null;
after(async () => { await pgPool?.end(); });

const BACKENDS = [
  {
    name: 'libsql',
    async fresh(t) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlxmon-automation-'));
      const client = await connect({ url: `file:${path.join(dir, 'test.db')}` }, { attempts: 1 });
      await migrate(client);
      t.after(() => { client.close(); fs.rmSync(dir, { recursive: true, force: true }); });
      return new LibsqlAutomationRepo({ client });
    },
    setTarget: (repo, id, number) => repo.client.execute({ sql: 'UPDATE automation_cases SET target_number = ? WHERE id = ?', args: [number, id] }),
  },
  {
    name: 'postgres',
    skip: !pgSafe && 'set TEST_DATABASE_URL to a *test* database',
    async fresh() {
      if (!pgPool) {
        pgPool = await pgConnect({ connectionString: pgUrl, max: 3 }, { attempts: 1 });
        await pgMigrate(pgPool);
        await pgMigrate(pgPool); // idempotent
      }
      await pgPool.query('TRUNCATE automation_suites, automation_cases, automation_runs, automation_run_assertions RESTART IDENTITY');
      return new PgAutomationRepo({ pool: pgPool });
    },
    setTarget: (repo, id, number) => repo.pool.query('UPDATE automation_cases SET target_number = $1 WHERE id = $2', [number, id]),
  },
];
let backend = BACKENDS[0];
const freshRepo = (t) => backend.fresh(t);

/** Register a test once per backend (tests in a file run one at a time). */
function each(name, fn) {
  for (const b of BACKENDS) {
    test(`[${b.name}] ${name}`, { skip: b.skip }, async (t) => { backend = b; await fn(t); });
  }
}

/** Queue one run of a fresh case; returns { repo, c, run }. */
async function queued(t, caseBody = phoneCase(), repo = null) {
  repo ??= await freshRepo(t);
  const c = await repo.createCase(validateCase(caseBody, rules), 'qa@courserev.ai');
  const [run] = await repo.queueRuns([{ caseId: c.id, snapshot: { ...validateCase(c, rules), id: c.id, version: c.version } }], { batchId: 'b1', by: 'qa@courserev.ai' });
  return { repo, c, run };
}

// ---- validation -------------------------------------------------------------
test('automation: test numbers are parsed, normalised and de-duplicated', () => {
  const { numbers, invalid } = parseTestNumbers('+1 (631) 296-9723=Dev V2, +16312969723, 12345, +18392741964');
  assert.deepEqual(numbers.map((n) => [n.number, n.label]), [[TEST_NUMBER, 'Dev V2'], ['+18392741964', null]]);
  assert.deepEqual(invalid, ['12345']);
  assert.equal(normalizeE164('6312969723'), null, 'a number without + and country code is rejected');
});

test('automation: a phone test may only dial an allow-listed test number', () => {
  assert.equal(validateCase(phoneCase(), rules).targetNumber, TEST_NUMBER);
  assert.throws(() => validateCase(phoneCase({ targetNumber: '+14155550100' }), rules), /not a configured test number/);
  assert.throws(() => validateCase(phoneCase({ targetNumber: undefined }), rules), /targetNumber/);
  assert.throws(() => validateCase(apiCase({ targetNumber: TEST_NUMBER }), rules), /do not dial/);
});

test('automation: API tests carry a path only, never a host', () => {
  for (const p of ['https://evil.example/x', '//evil.example/x', 'v2/router', '/a b', 'javascript:alert(1)']) {
    assert.throws(() => validateCase(apiCase({ request: { method: 'POST', path: p } }), rules), /request.path/, p);
  }
  assert.throws(() => validateCase(apiCase({ request: { method: 'GET', path: '/x', body: { a: 1 } } }), rules), /body is not allowed/);
  assert.equal(validateCase(apiCase(), rules).request.path, '/v2/tool-calls/router');
});

test('automation: steps, assertions and timeouts are checked per test type', () => {
  assert.throws(() => validateCase(phoneCase({ steps: [] }), rules), /at least one step/);
  assert.throws(() => validateCase(apiCase({ steps: [{ say: 'hi' }] }), rules), /no conversation steps/);
  assert.throws(() => validateCase(apiCase({ assertions: [{ kind: 'agent_says', pattern: 'x' }] }), rules), /not available for API/);
  assert.throws(() => validateCase(phoneCase({ assertions: [{ kind: 'nope' }] }), rules), /kind must be one of/);
  assert.throws(() => validateCase(phoneCase({ assertions: [{ kind: 'agent_says', pattern: '/(/' }] }), rules), /regular expression/);
  assert.throws(() => validateCase(phoneCase({ assertions: [{ kind: 'booking_field', field: 'price', equals: 1 }] }), rules), /field must be one of/);
  assert.throws(() => validateCase(phoneCase({ timeoutSec: 5 }), rules), /timeoutSec/);
  assert.throws(() => validateCase(phoneCase({ timeoutSec: 901 }), rules), /timeoutSec/);
  assert.equal(validateCase(phoneCase(), rules).timeoutSec, 300, 'default timeout');
  const neg = validateCase(phoneCase(), rules).assertions[1];
  assert.deepEqual(neg, { kind: 'tool_called', label: 'booking endpoint must NOT be called', tool: 'booking', expected: false });
});

test('automation: executor results are validated before they are stored', () => {
  assert.throws(() => validateResult({ status: 'timeout' }), /must be one of/);
  assert.throws(() => validateResult({ status: 'cancelled' }), /must be one of/);
  const r = validateResult({ status: 'passed', assertions: [{ kind: 'x', passed: 1, expected: 2 }] });
  assert.deepEqual(r.assertions[0], { idx: 0, kind: 'x', label: 'x', passed: true, expected: 2, actual: null, detail: null });
});

// ---- storage ----------------------------------------------------------------
test('automation: PostgreSQL and libSQL repositories expose the same methods', () => {
  const methods = (cls) => Object.getOwnPropertyNames(cls.prototype).filter((m) => m !== 'constructor').sort();
  assert.deepEqual(methods(LibsqlAutomationRepo), methods(PgAutomationRepo));
});

each('automation: suites — create, rename, duplicate names, delete unassigns cases', async (t) => {
  const repo = await freshRepo(t);
  const s = await repo.createSuite(validateSuite({ name: 'Booking', description: 'tee times' }));
  await assert.rejects(repo.createSuite({ name: 'Booking', description: null }), (e) => e.status === 409);
  const c = await repo.createCase(validateCase(phoneCase({ suiteId: s.id }), rules), 'qa@courserev.ai');
  assert.equal(c.suiteName, 'Booking');
  assert.equal((await repo.listSuites())[0].caseCount, 1);
  await assert.rejects(repo.createCase(validateCase(phoneCase({ suiteId: 999 }), rules)), (e) => e.status === 400);
  assert.equal(await repo.deleteSuite(s.id), true);
  assert.equal((await repo.getCase(c.id)).suiteId, null, 'the case is kept, unassigned');
});

each('automation: cases — JSON round trip and optimistic version check', async (t) => {
  const repo = await freshRepo(t);
  const c = await repo.createCase(validateCase(phoneCase(), rules), 'qa@courserev.ai');
  assert.equal(c.version, 1);
  assert.deepEqual(c.steps[0], { say: 'I want to book a tee time.', expect: 'CourseRev asks for date' });
  assert.equal(c.enabled, true);
  assert.equal(c.updatedBy, 'qa@courserev.ai');

  const v2 = await repo.updateCase(c.id, validateCase(phoneCase({ name: 'Renamed', enabled: false }), rules), { version: 1, by: 'b@courserev.ai' });
  assert.equal(v2.version, 2);
  assert.equal(v2.enabled, false);
  await assert.rejects(
    repo.updateCase(c.id, validateCase(phoneCase(), rules), { version: 1 }),
    (e) => e.status === 409 && e.currentVersion === 2,
  );
  assert.equal(await repo.updateCase(999, validateCase(phoneCase(), rules)), null);
});

each('automation: runs — queue, claim with deadline, finish with assertions', async (t) => {
  const { repo, c, run } = await queued(t);
  assert.equal(run.status, 'queued');
  assert.equal(run.caseName, 'Basic Booking');
  assert.equal(await repo.countActiveRuns(), 1);

  const now = Date.now();
  const claimed = await repo.claimNextRun(now);
  assert.equal(claimed.id, run.id);
  assert.equal(claimed.status, 'running');
  assert.equal(claimed.deadlineAt, now + 300_000);
  assert.equal(claimed.case.targetNumber, TEST_NUMBER);
  assert.equal(await repo.claimNextRun(now), null, 'a run is claimed once');

  const stored = await repo.finishRun(run.id, validateResult({
    status: 'failed', courserevCallId: 'abc-123', artifacts: { transcript: [] },
    assertions: [{ kind: 'agent_says', label: 'asks for date', passed: true }, { kind: 'tool_called', label: 'no booking', passed: false, actual: true }],
  }), now + 42_000);
  assert.equal(stored, true);
  const detail = await repo.getRun(run.id);
  assert.equal(detail.status, 'failed');
  assert.equal(detail.durationMs, 42_000);
  assert.equal(detail.courserevCallId, 'abc-123');
  assert.equal(detail.assertionsPassed, 1);
  assert.equal(detail.assertionsTotal, 2);
  assert.equal(detail.assertions[1].actual, true);
  assert.equal(detail.case.name, 'Basic Booking');

  // The case can change; the run keeps what was executed.
  await repo.updateCase(c.id, validateCase(phoneCase({ name: 'Edited later' }), rules));
  assert.equal((await repo.getRun(run.id)).caseName, 'Basic Booking');
  assert.equal((await repo.getCase(c.id)).lastRun.status, 'failed');
});

each('automation: a cancelled or timed-out run is never overwritten by a late result', async (t) => {
  const { repo, run } = await queued(t);
  await repo.claimNextRun(Date.now());
  const { cancelled } = await repo.cancelRun(run.id, { by: 'qa@courserev.ai' });
  assert.equal(cancelled, true);
  assert.equal(await repo.finishRun(run.id, validateResult({ status: 'passed' })), false);
  const r = await repo.getRun(run.id);
  assert.equal(r.status, 'cancelled');
  assert.match(r.error, /cancelled by qa@courserev.ai/);
  assert.equal((await repo.cancelRun(run.id)).cancelled, false, 'already finished');
});

each('automation: stuck runs time out; runs nobody picks up are abandoned', async (t) => {
  const repo = await freshRepo(t);
  const a = await queued(t, phoneCase({ timeoutSec: 10 }), repo);
  const t0 = Date.now();
  await repo.claimNextRun(t0);
  const b = await queued(t, phoneCase(), repo);
  const res = await repo.expireRuns({ now: t0 + 11_000, queuedBefore: t0 + 11_000 });
  assert.deepEqual(res, { timedOut: [a.run.id], abandoned: [b.run.id] });
  assert.equal((await repo.getRun(a.run.id)).status, 'timeout');
  assert.equal((await repo.getRun(b.run.id)).status, 'error');
});

each('automation: overview counts today, success rate, failures and suite status', async (t) => {
  const repo = await freshRepo(t);
  const suite = await repo.createSuite({ name: 'Booking', description: null });
  const ok = await queued(t, phoneCase({ suiteId: suite.id }), repo);
  await repo.claimNextRun();
  await repo.finishRun(ok.run.id, validateResult({ status: 'passed' }));
  const bad = await queued(t, phoneCase({ suiteId: suite.id, name: 'Two players' }), repo);
  await repo.claimNextRun();
  await repo.finishRun(bad.run.id, validateResult({ status: 'failed' }));
  await queued(t, apiCase(), repo); // still queued: not counted as finished

  const o = await repo.overview({ since: Date.now() - 60_000 });
  assert.deepEqual(o.cases, { total: 3, enabled: 3 });
  assert.equal(o.runs.total, 2);
  assert.equal(o.runs.passed, 1);
  assert.equal(o.runs.failed, 1);
  assert.equal(o.runs.successRate, 0.5);
  assert.equal(o.active, 1);
  assert.equal(o.recentFailures[0].id, bad.run.id);
  assert.deepEqual(o.suites, [{ suite: 'Booking', passed: 1, total: 2 }]);
});

// ---- runner -----------------------------------------------------------------
each('automation runner: executes with the registered executor and stores the result', async (t) => {
  const { repo, run } = await queued(t, apiCase());
  const seen = [];
  const runner = new AutomationRunner({
    repo,
    executors: { API: async (r) => { seen.push(r.case.request.path); return { status: 'passed', assertions: [{ kind: 'response_status', passed: true }] }; } },
  });
  assert.equal(await runner.tick(), 1);
  await runner.idle();
  assert.deepEqual(seen, ['/v2/tool-calls/router']);
  const r = await repo.getRun(run.id);
  assert.equal(r.status, 'passed');
  assert.equal(r.assertionsTotal, 1);
  assert.equal(runner.progress().passed, 1);
});

each('automation runner: a type without an executor ends with a clear error', async (t) => {
  const { repo, run } = await queued(t);
  const runner = new AutomationRunner({ repo, executors: {} });
  await runner.tick();
  await runner.idle();
  const r = await repo.getRun(run.id);
  assert.equal(r.status, 'error');
  assert.match(r.error, /no executor is available for PHONE tests/);
});

each('automation runner: a hung executor is aborted at the deadline and marked timeout', async (t) => {
  const { repo, run } = await queued(t, phoneCase({ timeoutSec: 10 }));
  let aborted = false;
  const runner = new AutomationRunner({
    repo,
    executors: { PHONE: (r, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); })) },
  });
  // Claim with a start time 10 s in the past so the deadline is already due.
  const claim = repo.claimNextRun.bind(repo);
  repo.claimNextRun = () => claim(Date.now() - 10_000);
  await runner.tick();
  await runner.idle();
  assert.equal(aborted, true);
  const r = await repo.getRun(run.id);
  assert.equal(r.status, 'timeout');
});

each('automation runner: cancelling a running run aborts its executor', async (t) => {
  const { repo, run } = await queued(t);
  let aborted = false;
  const runner = new AutomationRunner({
    repo,
    executors: { PHONE: (r, { signal }) => new Promise((resolve) => signal.addEventListener('abort', () => { aborted = true; resolve({ status: 'passed' }); })) },
  });
  await runner.tick();
  await repo.cancelRun(run.id, { by: 'qa@courserev.ai' });
  await runner.tick();
  await runner.idle();
  assert.equal(aborted, true);
  assert.equal((await repo.getRun(run.id)).status, 'cancelled', 'the late "passed" does not overwrite the cancel');
});

each('automation runner: recovers runs left running by a crashed worker', async (t) => {
  const { repo, run } = await queued(t);
  await repo.claimNextRun();
  const runner = new AutomationRunner({ repo });
  assert.deepEqual(await runner.recover(), [run.id]);
  assert.match((await repo.getRun(run.id)).error, /worker restarted/);
});

// ---- HTTP API -----------------------------------------------------------------
async function api(t, { repo = null, automation = undefined } = {}) {
  repo ??= await freshRepo(t);
  const app = express();
  app.use((req, res, next) => { req.user = { email: 'qa@courserev.ai' }; next(); });
  const config = { automation: { ...rules, maxRunsPerRequest: 3, maxActiveRuns: 4 } };
  const limiter = { take: () => ({ ok: true, remaining: 100 }) };
  app.use('/automation', buildAutomationRouter({ automation: automation === undefined ? { repo } : automation, config, limiter }));
  app.use((err, req, res, next) => res.status(err.status ?? 500).json({ error: err.message })); // eslint-disable-line no-unused-vars
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/automation`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };
  return { repo, call };
}

each('automation API: create a case, queue runs, read results, cancel', async (t) => {
  const { call } = await api(t);
  const meta = await call('GET', '/meta');
  assert.equal(meta.body.enabled, true);
  assert.deepEqual(meta.body.testNumbers.map((n) => n.number), [TEST_NUMBER]);

  const prod = await call('POST', '/cases', phoneCase({ targetNumber: '+14155550100' }));
  assert.equal(prod.status, 400);
  assert.match(prod.body.error, /production numbers cannot be dialled/);

  const created = await call('POST', '/cases', phoneCase());
  assert.equal(created.status, 201);
  assert.equal(created.body.targetAllowed, true);
  const id = created.body.id;

  const conflict = await call('PUT', `/cases/${id}`, { ...phoneCase(), version: 7 });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.currentVersion, 1);

  const queuedRes = await call('POST', '/runs', { caseIds: [id, id] });
  assert.equal(queuedRes.status, 202);
  assert.equal(queuedRes.body.runs.length, 1, 'duplicate ids are queued once');
  const runId = queuedRes.body.runs[0].id;

  const list = await call('GET', `/runs?batchId=${queuedRes.body.batchId}`);
  assert.deepEqual(list.body.items.map((r) => r.id), [runId]);
  assert.equal((await call('GET', `/runs/${runId}`)).body.case.targetNumber, TEST_NUMBER);

  assert.equal((await call('POST', `/runs/${runId}/cancel`)).body.status, 'cancelled');
  assert.equal((await call('POST', `/runs/${runId}/cancel`)).status, 409);
  assert.equal((await call('GET', '/runs/999')).status, 404);
  assert.equal((await call('GET', '/runs/abc')).status, 404);
});

each('automation API: queuing re-checks rules, limits and disabled tests', async (t) => {
  const { repo, call } = await api(t);
  const a = (await call('POST', '/cases', phoneCase())).body;
  const off = (await call('POST', '/cases', phoneCase({ name: 'Off', enabled: false }))).body;

  assert.equal((await call('POST', '/runs', { caseIds: [] })).status, 400);
  assert.equal((await call('POST', '/runs', { caseIds: [1, 2, 3, 4] })).status, 400, 'per-request cap');
  const missing = await call('POST', '/runs', { caseIds: [a.id, 999] });
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body.missing, [999]);
  assert.match((await call('POST', '/runs', { caseIds: [off.id] })).body.error, /disabled/);

  // A number removed from the allow-list after the case was saved can no longer be dialled.
  await backend.setTarget(repo, a.id, '+14155550100');
  assert.equal((await call('GET', `/cases/${a.id}`)).body.targetAllowed, false);
  const blocked = await call('POST', '/runs', { caseIds: [a.id] });
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.error, /not a configured test number/);

  // Active-run cap (4 in this config).
  const ok = (await call('POST', '/cases', phoneCase({ name: 'Ok' }))).body;
  for (let i = 0; i < 4; i++) assert.equal((await call('POST', '/runs', { caseIds: [ok.id] })).status, 202);
  assert.equal((await call('POST', '/runs', { caseIds: [ok.id] })).status, 429);
});

each('automation API: without a database the page is told it is disabled', async (t) => {
  const { call } = await api(t, { automation: null });
  const meta = await call('GET', '/meta');
  assert.equal(meta.body.enabled, false);
  assert.equal((await call('GET', '/cases')).status, 404);
});

