import { upperBound } from '../dsa/search.js';

const DAY = 86_400_000;
const digits = (s) => String(s ?? '').replace(/\D/g, '');

/**
 * In-memory index of the slim call history (API process). Fed from the
 * dashboard database (hydration + tail), so list, filter, search and paging
 * never touch CourseRev's production database.
 *
 *   byId     Map callId -> call             upsert / dedupe, O(1)
 *   sorted   calls by ts descending          rebuilt lazily after changes
 *   search   lowercase haystack per call     substring search (call id, name, email, phone digits)
 */
export class CallsStore {
  constructor({ retentionMs = 90 * DAY } = {}) {
    this.retentionMs = retentionMs;
    this.byId = new Map();
    this.sorted = [];
    this.dirty = false;
    this.version = 0;
    this.lastSyncedAt = 0;
    this.hydrated = false;
    this.facetCache = null;
  }

  get size() { return this.byId.size; }

  /** Insert or replace calls (the database only hands over new or changed rows). Returns how many were applied. */
  upsert(entries) {
    let n = 0;
    for (const e of entries) {
      const c = e.data ?? e;
      if (!c?.callId) continue;
      if (e.syncedAt && e.syncedAt > this.lastSyncedAt) this.lastSyncedAt = e.syncedAt;
      c._q = [c.callId, c.name, c.email, c.course, c.org].filter(Boolean).join(' ').toLowerCase() + ' ' + digits(c.phone);
      this.byId.set(c.callId, c);
      n++;
    }
    if (n) { this.dirty = true; this.version++; this.facetCache = null; }
    return n;
  }

  evict(now = Date.now()) {
    const cutoff = now - this.retentionMs;
    let n = 0;
    for (const [id, c] of this.byId) if (c.ts < cutoff) { this.byId.delete(id); n++; }
    if (n) { this.dirty = true; this.version++; this.facetCache = null; }
    return n;
  }

  #ensureSorted() {
    if (!this.dirty) return;
    this.sorted = [...this.byId.values()].sort((a, b) => b.ts - a.ts || (a.callId < b.callId ? 1 : -1));
    this.dirty = false;
  }

  /**
   * Filtered, paged list, newest first.
   *   from/to (ms), q (call id / name / email / phone / course), courseId, orgId,
   *   outcome ('none' = no outcome), booked (true/false), level, page (1-based), limit
   */
  query({ from = null, to = null, q = '', courseId = null, orgId = null, outcome = null, booked = null, level = null, page = 1, limit = 25, now = Date.now() } = {}) {
    this.#ensureSorted();
    const arr = this.sorted;
    // ts is descending: [lo, hi) holds calls with from <= ts < to.
    const lo = to === null ? 0 : upperBound(arr, -to, (c) => -c.ts);       // first call with ts < to
    const hi = from === null ? arr.length : upperBound(arr, -from, (c) => -c.ts); // first call with ts < from
    const needle = String(q || '').trim().toLowerCase();
    const needleDigits = digits(needle);
    const textMatch = !needle ? null
      : needleDigits.length >= 3 && needleDigits.length === needle.replace(/[\s()+-]/g, '').length
        ? (c) => c._q.includes(needleDigits)
        : (c) => c._q.includes(needle);
    const match = (c) =>
      (courseId === null || c.courseId === courseId) &&
      (orgId === null || c.orgId === orgId) &&
      (booked === null || c.booked === booked) &&
      (level === null || c.level === level) &&
      (outcome === null || (outcome === 'none' ? !c.outcome : c.outcome === outcome)) &&
      (!textMatch || textMatch(c));

    const start = (Math.max(1, page) - 1) * limit;
    // One pass: page rows + summary + outcome breakdown + time series.
    const lastTs = lo < hi ? arr[lo].ts : null;
    const firstTs = lo < hi ? arr[hi - 1].ts : null;
    const spanFrom = from ?? firstTs ?? 0;
    const spanTo = to ?? Math.max(now, lastTs !== null ? lastTs + 1 : spanFrom + 1); // the axis always ends at now
    const step = spanTo - spanFrom <= 2 * DAY ? 3_600_000 : DAY;
    const t0 = Math.floor(spanFrom / step) * step;
    const nBuckets = Math.min(400, Math.max(1, Math.ceil((spanTo - t0) / step)));
    const series = Array.from({ length: nBuckets }, (_, i) => ({ t: t0 + i * step, total: 0, booked: 0 }));
    const outcomes = new Map();
    const courses = new Set();
    const rows = [];
    let total = 0; let bookedN = 0; let transferred = 0; let durSum = 0; let durN = 0;
    for (let i = lo; i < hi; i++) {
      const c = arr[i];
      if (!match(c)) continue;
      if (total >= start && rows.length < limit) rows.push(c);
      total++;
      if (c.booked) bookedN++;
      if (c.endReason === 'assistant-forwarded-call') transferred++;
      if (Number.isFinite(c.durationSec)) { durSum += c.durationSec; durN++; }
      if (c.courseId !== null) courses.add(c.courseId);
      const ok = c.outcome || 'none';
      outcomes.set(ok, (outcomes.get(ok) || 0) + 1);
      const b = series[Math.floor((c.ts - t0) / step)];
      if (b) { b.total++; if (c.booked) b.booked++; }
    }
    return {
      total,
      page: Math.max(1, page),
      pages: Math.max(1, Math.ceil(total / limit)),
      limit,
      summary: {
        booked: bookedN,
        conversion: total ? bookedN / total : null,
        transferred,
        transferRate: total ? transferred / total : null,
        avgDurationSec: durN ? durSum / durN : null,
        courses: courses.size,
      },
      outcomes: [...outcomes].map(([id, count]) => ({ id, label: id === 'none' ? 'No outcome' : id, count })).sort((a, b) => b.count - a.count),
      series: { stepMs: step, points: series },
      rows: rows.map(({ _q, ...c }) => c),
    };
  }

  get(callId) {
    const c = this.byId.get(callId);
    if (!c) return null;
    const { _q, ...rest } = c;
    return rest;
  }

  /** Filter options (courses, organisations, outcomes, types) with counts. */
  facets() {
    if (this.facetCache) return this.facetCache;
    const courses = new Map(); const orgs = new Map(); const outcomes = new Map(); const levels = new Map();
    const bump = (m, k, label) => { const e = m.get(k) || { id: k, label, count: 0 }; e.count++; m.set(k, e); };
    for (const c of this.byId.values()) {
      if (c.courseId !== null) bump(courses, c.courseId, c.course || `Course #${c.courseId}`);
      if (c.orgId !== null) bump(orgs, c.orgId, c.org || `Organization #${c.orgId}`);
      bump(outcomes, c.outcome || 'none', c.outcome || 'No outcome');
      if (c.level) bump(levels, c.level, c.level === 'golf_course' ? 'Golf course' : c.level === 'organization' ? 'Organization' : c.level);
    }
    const sortByCount = (m) => [...m.values()].sort((a, b) => b.count - a.count);
    const byLabel = (m) => [...m.values()].sort((a, b) => a.label.localeCompare(b.label));
    this.facetCache = {
      total: this.byId.size,
      oldest: this.sorted.length ? this.sorted[this.sorted.length - 1].ts : null,
      courses: byLabel(courses), orgs: byLabel(orgs), outcomes: sortByCount(outcomes), levels: sortByCount(levels),
    };
    return this.facetCache;
  }
}
