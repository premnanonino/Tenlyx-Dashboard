/**
 * libSQL backend against a local `file:` database (no network, no Turso).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, migrate, acquireLease } from '../src/db/libsql.js';
import { openDatabase } from '../src/db/index.js';
import { LibsqlRepo } from '../src/persistence/libsqlRepo.js';
import { PgRepo } from '../src/persistence/pgRepo.js';
import { LibsqlSessionStore, PgSessionStore } from '../src/auth/auth.js';
import { reportScenario, rec, series } from './helpers/reportScenario.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fresh, migrated database file per test; removed afterwards. */
async function fresh(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlxmon-libsql-'));
  const url = `file:${path.join(dir, 'test.db')}`;
  const client = await connect({ url }, { attempts: 1 });
  await migrate(client);
  t.after(() => { client.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { client, url, repo: new LibsqlRepo({ client }) };
}

const methods = (cls) => Object.getOwnPropertyNames(cls.prototype).filter((m) => m !== 'constructor').sort();

test('libsql: repository and session store expose the same methods as the PostgreSQL ones', () => {
  assert.deepEqual(methods(LibsqlRepo), methods(PgRepo));
  assert.deepEqual(methods(LibsqlSessionStore), methods(PgSessionStore));
});

test('libsql: migrations are idempotent', async (t) => {
  const { client } = await fresh(t);
  await migrate(client);
  await migrate(client);
  const rs = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  assert.deepEqual(rs.rows.map((r) => r.name), [
    'automation_cases', 'automation_run_assertions', 'automation_runs', 'automation_suites',
    'balance_snapshots', 'billing_records', 'calls', 'kv', 'rollup_months', 'sessions', 'sync_events', 'sync_requests',
  ]);
});

test('libsql: billing records insert and read back intact', async (t) => {
  const { repo } = await fresh(t);
  const r = { ...rec(Date.UTC(2026, 10, 1, 9), 0.0123), _tokens: ['x'], ai: { model: 'm', channel: 'voice', latencyMs: 300 } };
  const added = await repo.insertRecords([r]);
  assert.deepEqual(added.map((x) => x.id), [r.id]);
  assert.equal(await repo.recordCount(), 1);
  const [row] = await repo.recordsAfter(0);
  const { _tokens, ...expected } = r; // _tokens are never stored
  assert.deepEqual(row.data, expected);
  assert.equal(typeof row.seq, 'number');
});

test('libsql: duplicate records are ignored, within and across batches', async (t) => {
  const { repo } = await fresh(t);
  const a = rec(Date.UTC(2026, 10, 1)); const b = rec(Date.UTC(2026, 10, 2));
  assert.equal((await repo.insertRecords([a, a, b])).length, 2);
  assert.equal((await repo.insertRecords([a, b])).length, 0);
  const c = rec(Date.UTC(2026, 10, 3));
  assert.deepEqual((await repo.insertRecords([b, c])).map((x) => x.id), [c.id]);
  assert.equal(await repo.recordCount(), 3);
  // Large batch spanning several INSERT statements in one transaction.
  const many = series(Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1)).concat(series(Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 2)));
  const firstMany = (await repo.insertRecords(many)).length;
  assert.equal(firstMany, new Set(many.map((x) => x.id)).size);
});

