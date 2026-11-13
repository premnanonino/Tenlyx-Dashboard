/**
 * Call Automation: the shape and rules of tests, kept free of I/O so the API,
 * the worker and the tests share one definition.
 *
 *   suite      a named group of cases ("Booking", "Cancellation", ...)
 *   case       one reusable test: PHONE (a real call through Telnyx), API (a direct
 *              CourseRev endpoint call) or HYBRID (both)
 *   run        one execution of one case; "Run Selected" queues one run per case
 *              under a shared batch id. The case is snapshotted into the run.
 *
 * Safety rules enforced here (never only in the UI):
 *   - PHONE/HYBRID cases may only dial numbers on the configured test allow-list;
 *   - API cases carry a path only: the host is fixed by configuration;
 *   - every run has a bounded timeout.
 */

export const CASE_TYPES = Object.freeze(['PHONE', 'API', 'HYBRID']);
export const RUN_STATUSES = Object.freeze(['queued', 'running', 'passed', 'failed', 'error', 'timeout', 'cancelled']);
export const TERMINAL_STATUSES = Object.freeze(['passed', 'failed', 'error', 'timeout', 'cancelled']);
export const HTTP_METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
export const BOOKING_FIELDS = Object.freeze(['players', 'holes', 'courseId', 'teeDate', 'teeTime']);

const LIMITS = Object.freeze({
  name: 120, description: 2_000, courseName: 200, say: 500, expect: 500, label: 200, pattern: 200,
  steps: 30, assertions: 100, path: 300, bodyBytes: 16_384, tool: 100, jsonPath: 200,
});

const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });

// ---- small validators ------------------------------------------------------
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function str(v, field, { max, required = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw badRequest(`${field} is required`);
    return null;
  }
  if (typeof v !== 'string') throw badRequest(`${field} must be a string`);
  const s = v.trim();
  if (required && !s) throw badRequest(`${field} is required`);
  if (s.length > max) throw badRequest(`${field} must be at most ${max} characters`);
  return s || null;
}

