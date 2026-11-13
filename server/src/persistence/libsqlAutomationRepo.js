import {
  FAILED, FINISHED_FOR_STATS, RUN_PAGE_MAX, duplicateName, versionConflict,
  toAssertion, toCase, toRun, toSuite, suiteSummary,
} from './automationRows.js';

/**
 * Call Automation storage on libSQL / SQLite. Same methods and return shapes as
 * PgAutomationRepo. Timestamps are epoch ms from the application clock (the
 * single worker both claims and expires runs, so one clock decides deadlines).
 */
const conv = {
  json: (v) => (v === null || v === undefined ? null : JSON.parse(v)),
  ms: (v) => (v === null || v === undefined ? null : Number(v)),
  bool: (v) => Number(v) === 1,
  num: (v) => Number(v),
};
const j = (v) => (v === null || v === undefined ? null : JSON.stringify(v));
const placeholders = (n) => Array.from({ length: n }, () => '?').join(', ');
const isUnique = (err) => /UNIQUE constraint failed/i.test(err?.message ?? '');
const badSuite = () => Object.assign(new Error('suiteId does not exist'), { status: 400 });

const RUN_COLS = `r.id, r.batch_id, r.case_id, r.case_snapshot, r.status, r.queued_at, r.started_at, r.deadline_at,
  r.finished_at, r.duration_ms, r.telnyx_call_control_id, r.courserev_call_id, r.triggered_by, r.error`;
const RUN_COUNTS = `(SELECT count(*) FROM automation_run_assertions a WHERE a.run_id = r.id AND a.passed = 1) AS a_passed,
  (SELECT count(*) FROM automation_run_assertions a WHERE a.run_id = r.id) AS a_total`;
const CASE_SELECT = `SELECT c.*, s.name AS suite_name, lr.id AS last_run_id, lr.status AS last_run_status, lr.finished_at AS last_run_finished_at
  FROM automation_cases c
  LEFT JOIN automation_suites s ON s.id = c.suite_id
  LEFT JOIN automation_runs lr ON lr.id = (SELECT max(id) FROM automation_runs WHERE case_id = c.id)`;
const inList = (xs) => xs.map((s) => `'${s}'`).join(', '); // constant status names only

export class LibsqlAutomationRepo {
  constructor({ client, logger }) {
    this.client = client;
    this.logger = logger;
  }

