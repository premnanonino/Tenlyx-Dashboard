import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CallsStore } from '../src/services/callsStore.js';
import { CallsSync, defaultWindows } from '../src/services/callsSync.js';
import { toCall } from '../src/providers/courserevCalls.js';
import { connect, migrate } from '../src/db/libsql.js';
import { LibsqlRepo } from '../src/persistence/libsqlRepo.js';
import { CachedSessionStore } from '../src/auth/auth.js';
import { compressJson } from '../src/api/middleware.js';
import zlib from 'node:zlib';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 11, 12);

let seq = 0;
const call = (ts, extra = {}) => {
  seq++;
  return {
    id: seq, callId: `call-${seq}`, ts, updatedAt: ts, name: `Player ${seq}`, email: `p${seq}@example.com`, phone: `+1555000${String(seq).padStart(4, '0')}`,
    coursePhone: '+15550001111', durationSec: 60 + (seq % 5) * 10, booked: seq % 4 === 0, bookingId: seq % 4 === 0 ? 900 + seq : null,
    bookingNumber: null, bookingStatus: null, bookedAt: null, teeDate: null, outcome: seq % 3 === 0 ? 'Booking created' : null,
    endReason: 'customer-ended-call', cost: 0.1, level: seq % 2 ? 'golf_course' : 'organization',
    courseId: seq % 2 ? 7 : 8, course: seq % 2 ? 'Pine Valley' : 'Oak Ridge', orgId: 3, org: 'Fairway Group', orgType: 'mco', ...extra,
  };
};

test('toCall maps a production row to the slim record', () => {
  const c = toCall({
    id: '42', call_id: 'abc', created_at: new Date(NOW), updated_at: new Date(NOW + 1000), customer_name: 'A', customer_email: '', customer_phone_no: '+1',
    vapi_golf_course_phone_no: '+2', call_length: '71.5', hasbooking: false, booking_id: '9', call_outcome: null, end_call_reason: 'x', cost: '0.12',
    config_level: 'golf_course', golf_course_id: '5', golf_course_name: 'G', org_id: '3', org_name: 'O', org_type: 'sco',
    booking_number: 'B1', booking_status: 'confirmed', booking_created_at: new Date(NOW), tee_time_date: '2026-11-12',
  });
  assert.equal(c.id, 42); assert.equal(c.ts, NOW); assert.equal(c.email, null); assert.equal(c.durationSec, 71.5);
  assert.equal(c.booked, true, 'a linked booking counts as booked'); assert.equal(c.bookingId, 9); assert.equal(c.cost, 0.12);
  assert.equal(c.courseId, 5); assert.equal(c.orgId, 3); assert.equal(c.teeDate, '2026-11-12');
  assert.ok(!('transcript' in c) && !('messages' in c), 'heavy fields are not part of the slim record');
});

test('CallsStore: time window, filters, search, paging, summary', () => {
  const s = new CallsStore();
  const calls = Array.from({ length: 50 }, (_, i) => call(NOW - i * HOUR));
  s.upsert(calls.map((c) => ({ data: c, syncedAt: c.ts })));
  assert.equal(s.size, 50);

  const all = s.query({ from: NOW - 100 * HOUR, page: 1, limit: 10 });
  assert.equal(all.total, 50); assert.equal(all.pages, 5);
  assert.equal(all.rows[0].ts, NOW, 'newest first');
  assert.ok(!('_q' in all.rows[0]), 'internal search field is not exposed');

  const day = s.query({ from: NOW - 24 * HOUR + 1, to: NOW + 1 });
  assert.equal(day.total, 24, 'from inclusive, to exclusive');
  assert.equal(s.query({ from: NOW - 2 * HOUR, to: NOW - HOUR }).total, 1);

  assert.equal(s.query({ courseId: 7 }).total, 25);
  assert.equal(s.query({ booked: true }).total, calls.filter((c) => c.booked).length);
  assert.equal(s.query({ outcome: 'none' }).total, calls.filter((c) => !c.outcome).length);
  assert.equal(s.query({ level: 'organization', courseId: 8 }).total, 25);
  assert.equal(s.query({ q: calls[10].email.toUpperCase() }).total, 1, 'email search is case-insensitive');
  assert.equal(s.query({ q: calls[11].callId }).rows[0].callId, calls[11].callId);
  assert.equal(s.query({ q: `(555) 000-${calls[12].phone.slice(-4)}` }).total, 1, 'phone search ignores formatting');
  assert.equal(s.query({ q: 'oak ridge' }).total, 25, 'course name search');

  const p5 = s.query({ page: 5, limit: 10 });
  assert.equal(p5.rows.length, 10); assert.equal(p5.rows[9].ts, NOW - 49 * HOUR);
  const sum = s.query({});
  assert.ok(Math.abs(sum.summary.conversion - calls.filter((c) => c.booked).length / 50) < 1e-9);
});

