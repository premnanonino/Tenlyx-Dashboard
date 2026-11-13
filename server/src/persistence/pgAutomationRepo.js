import {
  FAILED, FINISHED_FOR_STATS, RUN_PAGE_MAX, duplicateName, versionConflict,
  toAssertion, toCase, toRun, toSuite, suiteSummary,
} from './automationRows.js';

/**
 * Call Automation storage on PostgreSQL. Same methods and return shapes as
 * LibsqlAutomationRepo. Timestamps come from the application clock (passed in),
 * so the single worker decides deadlines with one clock on either backend.
 */
const conv = {
  json: (v) => (v === undefined ? null : v),
  ms: (v) => (v === null || v === undefined ? null : new Date(v).getTime()),
  bool: (v) => v === true,
  num: (v) => Number(v),
};
const j = (v) => (v === null || v === undefined ? null : JSON.stringify(v));
const ts = (ms) => new Date(ms);
const isUnique = (err) => err?.code === '23505';
const badSuite = () => Object.assign(new Error('suiteId does not exist'), { status: 400 });

const RUN_COLS = `r.id, r.batch_id, r.case_id, r.case_snapshot, r.status, r.queued_at, r.started_at, r.deadline_at,
  r.finished_at, r.duration_ms, r.telnyx_call_control_id, r.courserev_call_id, r.triggered_by, r.error`;
const RUN_COUNTS = `(SELECT count(*) FROM automation_run_assertions a WHERE a.run_id = r.id AND a.passed) AS a_passed,
  (SELECT count(*) FROM automation_run_assertions a WHERE a.run_id = r.id) AS a_total`;
const CASE_SELECT = `SELECT c.*, s.name AS suite_name, lr.id AS last_run_id, lr.status AS last_run_status, lr.finished_at AS last_run_finished_at
  FROM automation_cases c
  LEFT JOIN automation_suites s ON s.id = c.suite_id
  LEFT JOIN automation_runs lr ON lr.id = (SELECT max(id) FROM automation_runs WHERE case_id = c.id)`;
const BARE_RUN_COLS = RUN_COLS.replace(/r\./g, '');

export class PgAutomationRepo {
  constructor({ pool, logger }) {
    this.pool = pool;
    this.logger = logger;
  }

