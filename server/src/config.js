import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env from server/ or the repo root (Node >= 20.12 ships loadEnvFile).
for (const p of [path.join(serverRoot, '.env'), path.join(serverRoot, '..', '.env')]) {
  if (fs.existsSync(p) && typeof process.loadEnvFile === 'function') {
    try { process.loadEnvFile(p); } catch { /* malformed .env is ignored */ }
  }
}

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const list = (v, d) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : d);

const apiKey = process.env.TELNYX_API_KEY || '';

export const config = Object.freeze({
  serverRoot,
  port: num(process.env.PORT, 8787),
  mode: 'live',
  telnyx: Object.freeze({
    apiKey,
    baseUrl: process.env.TELNYX_BASE_URL || 'https://api.telnyx.com/v2',
    recordTypes: list(process.env.TELNYX_RECORD_TYPES, ['messaging', 'call-control', 'sip-trunking']),
    aiRecordTypes: list(process.env.TELNYX_AI_RECORD_TYPES, ['ai-voice-assistant']),
    backfillDays: num(process.env.TELNYX_BACKFILL_DAYS, 7),
    maxPages: num(process.env.TELNYX_MAX_PAGES, 200), // per time window
    pageSize: 50, // /detail_records caps page[size] at 50
    timeoutMs: num(process.env.TELNYX_TIMEOUT_MS, 10_000),
    outboundRps: num(process.env.TELNYX_RPS, 5),
  }),
  poll: Object.freeze({
    balanceMs: num(process.env.POLL_BALANCE_MS, 30_000),
    recordsMs: num(process.env.POLL_RECORDS_MS, 60_000),
    groupsMs: num(process.env.POLL_GROUPS_MS, 10 * 60_000),
    overlapMs: num(process.env.POLL_OVERLAP_MS, 30 * 60_000), // re-read window: call legs land only after hang-up
  }),
  retentionDays: 35,
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
    email: (process.env.ADMIN_EMAIL || '').trim(),
    passwordHash: process.env.ADMIN_PASSWORD_HASH || '',
    sessionTtlMs: num(process.env.SESSION_TTL_HOURS, 12) * 3_600_000,
    secureCookie: process.env.COOKIE_SECURE === '1',
    // Extra origins allowed to send POST/PUT (e.g. a reverse proxy's public URL).
    allowedOrigins: list(process.env.ALLOWED_ORIGINS, []),
  }),
  cache: Object.freeze({ capacity: 500, ttlMs: 15_000 }),
  rateLimit: Object.freeze({ capacity: 120, refillPerSec: 30 }),
});