test('CallsStore: updates replace, facets count, eviction', () => {
  const s = new CallsStore({ retentionMs: 10 * DAY });
  const a = call(NOW); const b = call(NOW - 20 * DAY);
  s.upsert([{ data: a, syncedAt: 1 }, { data: b, syncedAt: 2 }]);
  assert.equal(s.lastSyncedAt, 2);
  const v = s.version;
  s.upsert([{ data: { ...a, outcome: 'Booking created', booked: true }, syncedAt: 3 }]);
  assert.ok(s.version > v);
  assert.equal(s.get(a.callId).outcome, 'Booking created');
  const f = s.facets();
  assert.equal(f.total, 2);
  assert.ok(f.courses.length >= 1 && f.outcomes.find((o) => o.id === 'Booking created'));
  assert.equal(s.evict(NOW), 1, 'calls older than the retention window are dropped');
  assert.equal(s.get(b.callId), null);
});

/** Fake CourseRev source over an array, with the same keyset semantics as the SQL. */
function fakeSource(rows) {
  const src = {
    rows, pages: 0,
    async page({ from, to, afterTs = null, afterId = 0, limit }) {
      src.pages++;
      const aT = afterTs ?? from - 1;
      return src.rows
        .filter((c) => c.ts >= from && c.ts < to && (c.ts > aT || (c.ts === aT && c.id > afterId)))
        .sort((x, y) => x.ts - y.ts || x.id - y.id)
        .slice(0, limit)
        .map((c) => ({ ...c }));
    },
  };
  return src;
}

/** Fake repo with the dashboard DB semantics: changed-only upserts, kv. */
function fakeRepo() {
  const r = {
    kv: new Map(), calls: new Map(), writes: 0,
    async getKv(k) { return r.kv.has(k) ? JSON.parse(r.kv.get(k)) : null; },
    async setKv(k, v) { r.kv.set(k, JSON.stringify(v)); },
    async upsertCalls(list) {
      let n = 0;
      for (const c of list) { const j = JSON.stringify(c); if (r.calls.get(c.callId) !== j) { r.calls.set(c.callId, j); n++; } }
      r.writes += n;
      return n;
    },
    async pruneCalls(before) { let n = 0; for (const [k, j] of r.calls) if (JSON.parse(j).ts < before) { r.calls.delete(k); n++; } return n; },
  };
  return r;
}

test('CallsSync: first run loads 90 days in batches, resumable after restart', async () => {
  const rows = Array.from({ length: 95 }, (_, i) => call(NOW - i * DAY - 5 * MIN)); // 95 days back
  const src = fakeSource(rows);
  const repo = fakeRepo();
  const sync = new CallsSync({ source: src, repo, historyDays: 90, batch: 10 });
  for (let i = 0; i < 4; i++) await sync.tick(NOW);
  // Restart mid-backfill: a new instance resumes from the saved cursor.
  const sync2 = new CallsSync({ source: src, repo, historyDays: 90, batch: 10 });
  let ticks = 0;
  while (await sync2.tick(NOW) && ticks < 100) ticks++;
  const inWindow = rows.filter((c) => c.ts >= NOW - 90 * DAY).length;
  assert.equal(repo.calls.size, inWindow, 'every call of the last 90 days copied exactly once');
  assert.ok(sync2.progress().backfillDone);
});