test('libsql: seq is the insertion order, filters by ts, and is never reused', async (t) => {
  const { repo, client } = await fresh(t);
  await repo.insertRecords([rec(Date.UTC(2026, 10, 5)), rec(Date.UTC(2026, 10, 1))]);
  await repo.insertRecords([rec(Date.UTC(2026, 10, 3))]);
  const all = await repo.recordsAfter(0);
  assert.deepEqual(all.map((x) => x.seq), [1, 2, 3]);
  assert.deepEqual((await repo.recordsAfter(2)).map((x) => x.seq), [3]);
  assert.equal((await repo.recordsAfter(0, { sinceTs: Date.UTC(2026, 10, 2) })).length, 2);
  assert.equal((await repo.recordsAfter(0, { limit: 2 })).length, 2);
  // Deleting the newest row must not let a new insert reuse its seq (the API and reports cursors rely on it).
  await client.execute('DELETE FROM billing_records WHERE seq = 3');
  await repo.insertRecords([rec(Date.UTC(2026, 10, 4))]);
  assert.equal((await repo.recordsAfter(2))[0].seq, 4);
  const w = await repo.watermarks();
  assert.equal(w.seq, 4);
  assert.equal(w.minTs, Date.UTC(2026, 10, 1));
});

test('libsql: balance snapshots', async (t) => {
  const { repo } = await fresh(t);
  const b = (ts, balance) => ({ ts, balance, availableCredit: balance, creditLimit: 0, pending: 0, currency: 'USD' });
  for (const x of [b(3000, 3), b(1000, 1), b(2000, 2), b(2000, 99)]) await repo.insertBalance(x);
  assert.deepEqual((await repo.latestBalances()).map((x) => x.balance), [1, 2, 3], 'oldest first, duplicate ts ignored');
  assert.deepEqual((await repo.latestBalances(2)).map((x) => x.balance), [2, 3]);
  assert.deepEqual((await repo.balancesAfter(1000)).map((x) => x.ts), [2000, 3000]);
  assert.deepEqual((await repo.balancesBetween(1000, 3000)).map((x) => x.ts), [1000, 2000]);
  assert.deepEqual((await repo.balancesBetween(0, 9000, 2000)).map((x) => x.ts), [1000, 2000]);
});

test('libsql: kv documents, sync requests and events', async (t) => {
  const { repo } = await fresh(t);
  assert.equal(await repo.getKv('nope'), null);
  await repo.setKv('sync_status', { heartbeatAt: 5, nested: { a: [1, 2] } });
  await repo.setKv('sync_status', { heartbeatAt: 6 });
  assert.deepEqual(await repo.getKv('sync_status'), { heartbeatAt: 6 });

  assert.deepEqual(await repo.requestSync('a@x.co', 60_000), { queued: true, retryInMs: 0 });
  assert.equal((await repo.requestSync('a@x.co', 60_000)).pending, true);
  assert.equal(await repo.claimSyncRequests(), true);
  assert.equal(await repo.claimSyncRequests(), false);
  assert.equal((await repo.requestSync('a@x.co', 60_000)).queued, false, 'cooldown');

  await repo.logEvent('warn', 'records', 'telnyx 429');
  await repo.logEvent('error', null, 'x'.repeat(900));
  const ev = await repo.recentEvents(5);
  assert.equal(ev.length, 2);
  assert.equal(ev[0].message.length, 500);
  assert.equal(ev[1].lane, 'records');
  assert.ok(Math.abs(ev[1].at - Date.now()) < 10_000);
});

test('libsql: monthly summaries, cursor and finalized months', async (t) => {
  const { repo } = await fresh(t);
  await repo.saveRollups([{ month: '2026-10', data: { count: 2, cost: 1.5 }, count: 2 }], { seq: 7, balanceTs: 9, rebuiltAt: 1 });
  assert.deepEqual(await repo.getKv('rollup_cursor'), { seq: 7, balanceTs: 9, rebuiltAt: 1 });
  let [m] = await repo.loadRollupState();
  assert.deepEqual(m, { month: '2026-10', data: { count: 2, cost: 1.5 }, finalizedAt: null });
  const [built] = await repo.loadRollups(0);
  assert.ok(built.builtAt > 0);
  assert.equal((await repo.loadRollups(built.builtAt)).length, 0, 'API only reloads months rebuilt since');

  assert.equal(await repo.finalizeMonth('2026-10'), true);
  assert.equal(await repo.finalizeMonth('2026-10'), false);
  await repo.saveRollups([{ month: '2026-10', data: { count: 1 }, count: 1 }, { month: '2026-11', data: { count: 3 }, count: 3 }], { seq: 8, balanceTs: 9, rebuiltAt: 1 });
  const state = Object.fromEntries((await repo.loadRollupState()).map((r) => [r.month, r]));
  assert.deepEqual(state['2026-10'].data, { count: 2, cost: 1.5 }, 'finalized month is never overwritten');
  assert.ok(state['2026-10'].finalizedAt > 0);
  assert.deepEqual(state['2026-11'].data, { count: 3 });
  assert.equal((await repo.getKv('rollup_cursor')).seq, 8);
});

