/**
 * Row → object mapping for the Call Automation tables, shared by the
 * PostgreSQL and libSQL repositories. Each backend passes its own converters
 * (PostgreSQL returns jsonb/Date/bigint-as-string; libSQL returns TEXT/epoch-ms/0-1).
 *
 *   conv = { json(v), ms(v), bool(v), num(v) }
 */
export const FINISHED_FOR_STATS = Object.freeze(['passed', 'failed', 'error', 'timeout']);
export const FAILED = Object.freeze(['failed', 'error', 'timeout']);
export const RUN_PAGE_MAX = 100;

export const duplicateName = () => Object.assign(new Error('a suite with this name already exists'), { status: 409 });
export const versionConflict = (current) => Object.assign(
  new Error('this test was changed by someone else; reload it and try again'),
  { status: 409, currentVersion: current },
);

export function toSuite(r, c) {
  return {
    id: c.num(r.id),
    name: r.name,
    description: r.description ?? null,
    createdAt: c.ms(r.created_at),
    caseCount: r.case_count === undefined ? undefined : c.num(r.case_count),
  };
}

export function toCase(r, c) {
  return {
    id: c.num(r.id),
    suiteId: r.suite_id === null || r.suite_id === undefined ? null : c.num(r.suite_id),
    suiteName: r.suite_name ?? null,
    name: r.name,
    description: r.description ?? null,
    type: r.type,
    enabled: c.bool(r.enabled),
    courseId: r.course_id === null || r.course_id === undefined ? null : c.num(r.course_id),
    courseName: r.course_name ?? null,
    targetNumber: r.target_number ?? null,
    request: c.json(r.request),
    steps: c.json(r.steps) ?? [],
    assertions: c.json(r.assertions) ?? [],
    timeoutSec: c.num(r.timeout_sec),
    version: c.num(r.version),
    createdAt: c.ms(r.created_at),
    updatedAt: c.ms(r.updated_at),
    updatedBy: r.updated_by ?? null,
    lastRun: r.last_run_id === null || r.last_run_id === undefined ? null : {
      id: c.num(r.last_run_id), status: r.last_run_status, finishedAt: c.ms(r.last_run_finished_at),
    },
  };
}

/** `full` = include the case snapshot and artifacts (detail view). */
export function toRun(r, c, { full = false } = {}) {
  const snap = c.json(r.case_snapshot) ?? {};
  const run = {
    id: c.num(r.id),
    batchId: r.batch_id,
    caseId: c.num(r.case_id),
    caseName: snap.name ?? null,
    type: snap.type ?? null,
    suiteName: snap.suiteName ?? null,
    status: r.status,
    queuedAt: c.ms(r.queued_at),
    startedAt: c.ms(r.started_at),
    deadlineAt: c.ms(r.deadline_at),
    finishedAt: c.ms(r.finished_at),
    durationMs: r.duration_ms === null || r.duration_ms === undefined ? null : c.num(r.duration_ms),
    telnyxCallControlId: r.telnyx_call_control_id ?? null,
    courserevCallId: r.courserev_call_id ?? null,
    triggeredBy: r.triggered_by ?? null,
    error: r.error ?? null,
    assertionsPassed: r.a_passed === undefined || r.a_passed === null ? undefined : c.num(r.a_passed),
    assertionsTotal: r.a_total === undefined || r.a_total === null ? undefined : c.num(r.a_total),
  };
  if (full) {
    run.case = snap;
    run.artifacts = c.json(r.artifacts);
  }
  return run;
}

export function toAssertion(r, c) {
  return {
    idx: c.num(r.idx),
    kind: r.kind,
    label: r.label,
    passed: c.bool(r.passed),
    expected: c.json(r.expected),
    actual: c.json(r.actual),
    detail: r.detail ?? null,
  };
}

/** Group the latest finished run per case into suite pass counts. */
export function suiteSummary(rows) {
  const by = new Map();
  for (const r of rows) {
    const key = r.suite_name ?? 'Unassigned';
    const s = by.get(key) ?? { suite: key, passed: 0, total: 0 };
    s.total++;
    if (r.status === 'passed') s.passed++;
    by.set(key, s);
  }
  return [...by.values()].sort((a, b) => a.suite.localeCompare(b.suite));
}