test('CallsSync: short windows run first, unchanged rows are not rewritten, changes are picked up', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => call(NOW - i * 4 * HOUR));
  const src = fakeSource(rows);
  const repo = fakeRepo();
  const sync = new CallsSync({ source: src, repo, historyDays: 90, batch: 5 });
  await sync.tick(NOW);
  assert.equal(sync.state.sweeps[0].window, '24h', 'after the 2h window, the 24h window is next, before the 90-day sweep');
  while (await sync.tick(NOW));
  const writesAfterLoad = repo.writes;

  // A minute later only the 2h window is due; nothing changed, so nothing is written.
  while (await sync.tick(NOW + MIN + 1));
  assert.equal(repo.writes, writesAfterLoad);

  // A call gets its outcome 30 min after it started: the 2h window picks it up.
  rows[0].outcome = 'Booking created'; rows[0].updatedAt = NOW + 30 * MIN;
  while (await sync.tick(NOW + 2 * MIN + 2));
  assert.equal(repo.writes, writesAfterLoad + 1);
  assert.equal(JSON.parse(repo.calls.get(rows[0].callId)).outcome, 'Booking created');
});

test('CallsSync: windows follow their schedule', () => {
  const w = defaultWindows(90);
  assert.deepEqual(w.map((x) => [x.name, x.spanMs, x.everyMs]), [
    ['2h', 2 * HOUR, MIN], ['24h', DAY, 15 * MIN], ['7d', 7 * DAY, DAY], ['full', 90 * DAY, 7 * DAY],
  ]);
});