  #q(sql, args = []) {
    return this.pool.query(sql, args);
  }

  async #suiteExists(id) {
    if (id === null || id === undefined) return;
    const { rows } = await this.#q('SELECT 1 FROM automation_suites WHERE id = $1', [id]);
    if (!rows.length) throw badSuite();
  }

  // ---- suites ---------------------------------------------------------------
  async listSuites() {
    const { rows } = await this.#q(`SELECT s.*, (SELECT count(*) FROM automation_cases c WHERE c.suite_id = s.id) AS case_count
                                      FROM automation_suites s ORDER BY s.name`);
    return rows.map((r) => toSuite(r, conv));
  }

  async createSuite({ name, description }) {
    try {
      const { rows } = await this.#q('INSERT INTO automation_suites (name, description) VALUES ($1, $2) RETURNING *', [name, description]);
      return toSuite(rows[0], conv);
    } catch (err) {
      if (isUnique(err)) throw duplicateName();
      throw err;
    }
  }

  async updateSuite(id, { name, description }) {
    try {
      const { rows } = await this.#q('UPDATE automation_suites SET name = $1, description = $2 WHERE id = $3 RETURNING *', [name, description, id]);
      return rows[0] ? toSuite(rows[0], conv) : null;
    } catch (err) {
      if (isUnique(err)) throw duplicateName();
      throw err;
    }
  }

  /** Cases in the suite are kept and become unassigned. */
  async deleteSuite(id) {
    return this.#tx(async (c) => {
      await c.query('UPDATE automation_cases SET suite_id = NULL WHERE suite_id = $1', [id]);
      const { rowCount } = await c.query('DELETE FROM automation_suites WHERE id = $1', [id]);
      return rowCount > 0;
    });
  }

  // ---- cases ----------------------------------------------------------------
  async listCases({ suiteId = null } = {}) {
    const { rows } = await this.#q(`${CASE_SELECT} WHERE ($1::bigint IS NULL OR c.suite_id = $1)
                                     ORDER BY c.suite_id IS NULL, s.name, c.name, c.id`, [suiteId]);
    return rows.map((r) => toCase(r, conv));
  }

  async getCase(id) {
    const { rows } = await this.#q(`${CASE_SELECT} WHERE c.id = $1`, [id]);
    return rows[0] ? toCase(rows[0], conv) : null;
  }

  async getCases(ids) {
    if (!ids.length) return [];
    const { rows } = await this.#q(`${CASE_SELECT} WHERE c.id = ANY($1::bigint[])`, [ids]);
    return rows.map((r) => toCase(r, conv));
  }

  async createCase(c, by, now = Date.now()) {
    await this.#suiteExists(c.suiteId);
    const { rows } = await this.#q(
      `INSERT INTO automation_cases (suite_id, name, description, type, enabled, course_id, course_name, target_number,
                                     request, steps, assertions, timeout_sec, created_at, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13, $14) RETURNING id`,
      [c.suiteId, c.name, c.description, c.type, c.enabled, c.courseId, c.courseName, c.targetNumber,
        j(c.request), j(c.steps), j(c.assertions), c.timeoutSec, ts(now), by ?? null],
    );
    return this.getCase(Number(rows[0].id));
  }

  /** null = no such case; throws 409 when `version` is given and stale. */
  async updateCase(id, c, { version = null, by = null, now = Date.now() } = {}) {
    await this.#suiteExists(c.suiteId);
    const { rows } = await this.#q(
      `UPDATE automation_cases SET suite_id = $1, name = $2, description = $3, type = $4, enabled = $5, course_id = $6,
              course_name = $7, target_number = $8, request = $9, steps = $10, assertions = $11, timeout_sec = $12,
              version = version + 1, updated_at = $13, updated_by = $14
        WHERE id = $15 AND ($16::int IS NULL OR version = $16) RETURNING id`,
      [c.suiteId, c.name, c.description, c.type, c.enabled, c.courseId, c.courseName, c.targetNumber,
        j(c.request), j(c.steps), j(c.assertions), c.timeoutSec, ts(now), by, id, version],
    );
    if (rows.length) return this.getCase(id);
    const cur = await this.#q('SELECT version FROM automation_cases WHERE id = $1', [id]);
    if (!cur.rows.length) return null;
    throw versionConflict(Number(cur.rows[0].version));
  }

  /** Past runs keep their snapshot of the case. */
  async deleteCase(id) {
    const { rowCount } = await this.#q('DELETE FROM automation_cases WHERE id = $1', [id]);
    return rowCount > 0;
  }

  // ---- runs -----------------------------------------------------------------
  /** One queued run per entry: [{ caseId, snapshot }]. */
  async queueRuns(entries, { batchId, by = null, now = Date.now() }) {
    if (!entries.length) return [];
    const { rows } = await this.#q(
      `INSERT INTO automation_runs (batch_id, case_id, case_snapshot, triggered_by, queued_at)
       SELECT $1::text, x.case_id, x.snap, $2::text, $3::timestamptz FROM unnest($4::bigint[], $5::jsonb[]) AS x(case_id, snap)
       RETURNING ${BARE_RUN_COLS}`,
      [batchId, by, ts(now), entries.map((e) => e.caseId), entries.map((e) => j(e.snapshot))],
    );
    return rows.map((r) => toRun(r, conv)).sort((a, b) => a.id - b.id);
  }

  async countActiveRuns() {
    const { rows } = await this.#q("SELECT count(*) AS n FROM automation_runs WHERE status IN ('queued', 'running')");
    return Number(rows[0].n);
  }

  /** Newest first, keyset-paginated by id. */
  async listRuns({ caseId = null, batchId = null, status = null, beforeId = null, limit = 50 } = {}) {
    const { rows } = await this.#q(
      `SELECT ${RUN_COLS}, ${RUN_COUNTS} FROM automation_runs r
        WHERE ($1::bigint IS NULL OR r.case_id = $1) AND ($2::text IS NULL OR r.batch_id = $2)
          AND ($3::text IS NULL OR r.status = $3) AND ($4::bigint IS NULL OR r.id < $4)
        ORDER BY r.id DESC LIMIT $5`,
      [caseId, batchId, status, beforeId, Math.min(limit, RUN_PAGE_MAX)],
    );
    return rows.map((r) => toRun(r, conv));
  }

  async getRun(id) {
    const [run, asserts] = await Promise.all([
      this.#q(`SELECT ${RUN_COLS}, r.artifacts, ${RUN_COUNTS} FROM automation_runs r WHERE r.id = $1`, [id]),
      this.#q('SELECT * FROM automation_run_assertions WHERE run_id = $1 ORDER BY idx', [id]),
    ]);
    if (!run.rows[0]) return null;
    return { ...toRun(run.rows[0], conv, { full: true }), assertions: asserts.rows.map((r) => toAssertion(r, conv)) };
  }

  /** Cancel a queued or running run. { run, cancelled } — run is null if it does not exist. */
  async cancelRun(id, { by = null, now = Date.now() } = {}) {
    const { rows } = await this.#q(
      `UPDATE automation_runs SET status = 'cancelled', finished_at = $1::timestamptz,
              duration_ms = CASE WHEN started_at IS NULL THEN NULL
                                 ELSE (extract(epoch FROM ($1::timestamptz - started_at)) * 1000)::int END,
              error = $2
        WHERE id = $3 AND status IN ('queued', 'running') RETURNING id`,
      [ts(now), by ? `cancelled by ${by}` : 'cancelled', id],
    );
    return { run: await this.getRun(id), cancelled: rows.length > 0 };
  }

  /** Worker: atomically move the oldest queued run to running, with its deadline. */
  async claimNextRun(now = Date.now()) {
    const { rows } = await this.#q(
      `UPDATE automation_runs
          SET status = 'running', started_at = $1::timestamptz,
              deadline_at = $1::timestamptz + make_interval(secs => (case_snapshot->>'timeoutSec')::int)
        WHERE id = (SELECT id FROM automation_runs WHERE status = 'queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING ${BARE_RUN_COLS}, artifacts`,
      [ts(now)],
    );
    return rows[0] ? toRun(rows[0], conv, { full: true }) : null;
  }

  /**
   * Store an executor's (validated) result. Only a run still `running` is updated,
   * so a run cancelled or timed out meanwhile keeps that status. Returns true if stored.
   */
  async finishRun(id, result, now = Date.now()) {
    return this.#tx(async (c) => {
      const up = await c.query(
        `UPDATE automation_runs SET status = $1, finished_at = $2::timestamptz,
                duration_ms = (extract(epoch FROM ($2::timestamptz - started_at)) * 1000)::int, error = $3,
                telnyx_call_control_id = $4, courserev_call_id = $5, artifacts = $6
          WHERE id = $7 AND status = 'running'`,
        [result.status, ts(now), result.error, result.telnyxCallControlId, result.courserevCallId, j(result.artifacts), id],
      );
      if (!up.rowCount) return false;
      await c.query('DELETE FROM automation_run_assertions WHERE run_id = $1', [id]);
      const as = result.assertions;
      if (as.length) {
        await c.query(
          `INSERT INTO automation_run_assertions (run_id, idx, kind, label, passed, expected, actual, detail)
           SELECT $1::bigint, * FROM unnest($2::int[], $3::text[], $4::text[], $5::boolean[], $6::jsonb[], $7::jsonb[], $8::text[])`,
          [id, as.map((a) => a.idx), as.map((a) => a.kind), as.map((a) => a.label), as.map((a) => a.passed),
            as.map((a) => j(a.expected)), as.map((a) => j(a.actual)), as.map((a) => a.detail)],
        );
      }
      return true;
    });
  }

  /** Running past the deadline → timeout; queued too long (no worker) → error. */
  async expireRuns({ now = Date.now(), queuedBefore }) {
    const t = await this.#q(
      `UPDATE automation_runs SET status = 'timeout', finished_at = $1::timestamptz,
              duration_ms = (extract(epoch FROM ($1::timestamptz - started_at)) * 1000)::int, error = 'run exceeded its timeout'
        WHERE status = 'running' AND deadline_at < $1::timestamptz RETURNING id`,
      [ts(now)],
    );
    const a = await this.#q(
      `UPDATE automation_runs SET status = 'error', finished_at = $1, error = 'not picked up by the worker in time'
        WHERE status = 'queued' AND queued_at < $2 RETURNING id`,
      [ts(now), ts(queuedBefore)],
    );
    return { timedOut: t.rows.map((r) => Number(r.id)), abandoned: a.rows.map((r) => Number(r.id)) };
  }

  /** Worker start: runs a previous worker left `running` can never finish. */
  async abandonRunning(now = Date.now()) {
    const { rows } = await this.#q(
      `UPDATE automation_runs SET status = 'error', finished_at = $1::timestamptz,
              duration_ms = (extract(epoch FROM ($1::timestamptz - started_at)) * 1000)::int,
              error = 'the worker restarted while this run was in progress'
        WHERE status = 'running' RETURNING id`,
      [ts(now)],
    );
    return rows.map((r) => Number(r.id));
  }

  async runStatuses(ids) {
    if (!ids.length) return new Map();
    const { rows } = await this.#q('SELECT id, status FROM automation_runs WHERE id = ANY($1::bigint[])', [ids]);
    return new Map(rows.map((r) => [Number(r.id), r.status]));
  }

  // ---- overview -------------------------------------------------------------
  async overview({ since }) {
    const [cases, runs, active, last, failures, latest] = await Promise.all([
      this.#q('SELECT count(*) AS total, count(*) FILTER (WHERE enabled) AS enabled FROM automation_cases'),
      this.#q(
        `SELECT count(*) AS total, count(*) FILTER (WHERE status = 'passed') AS passed,
                count(*) FILTER (WHERE status = ANY($2::text[])) AS failed
           FROM automation_runs WHERE queued_at >= $1 AND status = ANY($3::text[])`,
        [ts(since), FAILED, FINISHED_FOR_STATS],
      ),
      this.#q("SELECT count(*) AS n FROM automation_runs WHERE status IN ('queued', 'running')"),
      this.#q(`SELECT ${RUN_COLS}, ${RUN_COUNTS} FROM automation_runs r ORDER BY r.id DESC LIMIT 1`),
      this.#q(`SELECT ${RUN_COLS}, ${RUN_COUNTS} FROM automation_runs r WHERE r.status = ANY($1::text[]) ORDER BY r.id DESC LIMIT 5`, [FAILED]),
      this.#q(
        `SELECT s.name AS suite_name, r.status FROM automation_cases c
           LEFT JOIN automation_suites s ON s.id = c.suite_id
           JOIN automation_runs r ON r.id = (SELECT max(id) FROM automation_runs
                                              WHERE case_id = c.id AND status = ANY($1::text[]))`,
        [FINISHED_FOR_STATS],
      ),
    ]);
    const passed = Number(runs.rows[0].passed);
    const failed = Number(runs.rows[0].failed);
    return {
      cases: { total: Number(cases.rows[0].total), enabled: Number(cases.rows[0].enabled) },
      runs: { since, total: Number(runs.rows[0].total), passed, failed, successRate: passed + failed ? passed / (passed + failed) : null },
      active: Number(active.rows[0].n),
      lastRun: last.rows[0] ? toRun(last.rows[0], conv) : null,
      recentFailures: failures.rows.map((r) => toRun(r, conv)),
      suites: suiteSummary(latest.rows),
    };
  }

  async #tx(fn) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }
}
