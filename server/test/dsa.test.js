import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LRUCache } from '../src/dsa/LRUCache.js';
import { MinHeap, topK } from '../src/dsa/MinHeap.js';
import { RingBuffer, percentile } from '../src/dsa/RingBuffer.js';
import { Trie } from '../src/dsa/Trie.js';
import { SegmentTree, TimeWindowSeries } from '../src/dsa/SegmentTree.js';
import { lowerBound, upperBound, meanStd } from '../src/dsa/search.js';
import { TokenBucketLimiter } from '../src/dsa/TokenBucket.js';
import { CircuitBreaker } from '../src/infra/circuitBreaker.js';
import { SingleFlight } from '../src/infra/singleFlight.js';
import { lttb } from '../src/services/analytics.js';
import { BillingStore } from '../src/services/billingStore.js';

test('LRU evicts least recently used and honours TTL', async () => {
  const c = new LRUCache({ capacity: 2, ttlMs: 30 });
  c.set('a', 1); c.set('b', 2);
  c.get('a');            // a becomes most recent
  c.set('c', 3);         // evicts b
  assert.equal(c.get('b'), undefined);
  assert.equal(c.get('a'), 1);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(c.get('a'), undefined);
  assert.equal(c.stats().evictions, 1);
});

test('MinHeap pops in order; topK returns largest k descending', () => {
  const h = new MinHeap();
  [5, 1, 4, 2, 3].forEach((x) => h.push(x));
  assert.deepEqual([h.pop(), h.pop(), h.pop()], [1, 2, 3]);
  const items = Array.from({ length: 1000 }, (_, i) => ({ v: (i * 7919) % 1000 }));
  assert.deepEqual(topK(items, 3, (x) => x.v).map((x) => x.v), [999, 998, 997]);
});

test('RingBuffer overwrites oldest; percentile', () => {
  const r = new RingBuffer(3);
  [1, 2, 3, 4].forEach((x) => r.push(x));
  assert.deepEqual(r.toArray(), [2, 3, 4]);
  assert.equal(r.last(), 4);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
});

test('Trie prefix search and removal prunes', () => {
  const t = new Trie();
  t.insert('+14155550100', 'a');
  t.insert('+14155550199', 'b');
  t.insert('Marketing', 'c');
  assert.deepEqual([...t.searchPrefix('1415')].sort(), ['a', 'b']);
  assert.deepEqual([...t.searchPrefix('mark')], ['c']);
  t.remove('+14155550100', 'a');
  assert.deepEqual([...t.searchPrefix('1415')], ['b']);
  t.remove('+14155550199', 'b');
  assert.equal(t.root.children.has('1'), false);
});

test('SegmentTree range sums', () => {
  const s = new SegmentTree(8);
  [3, 1, 4, 1, 5, 9, 2, 6].forEach((v, i) => s.add(i, v));
  assert.equal(s.query(0, 8), 31);
  assert.equal(s.query(2, 5), 10);
  s.set(5, 0);
  assert.equal(s.query(4, 7), 7);
});

test('TimeWindowSeries wraps and expires old buckets', () => {
  const H = 3_600_000;
  const w = new TimeWindowSeries({ bucketMs: H, buckets: 4 });
  w.add(0 * H, 1); w.add(1 * H, 2); w.add(2 * H, 3); w.add(3 * H, 4);
  assert.equal(w.sum(0, 4 * H), 10);
  w.add(5 * H + 10, 10);                 // bucket 5 → buckets 0,1 fall out, 4 is empty
  assert.equal(w.sum(0, 6 * H), 3 + 4 + 0 + 10);
  assert.equal(w.sum(3 * H, 6 * H), 14); // range wraps the circular array
  assert.equal(w.add(0, 99), false);     // too old
});