test('libsql calls table: changed-only upsert, change feed, keyset load, prune', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlxmon-calls-'));
  const client = await connect({ url: `file:${path.join(dir, 'c.db')}` }, { attempts: 1 });
  t.after(() => { client.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await migrate(client);
  const repo = new LibsqlRepo({ client });

  const list = Array.from({ length: 12 }, (_, i) => call(NOW - i * HOUR));
  assert.equal(await repo.upsertCalls(list), 12);
  assert.equal(await repo.upsertCalls(list), 0, 'unchanged rows are not rewritten');
  const changed = { ...list[3], outcome: 'Rates information' };
  await new Promise((r) => setTimeout(r, 5)); // keep the initial inserts strictly before the mark
  const mark = Date.now();
  await new Promise((r) => setTimeout(r, 2));
  assert.equal(await repo.upsertCalls([changed, list[4]]), 1);

  const feed = await repo.callsChangedSince(mark);
  assert.deepEqual(feed.map((x) => x.data.callId), [changed.callId]);
  assert.equal(feed[0].data.outcome, 'Rates information');

  const page1 = await repo.loadCalls(NOW - 100 * HOUR, { limit: 5 });
  const last = page1.at(-1).data;
  const page2 = await repo.loadCalls(NOW - 100 * HOUR, { afterTs: last.ts, afterId: last.callId, limit: 50 });
  assert.equal(page1.length + page2.length, 12);
  assert.ok(page1[0].data.ts <= page2[0].data.ts, 'oldest first, keyset continues');

  // Newest first (API hydration): pages backwards, no overlap, no gaps.
  const n1 = await repo.loadCalls(NOW - 100 * HOUR, { limit: 5, newestFirst: true });
  const lastN = n1.at(-1).data;
  const n2 = await repo.loadCalls(NOW - 100 * HOUR, { afterTs: lastN.ts, afterId: lastN.callId, limit: 50, newestFirst: true });
  assert.equal(n1[0].data.ts, NOW, 'newest call first');
  assert.equal(new Set([...n1, ...n2].map((x) => x.data.callId)).size, 12);
  assert.ok(n2.every((x) => x.data.ts <= lastN.ts));

  assert.equal(await repo.pruneCalls(NOW - 5.5 * HOUR), 6);
  assert.equal((await repo.loadCalls(0)).length, 6);
});

test('CallsStore: outcome breakdown, transfer rate and time series in the same pass', () => {
  const s = new CallsStore();
  const list = Array.from({ length: 48 }, (_, i) => call(NOW - i * HOUR - 1, { endReason: i % 2 ? 'assistant-forwarded-call' : 'customer-ended-call' }));
  s.upsert(list.map((c) => ({ data: c })));
  const r = s.query({ from: NOW - 24 * HOUR, to: NOW });
  assert.equal(r.total, 24);
  assert.equal(r.series.stepMs, HOUR, 'hourly buckets for ranges up to 2 days');
  assert.equal(r.series.points.reduce((a, p) => a + p.total, 0), 24, 'every call lands in one bucket');
  assert.equal(r.series.points.reduce((a, p) => a + p.booked, 0), r.summary.booked);
  assert.equal(r.outcomes.reduce((a, o) => a + o.count, 0), 24);
  assert.ok(Math.abs(r.summary.transferRate - r.summary.transferred / 24) < 1e-9 && r.summary.transferred === 12);
  assert.equal(s.query({ from: NOW - 30 * DAY, to: NOW }).series.stepMs, DAY, 'daily buckets for longer ranges');
});

test('CachedSessionStore: serves from memory within the TTL, sign-out clears it, expiry respected', async () => {
  const db = new Map(); let reads = 0;
  const inner = {
    async create(email) { const id = `s${db.size + 1}`; db.set(id, { email, expiresAt: Date.now() + 60_000 }); return id; },
    async get(id) { reads++; return db.get(id) ?? null; },
    async destroy(id) { db.delete(id); },
    async sweep() {}, async count() { return db.size; },
  };
  const s = new CachedSessionStore(inner, { ttlMs: 50 });
  const id = await s.create('a@courserev.ai');
  assert.equal((await s.get(id)).email, 'a@courserev.ai');
  await s.get(id); await s.get(id);
  assert.equal(reads, 1, 'repeat checks within the TTL do not hit the database');
  await new Promise((r) => setTimeout(r, 60));
  await s.get(id);
  assert.equal(reads, 2, 're-checked after the TTL');
  await s.destroy(id);
  assert.equal(await s.get(id), null, 'sign-out takes effect immediately on this server');
  db.set('x', { email: 'b@courserev.ai', expiresAt: Date.now() + 5 });
  assert.ok(await s.get('x'));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await s.get('x')).email, 'b@courserev.ai', 'expired in cache -> asks the database again');
  assert.equal(reads, 5, "first check, after TTL, after sign-out, and twice for the expiring session");
  assert.equal(await s.get(null), null);
});

test('compressJson: gzips large JSON for gzip clients only', () => {
  const run = (body, accept) => {
    const sent = {}; const headers = {};
    const res = {
      json: (b) => { sent.plain = b; },
      vary: (h) => { headers.vary = h; },
      set: (h) => Object.assign(headers, h),
      send: (buf) => { sent.buf = buf; },
    };
    compressJson()({ headers: { 'accept-encoding': accept } }, res, () => {});
    res.json(body);
    return { sent, headers };
  };
  const big = { rows: Array.from({ length: 200 }, (_, i) => ({ i, name: `row ${i}` })) };
  const a = run(big, 'gzip, deflate, br');
  assert.equal(a.headers['content-encoding'], 'gzip');
  assert.deepEqual(JSON.parse(zlib.gunzipSync(a.sent.buf)), big);
  assert.ok(a.sent.buf.length < JSON.stringify(big).length / 3);
  assert.deepEqual(run({ ok: true }, 'gzip').sent.plain, { ok: true }, 'small bodies are sent as is');
  assert.ok(run(big, '').sent.plain, 'clients without gzip get plain JSON');
});