test('libsql: retention deletes only counted rows older than the cutoff', async (t) => {
  const { repo } = await fresh(t);
  await repo.insertRecords(series(Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 11))); // 40 rows, seq 1..40
  const cutoff = Date.UTC(2026, 9, 6);
  assert.equal(await repo.pruneRecords(cutoff, 10), 10, 'seq bound respected');
  assert.equal(await repo.pruneRecords(cutoff, 1_000, 3), 10, 'remaining older rows, in batches of 3');
  const left = await repo.recordsAfter(0);
  assert.ok(left.every((x) => x.data.ts >= cutoff));
  assert.equal(left.length, 20);

  for (let ts = 1000; ts <= 5000; ts += 1000) await repo.insertBalance({ ts, balance: ts });
  assert.equal(await repo.pruneBalances(4000, 2000), 2);
  assert.equal(await repo.pruneBalances(4000, 9000), 1);
  assert.deepEqual((await repo.latestBalances()).map((b) => b.ts), [4000, 5000]);
});

test('libsql: ReportBuilder (unchanged) runs incrementally, finalizes and prunes', async (t) => {
  const { repo, client } = await fresh(t);
  await reportScenario({
    repo,
    countOlder: async (table, cutoff) => Number((await client.execute({ sql: `SELECT count(*) AS n FROM ${table} WHERE ts < ?`, args: [cutoff] })).rows[0].n),
  });
});

test('libsql lease: one holder at a time, renewal, expiry takeover, release', async (t) => {
  const { url } = await fresh(t);
  // Two "workers" = two separate connections to the same database file.
  const c1 = await connect({ url }, { attempts: 1 });
  const c2 = await connect({ url }, { attempts: 1 });
  t.after(() => { c1.close(); c2.close(); });

  const a = await acquireLease(c1, 'worker', { ttlMs: 400, holder: 'A' });
  assert.ok(a, 'A acquires');
  assert.equal(await acquireLease(c2, 'worker', { ttlMs: 400, holder: 'B' }), null, 'B cannot while A is live');

  // Renewal keeps it alive past the original expiry.
  for (let i = 0; i < 4; i++) { await sleep(150); assert.equal(await a.renew(), true); }
  assert.equal(await acquireLease(c2, 'worker', { ttlMs: 400, holder: 'B' }), null, 'still held after renewals');

  // A "dies" (stops renewing): after the TTL, B takes over and A can no longer renew.
  await sleep(500);
  const b = await acquireLease(c2, 'worker', { ttlMs: 400, holder: 'B' });
  assert.ok(b, 'B takes over the expired lease');
  assert.equal(await a.renew(), false, 'A learns it lost the lease');
  assert.equal(await acquireLease(c1, 'worker', { ttlMs: 400, holder: 'A' }), null);

  // Release frees it immediately, and only the holder can release.
  await a.release(); // not the holder: no effect
  assert.equal(await acquireLease(c1, 'worker', { ttlMs: 400, holder: 'A' }), null);
  await b.release();
  assert.ok(await acquireLease(c1, 'worker', { ttlMs: 400, holder: 'A' }), 'free after release');
});

