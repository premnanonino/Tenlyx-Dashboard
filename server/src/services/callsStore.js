import crypto from 'node:crypto';
import { lowerBound, upperBound } from '../dsa/search.js';

const DAY = 86_400_000;
const digits = (s) => String(s ?? '').replace(/\D/g, '');
const dayStart = (ts) => Math.floor(ts / DAY) * DAY; // UTC day, like the rest of the dashboard

/** Opaque caller id: keeps raw phone numbers out of URLs and logs. */
export const callerIdFor = (phoneDigits) =>
  crypto.createHash('sha256').update(`caller:${phoneDigits}`).digest('base64url').slice(0, 16);

/**
 * In-memory index of the slim call history (API process). Fed from the
 * dashboard database (hydration + tail), so list, filter, search, paging
 * and caller grouping never touch CourseRev's production database.
 *
 *   byId      Map callId -> call             upsert / dedupe, O(1)
 *   sorted    calls by ts descending          rebuilt lazily after changes
 *   callers   Map callerId -> calls (asc)     rebuilt lazily after changes
 *   search    lowercase haystack per call     substring search (call id, name, email, phone digits)
 *
 * A caller is a phone number (digits only; every call has one). Calls from
 * internal/test numbers or emails are marked and hidden unless asked for.
 */
export class CallsStore {
  constructor({ retentionMs = 90 * DAY, internalDomains = ['courserev.ai'], internalNumbers = [], highVolumePerDay = 20 } = {}) {
    this.retentionMs = retentionMs;
    this.internalDomains = internalDomains.map((d) => `@${d.toLowerCase().replace(/^@/, '')}`);
    this.internalNumbers = new Set(internalNumbers.map(digits).filter(Boolean));
    this.highVolumePerDay = highVolumePerDay;
    this.byId = new Map();
    this.sorted = [];
    this.dirty = false;
    this.version = 0;
    this.callersVersion = -1;
    this.callers = new Map();
    this.lastSyncedAt = 0;
    this.hydrated = false;
    this.facetCache = null;
  }

  get size() { return this.byId.size; }

