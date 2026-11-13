import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTestNumbers } from './services/automation.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env from server/ or the repo root (Node >= 20.12 ships loadEnvFile).
for (const p of [path.join(serverRoot, '.env'), path.join(serverRoot, '..', '.env')]) {
  if (fs.existsSync(p) && typeof process.loadEnvFile === 'function') {
    try { process.loadEnvFile(p); } catch { /* malformed .env is ignored */ }
  }
}

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const list = (v, d) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : d);

/**
 * A secret from NAME, or from the file named by NAME_FILE (Docker secrets
 * mount files under /run/secrets). The file form keeps secrets out of
 * `docker inspect` and process listings.
 */
function secret(name) {
  if (process.env[name]) return process.env[name];
  const file = process.env[`${name}_FILE`];
  if (!file) return '';
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

const apiKey = secret('TELNYX_API_KEY');
const testNumbers = parseTestNumbers(process.env.AUTOMATION_TEST_NUMBERS);

// all    = API + sync in one process, in memory (local development, default)
// api    = dashboard API only; reads PostgreSQL, never talks to Telnyx
// worker = Telnyx sync only; writes PostgreSQL, serves no HTTP
const role = ['all', 'api', 'worker'].includes(process.env.APP_ROLE) ? process.env.APP_ROLE : 'all';

// PostgreSQL: DATABASE_URL, or the standard PG* variables (PGPASSWORD_FILE supported).
const dbUrl = secret('DATABASE_URL');
const db = dbUrl
  ? { connectionString: dbUrl }
  : process.env.PGHOST
    ? { host: process.env.PGHOST, port: num(process.env.PGPORT, 5432), user: process.env.PGUSER, database: process.env.PGDATABASE, password: secret('PGPASSWORD') }
    : null;

// Database backend: postgres (default, unchanged) or libsql — a local SQLite
// file (LIBSQL_URL=file:./data/tlxmon.db) or Turso (TURSO_DATABASE_URL +
// TURSO_AUTH_TOKEN). "turso" is accepted as an alias for libsql.
const backendName = (process.env.DATABASE_BACKEND || 'postgres').trim().toLowerCase();
const backend = backendName === 'turso' ? 'libsql' : backendName;
if (!['postgres', 'libsql'].includes(backend)) {
  throw new Error(`DATABASE_BACKEND must be postgres, libsql or turso (got "${backendName}")`);
}
const libsqlUrl = secret('LIBSQL_URL') || secret('TURSO_DATABASE_URL');
const database = backend === 'libsql'
  ? (libsqlUrl ? Object.freeze({ backend, url: libsqlUrl, authToken: secret('TURSO_AUTH_TOKEN') || undefined }) : null)
  : (db ? Object.freeze({ backend }) : null);

export const config = Object.freeze({
  serverRoot,
  port: num(process.env.PORT, 8787),
  mode: 'live',
  role,
  // PostgreSQL connection settings (only when DATABASE_BACKEND=postgres).
  db: db && backend === 'postgres' ? Object.freeze({ ...db, max: num(process.env.PG_POOL_MAX, 5) }) : null,
  // Which database is configured, if any: { backend: 'postgres' } or { backend: 'libsql', url, authToken }.
  database,
  // Express "trust proxy": which hops may set X-Forwarded-For (Caddy in Docker = private network).
  trustProxy: process.env.TRUST_PROXY || 'loopback',
  worker: Object.freeze({
    heartbeatMs: 15_000,
    staleAfterMs: num(process.env.WORKER_STALE_MS, 3 * 60_000), // healthcheck threshold
    syncRequestCooldownMs: num(process.env.SYNC_REQUEST_COOLDOWN_MS, 60_000),
    reportsEveryMs: num(process.env.REPORTS_EVERY_MS, 5 * 60_000),
  }),
  telnyx: Object.freeze({
    apiKey,
    baseUrl: process.env.TELNYX_BASE_URL || 'https://api.telnyx.com/v2',
    recordTypes: list(process.env.TELNYX_RECORD_TYPES, ['messaging', 'call-control', 'sip-trunking']),
    aiRecordTypes: list(process.env.TELNYX_AI_RECORD_TYPES, ['ai-voice-assistant']),
    backfillDays: num(process.env.TELNYX_BACKFILL_DAYS, 7),
    maxPages: num(process.env.TELNYX_MAX_PAGES, 200), // per time window
    pageSize: 50, // /detail_records caps page[size] at 50
    timeoutMs: num(process.env.TELNYX_TIMEOUT_MS, 10_000),
    // Ceiling for the adaptive pacer; it starts lower and halves on every 429.
    outboundRps: num(process.env.TELNYX_RPS, 2),
  }),
  poll: Object.freeze({
    balanceMs: num(process.env.POLL_BALANCE_MS, 30_000),
    recordsMs: num(process.env.POLL_RECORDS_MS, 60_000),
    groupsMs: num(process.env.POLL_GROUPS_MS, 10 * 60_000),
    overlapMs: num(process.env.POLL_OVERLAP_MS, 30 * 60_000), // re-read window: call legs land only after hang-up
  }),
  sync: Object.freeze({
    liveHeadMs: num(process.env.SYNC_LIVE_HEAD_MS, 60 * 60_000), // cold start: newest hour first
    chunkMs: num(process.env.SYNC_CHUNK_MS, 60 * 60_000),        // backfill step size
  }),
  retentionDays: 35,
  // Call History: read-only copy of CourseRev's call history (conversations).
  // Unset URL = feature off. Use a READ-ONLY database user.
  calls: Object.freeze({
    url: secret('CR_DATABASE_URL') || secret('COURSEREV_DATABASE_URL'),
    historyDays: num(process.env.CALLS_HISTORY_DAYS, 90),
    batch: num(process.env.CALLS_BATCH, 1_000),     // rows per production query
    tickMs: num(process.env.CALLS_TICK_MS, 2_000),  // at most one batch per tick
    // Repeat callers: internal/test callers are hidden by default (email domain or number list).
    internalDomains: list(process.env.CALLS_INTERNAL_DOMAINS, ['courserev.ai']),
    internalNumbers: list(process.env.CALLS_INTERNAL_NUMBERS, []),
    highVolumePerDay: num(process.env.CALLS_HIGH_VOLUME_PER_DAY, 20), // flag likely test lines / dialers
  }),
  // Call Automation: needs a database. Only numbers on AUTOMATION_TEST_NUMBERS can
  // ever be dialled ("+E164=label,..."); production numbers are rejected server-side.
  automation: Object.freeze({
    testNumbers: Object.freeze(testNumbers.numbers.map((n) => Object.freeze(n))),
    invalidTestNumbers: Object.freeze(testNumbers.invalid),
    defaultTimeoutSec: num(process.env.AUTOMATION_RUN_TIMEOUT_SEC, 300),
    maxTimeoutSec: num(process.env.AUTOMATION_MAX_RUN_TIMEOUT_SEC, 900),
    concurrency: Math.max(1, num(process.env.AUTOMATION_CONCURRENCY, 1)),
    maxActiveRuns: num(process.env.AUTOMATION_MAX_ACTIVE_RUNS, 100), // queued + running, across everyone
    maxRunsPerRequest: 50,
    queueTimeoutMs: num(process.env.AUTOMATION_QUEUE_TIMEOUT_MIN, 60) * 60_000, // queued this long = no worker
    tickMs: 2_000,
  }),
  reports: Object.freeze({
    file: process.env.REPORTS_FILE || path.join(serverRoot, 'data', 'rollups.json'),
    historyMonths: num(process.env.REPORT_HISTORY_MONTHS, 3),
    flushMs: 30_000,
  }),
  alerts: Object.freeze({
    lowBalance: num(process.env.ALERT_LOW_BALANCE, 250),
    runwayDays: num(process.env.ALERT_RUNWAY_DAYS, 7),
    spikeZ: num(process.env.ALERT_SPIKE_Z, 3),
    staleFactor: 5,
  }),
  auth: Object.freeze({
    // Anyone with an address on this domain can sign in with the shared password.
    emailDomain: (process.env.LOGIN_EMAIL_DOMAIN || 'courserev.ai').trim().toLowerCase().replace(/^@/, ''),
    // scrypt hash of the one shared password (ADMIN_PASSWORD_HASH accepted for older .env files).
    passwordHash: secret('SHARED_PASSWORD_HASH') || process.env.ADMIN_PASSWORD_HASH || '',
    sessionTtlMs: num(process.env.SESSION_TTL_HOURS, 12) * 3_600_000,
    secureCookie: process.env.COOKIE_SECURE === '1',
    // Extra origins allowed to send POST/PUT (e.g. a reverse proxy's public URL).
    allowedOrigins: list(process.env.ALLOWED_ORIGINS, []),
  }),
  cache: Object.freeze({ capacity: 500, ttlMs: 15_000 }),
  rateLimit: Object.freeze({ capacity: 120, refillPerSec: 30 }),
});