test('binary search bounds and Welford stats', () => {
  const a = [1, 2, 2, 2, 5];
  assert.equal(lowerBound(a, 2), 1);
  assert.equal(upperBound(a, 2), 4);
  assert.equal(lowerBound(a, 6), 5);
  const { mean, std } = meanStd([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.equal(mean, 5);
  assert.equal(std, 2);
});

test('TokenBucket rejects when empty', () => {
  const l = new TokenBucketLimiter({ capacity: 2, refillPerSec: 0.001 });
  assert.ok(l.take('x').ok);
  assert.ok(l.take('x').ok);
  assert.equal(l.take('x').ok, false);
});

test('CircuitBreaker trips, short-circuits and recovers', async () => {
  const b = new CircuitBreaker({ name: 't', minCalls: 2, failureRate: 0.5, cooldownMs: 20 });
  const boom = () => Promise.reject(new Error('x'));
  await assert.rejects(b.exec(boom));
  await assert.rejects(b.exec(boom));
  assert.equal(b.state, 'OPEN');
  await assert.rejects(b.exec(() => 1), { code: 'BREAKER_OPEN' });
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(await b.exec(async () => 'ok'), 'ok');
  assert.equal(b.state, 'CLOSED');
});

test('SingleFlight coalesces concurrent calls', async () => {
  const f = new SingleFlight();
  let calls = 0;
  const fn = () => new Promise((r) => setTimeout(() => r(++calls), 10));
  const [a, b] = await Promise.all([f.do('k', fn), f.do('k', fn)]);
  assert.equal(a, 1); assert.equal(b, 1); assert.equal(calls, 1);
});

test('LTTB keeps endpoints and target size', () => {
  const pts = Array.from({ length: 1000 }, (_, i) => ({ ts: i, v: Math.sin(i / 20) }));
  const out = lttb(pts, 100);
  assert.equal(out.length, 100);
  assert.equal(out[0], pts[0]);
  assert.equal(out[99], pts[999]);
});

test('BillingStore dedupes, orders, queries and evicts', () => {
  const now = Date.now();
  const s = new BillingStore({ retentionMs: 86_400_000 });
  const rec = (id, ago, extra = {}) => ({
    id, ts: now - ago, product: 'messaging', direction: 'outbound', destination: '+14155550100',
    country: 'US', billingGroupId: null, units: 1, unitLabel: 'seg', rate: 0.004, cost: 1, currency: 'USD', status: 'delivered', ...extra,
  });
  s.ingest([rec('a', 3000), rec('c', 1000)], now);
  const added = s.ingest([rec('b', 2000, { destination: '+442071234567', country: 'GB', cost: 5 }), rec('a', 3000)], now);
  assert.equal(added.length, 1);
  assert.deepEqual(s.records.map((r) => r.id), ['a', 'b', 'c']);
  assert.equal(s.stats.duplicates, 1);
  const q = s.query({ from: now - 10_000, to: now + 1, q: '44207' });
  assert.equal(q.total, 1);
  assert.equal(q.rows[0].id, 'b');
  assert.equal(s.top('country', 1, now - 10_000, now + 1).items[0].key, 'GB');
  assert.equal(s.evict(now + 86_400_000 - 1500), 2);
  assert.deepEqual(s.records.map((r) => r.id), ['c']);
});

import { SpaceSaving } from '../src/dsa/SpaceSaving.js';
import { MonthlyRollups } from '../src/services/monthlyRollups.js';

test('SpaceSaving keeps heavy hitters with bounded error', () => {
  const s = new SpaceSaving(5);
  for (let i = 0; i < 1000; i++) s.add(`noise-${i}`, 1);
  for (let i = 0; i < 50; i++) { s.add('big', 30); s.add('mid', 10); }
  const top = s.top(2);
  assert.deepEqual(top.map((x) => x.key), ['big', 'mid']);
  assert.ok(top[0].weight - top[0].error <= 1500 && top[0].weight >= 1500);
  const round = SpaceSaving.fromJSON(JSON.parse(JSON.stringify(s)));
  assert.equal(round.top(1)[0].key, 'big');
});

test('MonthlyRollups counts once across restarts', async () => {
  const fs = await import('node:fs');
  const file = `${process.env.TMPDIR || '/tmp'}/tlxmon-rollup-test-${process.pid}.json`;
  const rec = (id, ts, cost) => ({ id, ts, cost, product: 'messaging', country: 'US', direction: 'outbound', destination: '+1', units: 1, status: 'delivered' });
  const t = Date.UTC(2026, 9, 15);
  const a = new MonthlyRollups({ file });
  a.load();
  a.addLive([rec('1', t, 2), rec('2', t + 1000, 3)]);
  a.flush();
  const b = new MonthlyRollups({ file });
  b.load();
  b.addLive([rec('1', t, 2), rec('2', t + 1000, 3), rec('3', t + 2000, 4)]); // replayed backfill
  assert.equal(b.get('2026-10').cost, 9);
  assert.equal(b.get('2026-10').count, 3);
  fs.unlinkSync(file);
});

import { hashPassword, verifyPassword, SessionStore } from '../src/auth/auth.js';
import { parseWindow } from '../src/services/analytics.js';

test('scrypt hash verifies only the right password', () => {
  const h = hashPassword('correct horse battery');
  assert.ok(h.startsWith('scrypt$'));
  assert.equal(verifyPassword('correct horse battery', h), true);
  assert.equal(verifyPassword('correct horse batterY', h), false);
  assert.notEqual(hashPassword('x'), hashPassword('x')); // salted
});

test('sessions expire and can be destroyed', async () => {
  const s = new SessionStore({ ttlMs: 20 });
  const id = s.create('a@b.co');
  assert.equal(s.get(id).email, 'a@b.co');
  s.destroy(id);
  assert.equal(s.get(id), null);
  const id2 = s.create('a@b.co');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(s.get(id2), null);
});

test('parseWindow handles presets, custom days and bad input', () => {
  const now = Date.UTC(2026, 10, 6, 12, 30);
  const p = parseWindow({ range: '24h' }, now);
  assert.equal(p.to - p.from, 86_400_000);
  const c = parseWindow({ from: '2026-11-01', to: '2026-11-03' }, now);
  assert.equal(c.from, Date.UTC(2026, 10, 1));
  assert.equal(c.to, Date.UTC(2026, 10, 4));
  assert.equal(c.step, 6 * 3_600_000);
  assert.throws(() => parseWindow({ from: '2026-11-05', to: '2026-11-01' }, now), /before/);
  assert.throws(() => parseWindow({ from: '2025-01-01' }, now), /35 days/);
  assert.throws(() => parseWindow({ from: 'nope' }, now), /date/);
});