  #isInternal(c, ph) {
    const email = String(c.email || '').toLowerCase();
    return this.internalDomains.some((d) => email.endsWith(d)) || (ph !== null && this.internalNumbers.has(ph));
  }

  /** Insert or replace calls (the database only hands over new or changed rows). Returns how many were applied. */
  upsert(entries) {
    let n = 0;
    for (const e of entries) {
      const c = e.data ?? e;
      if (!c?.callId) continue;
      if (e.syncedAt && e.syncedAt > this.lastSyncedAt) this.lastSyncedAt = e.syncedAt;
      const d = digits(c.phone);
      c._ph = d.length >= 7 ? d : null;
      c._caller = c._ph ? callerIdFor(c._ph) : null;
      c._internal = this.#isInternal(c, c._ph);
      c._q = [c.callId, c.name, c.email, c.course, c.org].filter(Boolean).join(' ').toLowerCase() + ' ' + d;
      // Where the call went: the course, else the organisation (organisation-level lines), else unknown.
      c._place = c.courseId !== null && c.courseId !== undefined ? `c${c.courseId}` : c.orgId !== null && c.orgId !== undefined ? `o${c.orgId}` : 'unknown';
      c._placeLabel = c.course || c.org || 'Unknown course';
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

  /** callerId -> that caller's calls, oldest first. Rebuilt only after the data changed. */
  #ensureCallers() {
    this.#ensureSorted();
    if (this.callersVersion === this.version) return;
    const m = new Map();
    for (let i = this.sorted.length - 1; i >= 0; i--) { // ascending ts
      const c = this.sorted[i];
      if (!c._caller) continue;
      let list = m.get(c._caller);
      if (!list) { list = []; m.set(c._caller, list); }
      list.push(c);
    }
    this.callers = m;
    this.callersVersion = this.version;
  }

  /** Calls by the same caller on the same UTC day as `c`: { count, index } (index is 1-based). */
  #sameDay(c) {
    const list = c._caller ? this.callers.get(c._caller) : null;
    if (!list) return { count: 1, index: 1 };
    const d0 = dayStart(c.ts);
    const lo = lowerBound(list, d0, (x) => x.ts);
    const hi = lowerBound(list, d0 + DAY, (x) => x.ts);
    const pos = list.indexOf(c, lo);
    return { count: hi - lo, index: pos >= 0 ? pos - lo + 1 : 1 };
  }

  /** Public shape of a call (internal helper fields removed). */
  #pub(c) {
    const { _q, _ph, _caller, _internal, _place, _placeLabel, ...rest } = c;
    return { ...rest, callerId: _caller, internal: _internal };
  }

  /** [lo, hi) of `sorted` (ts descending) with from <= ts < to, and a matcher for the filters. */
  #select({ from = null, to = null, q = '', courseId = null, orgId = null, outcome = null, booked = null, level = null, includeInternal = false }) {
    this.#ensureSorted();
    const arr = this.sorted;
    const lo = to === null ? 0 : upperBound(arr, -to, (c) => -c.ts);         // first call with ts < to
    const hi = from === null ? arr.length : upperBound(arr, -from, (c) => -c.ts); // first call with ts < from
    const needle = String(q || '').trim().toLowerCase();
    const needleDigits = digits(needle);
    const textMatch = !needle ? null
      : needleDigits.length >= 3 && needleDigits.length === needle.replace(/[\s()+-]/g, '').length
        ? (c) => c._q.includes(needleDigits)
        : (c) => c._q.includes(needle);
    const match = (c) =>
      (includeInternal || !c._internal) &&
      (courseId === null || c.courseId === courseId) &&
      (orgId === null || c.orgId === orgId) &&
      (booked === null || c.booked === booked) &&
      (level === null || c.level === level) &&
      (outcome === null || (outcome === 'none' ? !c.outcome : c.outcome === outcome)) &&
      (!textMatch || textMatch(c));
    return { arr, lo, hi, match };
  }

  /**
   * Filtered, paged list, newest first.
   *   from/to (ms), q (call id / name / email / phone / course), courseId, orgId,
   *   outcome ('none' = no outcome), booked (true/false), level, includeInternal, page (1-based), limit
   */
  query({ page = 1, limit = 25, now = Date.now(), ...filters } = {}) {
    const { arr, lo, hi, match } = this.#select(filters);
    const { from = null, to = null } = filters;
    this.#ensureCallers();

    const start = (Math.max(1, page) - 1) * limit;
    // One pass: page rows + summary + outcome breakdown + time series + caller counts.
    const lastTs = lo < hi ? arr[lo].ts : null;
    const firstTs = lo < hi ? arr[hi - 1].ts : null;
    const spanFrom = from ?? firstTs ?? 0;
    const spanTo = to ?? Math.max(now, lastTs !== null ? lastTs + 1 : spanFrom + 1); // the axis always ends at now
    const step = spanTo - spanFrom <= 2 * DAY ? 3_600_000 : DAY;
    const t0 = Math.floor(spanFrom / step) * step;
    const nBuckets = Math.min(400, Math.max(1, Math.ceil((spanTo - t0) / step)));
    const series = Array.from({ length: nBuckets }, (_, i) => ({ t: t0 + i * step, total: 0, booked: 0, by: {} }));
    const outcomes = new Map();
    const courses = new Set();
    const perCaller = new Map();
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
      if (c._caller) perCaller.set(c._caller, (perCaller.get(c._caller) || 0) + 1);
      const ok = c.outcome || 'none';
      outcomes.set(ok, (outcomes.get(ok) || 0) + 1);
      const b = series[Math.floor((c.ts - t0) / step)];
      if (b) { b.total++; if (c.booked) b.booked++; b.by[ok] = (b.by[ok] || 0) + 1; }
    }
    let repeat = 0;
    for (const n of perCaller.values()) if (n > 1) repeat++;
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
        uniqueCallers: perCaller.size,
        repeatCallers: repeat,
        repeatRate: perCaller.size ? repeat / perCaller.size : null,
      },
      outcomes: [...outcomes].map(([id, count]) => ({ id, label: id === 'none' ? 'No outcome' : id, count })).sort((a, b) => b.count - a.count),
      series: { stepMs: step, points: series },
      rows: rows.map((c) => {
        const sd = this.#sameDay(c);
        return { ...this.#pub(c), dayCount: sd.count, dayIndex: sd.index };
      }),
    };
  }

  /**
   * Repeat callers: calls grouped by caller (phone) within the range and filters.
   *   minCalls      at least this many calls in the range (default 2)
   *   minPerDay     at least this many calls on one UTC day
   *   sort          'calls' | 'busiest' | 'courses' | 'attention' | 'recent'
   * "Needs attention" = 3+ calls on one day and no booking in the range.
   */
  repeatCallers({ minCalls = 2, minPerDay = null, sort = 'calls', page = 1, limit = 25, ...filters } = {}) {
    const { arr, lo, hi, match } = this.#select(filters);
    const groups = new Map();
    for (let i = lo; i < hi; i++) { // newest first: the first call seen is the caller's latest
      const c = arr[i];
      if (!c._caller || !match(c)) continue;
      let g = groups.get(c._caller);
      if (!g) {
        g = { id: c._caller, name: null, email: null, phone: c.phone, internal: c._internal, calls: 0, booked: 0, firstTs: c.ts, lastTs: c.ts,
          courses: new Map(), days: new Map(), outcomes: new Map(), durSum: 0 };
        groups.set(c._caller, g);
      }
      g.calls++;
      if (c.booked) g.booked++;
      g.firstTs = c.ts;
      if (!g.name && c.name) g.name = c.name;
      if (!g.email && c.email) g.email = c.email;
      if (Number.isFinite(c.durationSec)) g.durSum += c.durationSec;
      const ce = g.courses.get(c._place) || { id: c._place, label: c._placeLabel, count: 0 };
      ce.count++; g.courses.set(c._place, ce);
      const d = dayStart(c.ts);
      g.days.set(d, (g.days.get(d) || 0) + 1);
      const ok = c.outcome || 'none';
      g.outcomes.set(ok, (g.outcomes.get(ok) || 0) + 1);
    }

    let uniqueCallers = 0; let repeatCallers = 0; let attention = 0; let highVolume = 0;
    const list = [];
    for (const g of groups.values()) {
      uniqueCallers++;
      if (g.calls > 1) repeatCallers++;
      let busiest = { day: null, count: 0 };
      for (const [day, n] of g.days) if (n > busiest.count || (n === busiest.count && day > busiest.day)) busiest = { day, count: n };
      const needsAttention = busiest.count >= 3 && g.booked === 0;
      const isHighVolume = busiest.count > this.highVolumePerDay;
      if (needsAttention) attention++;
      if (isHighVolume) highVolume++;
      if (g.calls < minCalls || (minPerDay && busiest.count < minPerDay)) continue;
      if (sort === 'attention' && !needsAttention) continue;
      list.push({
        id: g.id, name: g.name, email: g.email, phone: g.phone, internal: g.internal,
        calls: g.calls, booked: g.booked, firstTs: g.firstTs, lastTs: g.lastTs,
        avgDurationSec: g.calls ? g.durSum / g.calls : null,
        days: g.days.size, busiest,
        courses: [...g.courses.values()].sort((a, b) => b.count - a.count),
        outcomes: [...g.outcomes].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count),
        needsAttention, highVolume: isHighVolume,
      });
    }
    const by = {
      calls: (a, b) => b.calls - a.calls || b.lastTs - a.lastTs,
      busiest: (a, b) => b.busiest.count - a.busiest.count || b.calls - a.calls,
      courses: (a, b) => b.courses.length - a.courses.length || b.calls - a.calls,
      attention: (a, b) => b.busiest.count - a.busiest.count || b.calls - a.calls,
      recent: (a, b) => b.lastTs - a.lastTs,
    }[sort] || ((a, b) => b.calls - a.calls);
    list.sort(by);
    const total = list.length;
    const start = (Math.max(1, page) - 1) * limit;
    return {
      total,
      page: Math.max(1, page),
      pages: Math.max(1, Math.ceil(total / limit)),
      limit,
      summary: {
        uniqueCallers, repeatCallers, repeatRate: uniqueCallers ? repeatCallers / uniqueCallers : null,
        callsPerCaller: uniqueCallers ? [...groups.values()].reduce((s, g) => s + g.calls, 0) / uniqueCallers : null,
        needsAttention: attention, highVolume,
      },
      rows: list.slice(start, start + limit),
    };
  }

  /** One caller's calls, grouped by UTC day (newest day first), within [from, to). */
  caller(callerId, { from = null, to = null } = {}) {
    this.#ensureCallers();
    const all = this.callers.get(callerId);
    if (!all) return null;
    const inRange = all.filter((c) => (from === null || c.ts >= from) && (to === null || c.ts < to));
    const latest = all[all.length - 1];
    const days = new Map();
    const dayPlaces = new Map();
    for (let i = inRange.length - 1; i >= 0; i--) {
      const c = inRange[i];
      const d = dayStart(c.ts);
      if (!days.has(d)) { days.set(d, []); dayPlaces.set(d, new Set()); }
      days.get(d).push(this.#pub(c));
      dayPlaces.get(d).add(c._place);
    }
    const courses = new Map();
    for (const c of inRange) {
      const e = courses.get(c._place) || { id: c._place, label: c._placeLabel, count: 0 };
      e.count++; courses.set(c._place, e);
    }
    return {
      id: callerId,
      name: [...all].reverse().find((c) => c.name)?.name ?? null,
      email: [...all].reverse().find((c) => c.email)?.email ?? null,
      phone: latest.phone,
      internal: latest._internal,
      totalCalls: all.length, // all 90 days
      calls: inRange.length,  // in the selected range
      booked: inRange.filter((c) => c.booked).length,
      firstTs: all[0].ts,
      lastTs: latest.ts,
      courses: [...courses.values()].sort((a, b) => b.count - a.count),
      days: [...days].map(([day, calls]) => ({ day, count: calls.length, courses: dayPlaces.get(day).size, calls })),
    };
  }

  get(callId) {
    const c = this.byId.get(callId);
    if (!c) return null;
    this.#ensureCallers();
    const sd = this.#sameDay(c);
    const list = c._caller ? this.callers.get(c._caller) : null;
    return { ...this.#pub(c), dayCount: sd.count, dayIndex: sd.index, callerCalls: list ? list.length : 1 };
  }

  /** Filter options (courses, organisations, outcomes, types) with counts. */
  facets() {
    if (this.facetCache) return this.facetCache;
    this.#ensureSorted();
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