function int(v, field, { min, max, required = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw badRequest(`${field} is required`);
    return null;
  }
  const n = typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : v;
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${field} must be an integer from ${min} to ${max}`);
  return n;
}

/** Scalar JSON value used by equality assertions. */
function scalar(v, field) {
  if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
    if (typeof v === 'string' && v.length > LIMITS.label) throw badRequest(`${field} is too long`);
    return v;
  }
  throw badRequest(`${field} must be a string, number, boolean or null`);
}

/** "+1 (631) 296-9723" → "+16312969723"; null when it is not a plausible E.164 number. */
export function normalizeE164(v) {
  if (typeof v !== 'string') return null;
  const digits = v.replace(/[\s().-]/g, '');
  return /^\+[1-9]\d{6,14}$/.test(digits) ? digits : null;
}

/**
 * AUTOMATION_TEST_NUMBERS: comma-separated E.164 numbers, each optionally
 * followed by "=label", e.g. "+16312969723=Dev V2 Telnyx Agent,+18392741964".
 * Invalid entries are dropped (and reported by the caller).
 */
export function parseTestNumbers(raw) {
  const out = [];
  const invalid = [];
  for (const part of String(raw || '').split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    const [num, ...rest] = entry.split('=');
    const number = normalizeE164(num);
    if (!number) { invalid.push(entry); continue; }
    if (out.some((x) => x.number === number)) continue;
    out.push({ number, label: rest.join('=').trim() || null, kind: 'test' });
  }
  return { numbers: out, invalid };
}

/** "/Something/x/" ("/re/flags") is a regular expression; anything else is a case-insensitive substring. */
function pattern(v, field) {
  const s = str(v, field, { max: LIMITS.pattern, required: true });
  const m = /^\/(.+)\/([a-z]*)$/.exec(s);
  if (m) {
    if (/[^gimsuy]/.test(m[2])) throw badRequest(`${field} has unsupported regular expression flags`);
    try { new RegExp(m[1], m[2]); } catch { throw badRequest(`${field} is not a valid regular expression`); }
  }
  return s;
}

function jsonPath(v, field) {
  const s = str(v, field, { max: LIMITS.jsonPath, required: true });
  if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*|\[\d+\])*$/.test(s)) throw badRequest(`${field} must look like data.items[0].status`);
  return s;
}

// ---- assertion kinds ---------------------------------------------------------
/**
 * Reusable assertion kinds. `on` = which case types may use it; `params` normalises
 * the kind-specific fields. Evaluation lives with the executors (later phases).
 */
export const ASSERTION_KINDS = Object.freeze({
  // Conversation: what CourseRev said, checked against its own transcript after the call.
  agent_says: {
    group: 'conversation', on: ['PHONE', 'HYBRID'],
    params: (a, f) => ({ pattern: pattern(a.pattern, `${f}.pattern`), afterStep: int(a.afterStep, `${f}.afterStep`, { min: 1, max: LIMITS.steps }) }),
  },
  // API: the direct endpoint response.
  response_status: {
    group: 'api', on: ['API', 'HYBRID'],
    params: (a, f) => ({ equals: int(a.equals, `${f}.equals`, { min: 100, max: 599, required: true }) }),
  },
  json_equals: {
    group: 'api', on: ['API', 'HYBRID'],
    params: (a, f) => ({ path: jsonPath(a.path, `${f}.path`), equals: scalar(a.equals, `${f}.equals`) }),
  },
  // Booking: what CourseRev stored (negative form: expected = false).
  booking_created: {
    group: 'booking', on: ['PHONE', 'HYBRID'],
    params: (a, f) => ({ expected: bool(a.expected, `${f}.expected`, true) }),
  },
  booking_field: {
    group: 'booking', on: ['PHONE', 'HYBRID'],
    params: (a, f) => {
      if (!BOOKING_FIELDS.includes(a.field)) throw badRequest(`${f}.field must be one of ${BOOKING_FIELDS.join(', ')}`);
      return { field: a.field, equals: scalar(a.equals, `${f}.equals`) };
    },
  },
  // Tools/endpoints CourseRev called during the call (negative form: expected = false,
  // e.g. "booking endpoint must NOT be called").
  tool_called: {
    group: 'tool', on: ['PHONE', 'HYBRID'],
    params: (a, f) => ({ tool: str(a.tool, `${f}.tool`, { max: LIMITS.tool, required: true }), expected: bool(a.expected, `${f}.expected`, true) }),
  },
  // Better Stack: error-level log lines for the call.
  log_errors_max: {
    group: 'logs', on: ['PHONE', 'HYBRID'],
    params: (a, f) => ({ max: int(a.max, `${f}.max`, { min: 0, max: 10_000 }) ?? 0 }),
  },
});

function bool(v, field, dflt) {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'boolean') throw badRequest(`${field} must be true or false`);
  return v;
}

function assertions(list, type) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw badRequest('assertions must be an array');
  if (list.length > LIMITS.assertions) throw badRequest(`at most ${LIMITS.assertions} assertions`);
  return list.map((a, i) => {
    const f = `assertions[${i}]`;
    if (!isObj(a)) throw badRequest(`${f} must be an object`);
    const def = ASSERTION_KINDS[a.kind];
    if (!def) throw badRequest(`${f}.kind must be one of ${Object.keys(ASSERTION_KINDS).join(', ')}`);
    if (!def.on.includes(type)) throw badRequest(`${f}: ${a.kind} is not available for ${type} tests`);
    return { kind: a.kind, label: str(a.label, `${f}.label`, { max: LIMITS.label }) ?? a.kind, ...def.params(a, f) };
  });
}

function steps(list, type) {
  const needsSteps = type !== 'API';
  if (list === undefined || list === null) list = [];
  if (!Array.isArray(list)) throw badRequest('steps must be an array');
  if (!needsSteps && list.length) throw badRequest('API tests have no conversation steps');
  if (needsSteps && !list.length) throw badRequest(`${type} tests need at least one step`);
  if (list.length > LIMITS.steps) throw badRequest(`at most ${LIMITS.steps} steps`);
  return list.map((s, i) => {
    const f = `steps[${i}]`;
    if (!isObj(s)) throw badRequest(`${f} must be an object`);
    return { say: str(s.say, `${f}.say`, { max: LIMITS.say, required: true }), expect: str(s.expect, `${f}.expect`, { max: LIMITS.expect }) };
  });
}

function request(v, type) {
  const needs = type !== 'PHONE';
  if (v === undefined || v === null) {
    if (needs) throw badRequest(`${type} tests need a request`);
    return null;
  }
  if (!needs) throw badRequest('PHONE tests have no API request');
  if (!isObj(v)) throw badRequest('request must be an object');
  const method = String(v.method || 'POST').toUpperCase();
  if (!HTTP_METHODS.includes(method)) throw badRequest(`request.method must be one of ${HTTP_METHODS.join(', ')}`);
  const path = str(v.path, 'request.path', { max: LIMITS.path, required: true });
  // A path on the configured CourseRev API only: no scheme, host or protocol-relative URL.
  if (!path.startsWith('/') || path.startsWith('//') || /[\s\\]/.test(path) || /^\/*[a-z][a-z0-9+.-]*:/i.test(path)) {
    throw badRequest('request.path must be a path such as /v2/tool-calls/router');
  }
  let body = v.body ?? null;
  if (body !== null) {
    if (method === 'GET' || method === 'DELETE') throw badRequest(`request.body is not allowed with ${method}`);
    if (Buffer.byteLength(JSON.stringify(body)) > LIMITS.bodyBytes) throw badRequest(`request.body must be at most ${LIMITS.bodyBytes} bytes`);
    body = JSON.parse(JSON.stringify(body));
  }
  return { method, path, body };
}

// ---- suites & cases ------------------------------------------------------------
export function validateSuite(body) {
  if (!isObj(body)) throw badRequest('body must be a JSON object');
  return {
    name: str(body.name, 'name', { max: LIMITS.name, required: true }),
    description: str(body.description, 'description', { max: LIMITS.description }),
  };
}

/**
 * Validate and normalise a test case from the API.
 * @param {object} rules { testNumbers: [{number}], defaultTimeoutSec, maxTimeoutSec }
 */
export function validateCase(body, rules) {
  if (!isObj(body)) throw badRequest('body must be a JSON object');
  const type = String(body.type || '').toUpperCase();
  if (!CASE_TYPES.includes(type)) throw badRequest(`type must be one of ${CASE_TYPES.join(', ')}`);

  let targetNumber = null;
  if (type !== 'API') {
    targetNumber = normalizeE164(body.targetNumber);
    if (!targetNumber) throw badRequest(`${type} tests need targetNumber in E.164 form, e.g. +16312969723`);
    if (!rules.testNumbers.some((n) => n.number === targetNumber)) {
      throw badRequest('targetNumber is not a configured test number (AUTOMATION_TEST_NUMBERS); production numbers cannot be dialled');
    }
  } else if (body.targetNumber) {
    throw badRequest('API tests do not dial a number');
  }

  return {
    suiteId: int(body.suiteId, 'suiteId', { min: 1, max: Number.MAX_SAFE_INTEGER }),
    name: str(body.name, 'name', { max: LIMITS.name, required: true }),
    description: str(body.description, 'description', { max: LIMITS.description }),
    type,
    enabled: bool(body.enabled, 'enabled', true),
    courseId: int(body.courseId, 'courseId', { min: 1, max: Number.MAX_SAFE_INTEGER }),
    courseName: str(body.courseName, 'courseName', { max: LIMITS.courseName }),
    targetNumber,
    request: request(body.request, type),
    steps: steps(body.steps, type),
    assertions: assertions(body.assertions, type),
    timeoutSec: int(body.timeoutSec, 'timeoutSec', { min: 10, max: rules.maxTimeoutSec }) ?? rules.defaultTimeoutSec,
  };
}

/** What a run keeps of its case (everything an executor needs, nothing mutable). */
export function snapshotCase(c) {
  const { id, suiteId, suiteName, name, type, courseId, courseName, targetNumber, request: req, steps: st, assertions: as, timeoutSec, version } = c;
  return { id, suiteId, suiteName: suiteName ?? null, name, type, courseId, courseName, targetNumber, request: req, steps: st, assertions: as, timeoutSec, version };
}

/**
 * Validate an executor's result before it is stored.
 * Executors may only report passed, failed or error; the runner itself may also
 * record a timeout. "cancelled" is only ever set by the API.
 */
export function validateResult(r, { allow = ['passed', 'failed', 'error'] } = {}) {
  if (!isObj(r)) throw new Error('executor result must be an object');
  if (!allow.includes(r.status)) throw new Error(`executor status must be one of ${allow.join(', ')} (got ${r.status})`);
  const list = Array.isArray(r.assertions) ? r.assertions : [];
  return {
    status: r.status,
    error: r.error ? String(r.error).slice(0, 2_000) : null,
    telnyxCallControlId: r.telnyxCallControlId ? String(r.telnyxCallControlId).slice(0, 200) : null,
    courserevCallId: r.courserevCallId ? String(r.courserevCallId).slice(0, 200) : null,
    artifacts: isObj(r.artifacts) ? r.artifacts : null,
    assertions: list.map((a, i) => ({
      idx: i,
      kind: String(a.kind || 'custom').slice(0, 64),
      label: String(a.label || a.kind || `assertion ${i + 1}`).slice(0, LIMITS.label),
      passed: !!a.passed,
      expected: a.expected === undefined ? null : a.expected,
      actual: a.actual === undefined ? null : a.actual,
      detail: a.detail ? String(a.detail).slice(0, 2_000) : null,
    })),
  };
}