  #q(sql, args = []) {
    return this.client.execute({ sql, args });
  }

  async #suiteExists(id) {
    if (id === null || id === undefined) return;
    const rs = await this.#q('SELECT 1 FROM automation_suites WHERE id = ?', [id]);
    if (!rs.rows.length) throw badSuite();
  }

  // ---- suites ---------------------------------------------------------------
  async listSuites() {
    const rs = await this.#q(`SELECT s.*, (SELECT count(*) FROM automation_cases c WHERE c.suite_id = s.id) AS case_count
                                FROM automation_suites s ORDER BY s.name`);
    return rs.rows.map((r) => toSuite(r, conv));
  }

  async createSuite({ name, description }) {
    try {
      const rs = await this.#q('INSERT INTO automation_suites (name, description) VALUES (?, ?) RETURNING *', [name, description]);
      return toSuite(rs.rows[0], conv);
    } catch (err) {
      if (isUnique(err)) throw duplicateName();
      throw err;
    }
  }

  async updateSuite(id, { name, description }) {
    try {
      const rs = await this.#q('UPDATE automation_suites SET name = ?, description = ? WHERE id = ? RETURNING *', [name, description, id]);
      return rs.rows[0] ? toSuite(rs.rows[0], conv) : null;
    } catch (err) {
      if (isUnique(err)) throw duplicateName();
      throw err;
    }
  }

  /** Cases in the suite are kept and become unassigned. */
  async deleteSuite(id) {
    const [, del] = await this.client.batch([
      { sql: 'UPDATE automation_cases SET suite_id = NULL WHERE suite_id = ?', args: [id] },
      { sql: 'DELETE FROM automation_suites WHERE id = ?', args: [id] },
    ], 'write');
    return del.rowsAffected > 0;
  }

  // ---- cases ----------------------------------------------------------------
  async listCases({ suiteId = null } = {}) {
    const rs = await this.#q(`${CASE_SELECT} WHERE (? IS NULL OR c.suite_id = ?)
                               ORDER BY c.suite_id IS NULL, s.name, c.name, c.id`, [suiteId, suiteId]);
    return rs.rows.map((r) => toCase(r, conv));
  }

  async getCase(id) {
    const rs = await this.#q(`${CASE_SELECT} WHERE c.id = ?`, [id]);
    return rs.rows[0] ? toCase(rs.rows[0], conv) : null;
  }

  async getCases(ids) {
    if (!ids.length) return [];
    const rs = await this.#q(`${CASE_SELECT} WHERE c.id IN (${placeholders(ids.length)})`, ids);
    return rs.rows.map((r) => toCase(r, conv));
  }

  async createCase(c, by, now = Date.now()) {
    await this.#suiteExists(c.suiteId);
    const rs = await this.#q(
      `INSERT INTO automation_cases (suite_id, name, description, type, enabled, course_id, course_name, target_number,
                                     request, steps, assertions, timeout_sec, created_at, updated_at, updated_by)
       VALUES (${placeholders(15)}) RETURNING id`,
      [c.suiteId, c.name, c.description, c.type, c.enabled ? 1 : 0, c.courseId, c.courseName, c.targetNumber,
        j(c.request), j(c.steps), j(c.assertions), c.timeoutSec, now, now, by ?? null],
    );
    return this.getCase(Number(rs.rows[0].id));
  }

  /** null = no such case; throws 409 when `version` is given and stale. */
  async updateCase(id, c, { version = null, by = null, now = Date.now() } = {}) {
    await this.#suiteExists(c.suiteId);
    const rs = await this.#q(
      `UPDATE automation_cases SET suite_id = ?, name = ?, description = ?, type = ?, enabled = ?, course_id = ?, course_name = ?,
              target_number = ?, request = ?, steps = ?, assertions = ?, timeout_sec = ?,
              version = version + 1, updated_at = ?, updated_by = ?
        WHERE id = ? AND (? IS NULL OR version = ?) RETURNING id`,
      [c.suiteId, c.name, c.description, c.type, c.enabled ? 1 : 0, c.courseId, c.courseName, c.targetNumber,
        j(c.request), j(c.steps), j(c.assertions), c.timeoutSec, now, by, id, version, version],
    );
    if (rs.rows.length) return this.getCase(id);
    const cur = await this.#q('SELECT version FROM automation_cases WHERE id = ?', [id]);
    if (!cur.rows.length) return null;
    throw versionConflict(Number(cur.rows[0].version));
  }

  /** Past runs keep their snapshot of the case. */
  async deleteCase(id) {
    const rs = await this.#q('DELETE FROM automation_cases WHERE id = ?', [id]);
    return rs.rowsAffected > 0;
  }

  // ---- runs -----------------------------------------------------------------
  /** One queued run per entry: [{ caseId, snapshot }]. */
  async queueRuns(entries, { batchId, by = null, now = Date.now() }) {
    if (!entries.length) return [];
    const rs = await this.#q(
      `INSERT INTO automation_runs (batch_id, case_id, case_snapshot, triggered_by, queued_at)
       VALUES ${entries.map(() => '(?, ?, ?, ?, ?)').join(', ')}
       RETURNING ${RUN_COLS.replace(/r\./g, '')}`,
      entries.flatMap((e) => [batchId, e.caseId, j(e.snapshot), by, now]),
    );
    return rs.rows.map((r) => toRun(r, conv)).sort((a, b) => a.id - b.id);
  }

  async countActiveRuns() {
    const rs = await this.#q("SELECT count(*) AS n FROM automation_runs WHERE status IN ('queued', 'running')");
    return Number(rs.rows[0].n);
  }

  /** Newest first, keyset-paginated by id. */
  async listRuns({ caseId = null, batchId = null, status = null, beforeId = null, limit = 50 } = {}) {
    const rs = await this.#q(
      `SELECT ${RUN_COLS}, ${RUN_COUNTS} FROM automation_runs r
        WHERE (? IS NULL OR r.case_id = ?) AND (? IS NULL OR r.batch_id = ?) AND (? IS NULL OR r.status = ?)
          AND (? IS NULL OR r.id < ?)
        ORDER BY r.id DESC LIMIT ?`,
      [caseId, caseId, batchId, batchId, status, status, beforeId, beforeId, Math.min(limit, RUN_PAGE_MAX)],
    );
    return rs.rows.map((r) => toRun(r, conv));
  }

  async getRun(id) {
    const [run, asserts] = await Promise.all([
      this.#q(`SELECT ${RUN_COLS}, r.artifacts, ${RUN_COUNTS} FROM automation_runs r WHERE r.id = ?`, [id]),
      this.#q('SELECT * FROM automation_run_assertions WHERE run_id = ? ORDER BY idx', [id]),
    ]);
    if (!run.rows[0]) return null;
    return { ...toRun(run.rows[0], conv, { full: true }), assertions: asserts.rows.map((r) => toAssertion(r, conv)) };
  }

  /** Cancel a queued or running run. { run, cancelled } — run is null if it does not exist. */
  async cancelRun(id, { by = null, now = Date.now() } = {}) {
    const rs = await this.#q(
      `UPDATE automation_runs SET status = 'cancelled', finished_at = ?,
              duration_ms = CASE WHEN started_at IS NULL THEN NULL ELSE ? - started_at END,
              error = ?
        WHERE id = ? AND status IN ('queued', 'running') RETURNING id`,
      [now, now, by ? `cancelled by ${by}` : 'cancelled', id],
    );
    return { run: await this.getRun(id), cancelled: rs.rows.length > 0 };
  }

  /** Worker: atomically move the oldest queued run to running, with its deadline. */
  async claimNextRun(now = Date.now()) {
    const rs = await this.#q(
      `UPDATE automation_runs
          SET status = 'running', started_at = ?,
              deadline_at = ? + CAST(json_extract(case_snapshot, '$.timeoutSec') AS INTEGER) * 1000
        WHERE id = (SELECT id FROM automation_runs WHERE status = 'queued' ORDER BY id LIMIT 1) AND status = 'queued'
        RETURNING ${RUN_COLS.replace(/r\./g, '')}, artifacts`,
      [now, now],
    );
    return rs.rows[0] ? toRun(rs.rows[0], conv, { full: true }) : null;
  }

  /**
   * Store an executor's (validated) result. Only a run still `running` is updated,
   * so a run cancelled or timed out meanwhile keeps that status. Returns true if stored.
   */
  async finishRun(id, result, now = Date.now()) {
    const tx = await this.client.transaction('write');
    try {
      const up = await tx.execute({
        sql: `UPDATE automation_runs SET status = ?, finished_at = ?, duration_ms = ? - started_at, error = ?,
                     telnyx_call_control_id = ?, courserev_call_id = ?, artifacts = ?
               WHERE id = ? AND status = 'running'`,
        args: [result.status, now, now, result.error, result.telnyxCallControlId, result.courserevCallId, j(result.artifacts), id],
      });
      if (!up.rowsAffected) { await tx.rollback(); return false; }
      await tx.execute({ sql: 'DELETE FROM automation_run_assertions WHERE run_id = ?', args: [id] });
      for (const a of result.assertions) {
        await tx.execute({
          sql: `INSERT INTO automation_run_assertions (run_id, idx, kind, label, passed, expected, actual, detail)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [id, a.idx, a.kind, a.label, a.passed ? 1 : 0, j(a.expected), j(a.actual), a.detail],
        });
      }
      await tx.commit();
      return true;
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    } finally {
      tx.close();
    }
  }

  /** Running past the deadline → timeout; queued too long (no worker) → error. */
  async expireRuns({ now = Date.now(), queuedBefore }) {
    const [timedOut, abandoned] = await this.client.batch([
      {
        sql: `UPDATE automation_runs SET status = 'timeout', finished_at = ?, duration_ms = ? - started_at,
                     error = 'run exceeded its timeout'
               WHERE status = 'running' AND deadline_at < ? RETURNING id`,
        args: [now, now, now],
      },
      {
        sql: `UPDATE automation_runs SET status = 'error', finished_at = ?, error = 'not picked up by the worker in time'
               WHERE status = 'queued' AND queued_at < ? RETURNING id`,
        args: [now, queuedBefore],
      },
    ], 'write');
    return { timedOut: timedOut.rows.map((r) => Number(r.id)), abandoned: abandoned.rows.map((r) => Number(r.id)) };
  }

  /** Worker start: runs a previous worker left `running` can never finish. */
  async abandonRunning(now = Date.now()) {
    const rs = await this.#q(
      `UPDATE automation_runs SET status = 'error', finished_at = ?, duration_ms = ? - started_at,
              error = 'the worker restarted while this run was in progress'
        WHERE status = 'running' RETURNING id`,
      [now, now],
    );
    return rs.rows.map((r) => Number(r.id));
  }

  async runStatuses(ids) {
    if (!ids.length) return new Map();
    const rs = await this.#q(`SELECT id, status FROM automation_runs WHERE id IN (${placeholders(ids.length)})`, ids);
    return new Map(rs.rows.map((r) => [Number(r.id), r.status]));
  }

  // ---- overview -------------------------------------------------------------
  async overview({ since }) {
    const [cases, runs, active, last, failures, latest] = await this.client.batch([
      'SELECT count(*) AS total, coalesce(sum(enabled), 0) AS enabled FROM automation_cases',
      {
        sql: `SELECT count(*) AS total, coalesce(sum(status = 'passed'), 0) AS passed,
                     coalesce(sum(status IN (${inList(FAILED)})), 0) AS failed
                FROM automation_runs WHERE queued_at >= ? AND status IN (${inList(FINISHED_FOR_STATS)})`,
        args: [since],
      },
      "SELECT count(*) AS n FROM automation_runs WHERE status IN ('queued', 'running')",
      `SELECT ${RUN_COLS}, ${RUN_COUNTS} FROM automation_runs r ORDER BY r.id DESC LIMIT 1`,
      `SELECT ${RUN_COLS}, ${RUN_COUNTS} FROM automation_runs r WHERE r.status IN (${inList(FAILED)}) ORDER BY r.id DESC LIMIT 5`,
      `SELECT s.name AS suite_name, r.status FROM automation_cases c
         LEFT JOIN automation_suites s ON s.id = c.suite_id
         JOIN automation_runs r ON r.id = (SELECT max(id) FROM automation_runs
                                            WHERE case_id = c.id AND status IN (${inList(FINISHED_FOR_STATS)}))`,
    ], 'read');
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
}