test('libsql lease: concurrent acquirers, exactly one wins', async (t) => {
  const { url } = await fresh(t);
  const clients = await Promise.all([1, 2, 3, 4, 5].map(() => connect({ url }, { attempts: 1 })));
  t.after(() => clients.forEach((c) => c.close()));
  const got = await Promise.all(clients.map((c, i) => acquireLease(c, 'worker', { ttlMs: 10_000, holder: `w${i}` })));
  assert.equal(got.filter(Boolean).length, 1);
});

test('libsql lease: a renewal error keeps the lease only until it would have expired', async (t) => {
  const { client } = await fresh(t);
  const lease = await acquireLease(client, 'worker', { ttlMs: 300, holder: 'A' });
  const broken = { execute: async () => { throw new Error('network down'); } };
  const flaky = await acquireLease({ execute: async (q) => client.execute(q) }, 'other', { ttlMs: 300, holder: 'A' });
  assert.ok(lease && flaky);
  // Swap in a failing connection: still valid right away, invalid after the TTL.
  const orig = client.execute.bind(client);
  client.execute = broken.execute;
  try {
    assert.equal(await lease.renew(), true);
    const until = lease.validUntil();
    assert.ok(until > Date.now() && until <= Date.now() + 300, 'validUntil not extended by a failed renewal');
    await sleep(350);
    assert.equal(await lease.renew(), false);
  } finally {
    client.execute = orig;
  }
});

test('libsql sessions: create, get, sliding expiry, destroy, sweep, count', async (t) => {
  const { client } = await fresh(t);
  const s = new LibsqlSessionStore({ client, ttlMs: 10 * 60_000 });
  const id = await s.create('a@courserev.ai');
  const got = await s.get(id);
  assert.equal(got.email, 'a@courserev.ai');
  assert.ok(got.expiresAt > Date.now() + 9 * 60_000);
  assert.equal(await s.get('wrong'), null);
  assert.equal(await s.get(null), null);
  assert.equal(await s.count(), 1);

  // Only a hash of the cookie value is stored.
  const raw = await client.execute('SELECT id_hash FROM sessions');
  assert.notEqual(raw.rows[0].id_hash, id);
  assert.equal(raw.rows[0].id_hash.length, 64);

  // Sliding expiry: a session with little time left is extended on use.
  await client.execute({ sql: 'UPDATE sessions SET expires_at = ?', args: [Date.now() + 60_000] });
  await s.get(id);
  const after = Number((await client.execute('SELECT expires_at FROM sessions')).rows[0].expires_at);
  assert.ok(after > Date.now() + 9 * 60_000, 'extended');

  await s.destroy(id);
  assert.equal(await s.get(id), null);

  const short = new LibsqlSessionStore({ client, ttlMs: 50 });
  const id2 = await short.create('b@courserev.ai');
  await sleep(80);
  assert.equal(await short.get(id2), null, 'expired');
  assert.equal(await short.count(), 0);
  await short.sweep();
  assert.equal(Number((await client.execute('SELECT count(*) AS n FROM sessions')).rows[0].n), 0, 'swept');
});

test('libsql: openDatabase wires repo, sessions and lease from config', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlxmon-libsql-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const url = `file:${path.join(dir, 'nested', 'app.db')}`; // parent directory is created
  const db = await openDatabase({ database: { backend: 'libsql', url } });
  try {
    assert.equal(db.backend, 'libsql');
    assert.ok(db.repo instanceof LibsqlRepo);
    assert.ok(db.sessionStore(1000).inner instanceof LibsqlSessionStore, 'database sessions behind the in-memory cache');
    const lock = await db.workerLock();
    assert.ok(lock && lock.renewEveryMs > 0);
    assert.equal(await db.workerLock(), null, 'second worker stands by');
    await lock.release();
    await db.repo.insertRecords([rec(Date.now())]);
    assert.equal(await db.repo.recordCount(), 1);
  } finally {
    await db.close();
  }
  await assert.rejects(openDatabase({ database: null }), /no database configured/);
});
