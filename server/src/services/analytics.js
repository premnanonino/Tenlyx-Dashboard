import { lowerBound } from '../dsa/search.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const RANGES = {
  '24h': { span: DAY, step: HOUR },
  '7d': { span: 7 * DAY, step: 6 * HOUR },
  '30d': { span: 30 * DAY, step: DAY },
};

export function parseRange(value = '24h') {
  const r = RANGES[value];
  if (!r) throw Object.assign(new Error(`range must be one of ${Object.keys(RANGES).join(', ')}`), { status: 400 });
  return r;
}

const MAX_SPAN = 35 * DAY; // raw-record retention

function parseTs(v, name) {
  const t = /^\d+$/.test(String(v)) ? Number(v) : Date.parse(String(v));
  if (!Number.isFinite(t)) throw Object.assign(new Error(`${name} must be a date (YYYY-MM-DD) or epoch ms`), { status: 400 });
  return t;
}

/**
 * Resolve a query into a time window {from, to, step}.
 *   ?range=24h|7d|30d            preset, aligned to its bucket size
 *   ?from=YYYY-MM-DD&to=...      custom (to is inclusive of that day), max 35 days
 * Bucket size adapts to the span: <=2d hourly, <=14d 6-hourly, else daily.
 */
export function parseWindow(q = {}, now = Date.now()) {
  if (q.from || q.to) {
    const from = q.from ? parseTs(q.from, 'from') : now - DAY;
    let to = q.to ? parseTs(q.to, 'to') : now;
    if (q.to && /^\d{4}-\d{2}-\d{2}$/.test(String(q.to))) to += DAY; // whole end day
    to = Math.min(to, Math.ceil((now + 1) / HOUR) * HOUR);
    if (!(from < to)) throw Object.assign(new Error('from must be before to'), { status: 400 });
    if (from < now - MAX_SPAN - DAY) throw Object.assign(new Error('raw data only covers the last 35 days; use Reports for older months'), { status: 400 });
    const span = to - from;
    const step = span <= 2 * DAY ? HOUR : span <= 14 * DAY ? 6 * HOUR : DAY;
    const a = Math.floor(from / step) * step;
    const b = Math.ceil(to / step) * step;
    return { key: 'custom', from: a, to: b, step, span: b - a };
  }
  const key = q.range || '24h';
  const { span, step } = parseRange(key);
  const end = Math.ceil((now + 1) / step) * step;
  return { key, from: end - span, to: end, step, span };
}

const winInfo = (w) => ({ range: w.key, from: w.from, to: w.to, stepMs: w.step });

/**
 * Largest-Triangle-Three-Buckets downsampling.
 * Reduces a long series to `threshold` points while keeping its visual
 * shape (peaks and dips survive, unlike naive every-nth sampling). O(n).
 */
export function lttb(points, threshold, x = (p) => p.ts, y = (p) => p.v) {
  const n = points.length;
  if (threshold >= n || threshold < 3) return points;
  const out = [points[0]];
  const every = (n - 2) / (threshold - 2);
  let a = 0;
  for (let i = 0; i < threshold - 2; i++) {
    const avgStart = Math.floor((i + 1) * every) + 1;
    const avgEnd = Math.min(Math.floor((i + 2) * every) + 1, n);
    let ax = 0; let ay = 0;
    for (let j = avgStart; j < avgEnd; j++) { ax += x(points[j]); ay += y(points[j]); }
    const len = Math.max(1, avgEnd - avgStart);
    ax /= len; ay /= len;

    const rStart = Math.floor(i * every) + 1;
    const rEnd = Math.floor((i + 1) * every) + 1;
    const px = x(points[a]); const py = y(points[a]);
    let maxArea = -1; let next = rStart;
    for (let j = rStart; j < rEnd; j++) {
      const area = Math.abs((px - ax) * (y(points[j]) - py) - (px - x(points[j])) * (ay - py));
      if (area > maxArea) { maxArea = area; next = j; }
    }
    out.push(points[next]);
    a = next;
  }
  out.push(points[n - 1]);
  return out;
}

/** Read-side computations. Pure functions of the store's current state. */
export class Analytics {
  constructor({ store }) {
    this.store = store;
  }

  overview(now = Date.now()) {
    const s = this.store;
    const total = s.total;
    const hourStart = Math.floor(now / HOUR) * HOUR;
    const from24 = hourStart - 23 * HOUR; // 24 hourly buckets incl. the current one
    const spend24h = total.sum(from24, now);
    const prev24h = total.sum(from24 - DAY, from24);
    const dayStart = Math.floor(now / DAY) * DAY;
    const d = new Date(now);
    const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();

    const coveredDays = s.oldestTs ? Math.min(7, Math.max((now - s.oldestTs) / DAY, 1 / 24)) : 0;
    const spend7d = total.sum(now - 7 * DAY, now);
    const avgDaily = coveredDays ? spend7d / coveredDays : 0;

    const spendMTD = total.sum(monthStart, now);
    const daysLeftInMonth = daysInMonth - (now - monthStart) / DAY;
    const b = s.balance;

    // Balance one hour ago: binary search over the snapshot history.
    const hist = s.balanceHistory.toArray();
    const i = lowerBound(hist, now - HOUR, (h) => h.ts);
    const hourAgo = hist[i] && hist[i].ts < now - 5 * 60_000 ? hist[i] : null;

    return {
      currency: b?.currency ?? 'USD',
      balance: b?.balance ?? null,
      availableCredit: b?.availableCredit ?? null,
      creditLimit: b?.creditLimit ?? null,
      pending: b?.pending ?? null,
      balanceAt: b?.ts ?? null,
      balanceDelta1h: b && hourAgo ? b.balance - hourAgo.balance : null,
      spend24h,
      prev24h,
      spend24hChange: prev24h > 0 ? (spend24h - prev24h) / prev24h : null,
      spendToday: total.sum(dayStart, now),
      spendMTD,
      projectedMonth: spendMTD + avgDaily * daysLeftInMonth,
      avgDaily,
      runwayDays: b && avgDaily > 0 ? b.availableCredit / avgDaily : null,
      records24h: total.count(from24, now),
      lastHourSpend: total.sum(hourStart, now),
    };
  }

  spendSeries(w) {
    const products = this.store.products;
    const points = [];
    for (let t = w.from; t < w.to; t += w.step) {
      const byProduct = {};
      for (const p of products) byProduct[p] = this.store.byProduct.get(p).sum(t, t + w.step);
      points.push({ t, total: this.store.total.sum(t, t + w.step), count: this.store.total.count(t, t + w.step), byProduct });
    }
    return { ...winInfo(w), products, points };
  }

  productSplit(w) {
    let total = 0;
    const items = this.store.products.map((p) => {
      const series = this.store.byProduct.get(p);
      const cost = series.sum(w.from, w.to);
      total += cost;
      return { product: p, cost, count: series.count(w.from, w.to) };
    });
    items.sort((a, b) => b.cost - a.cost);
    return { ...winInfo(w), total, items: items.map((x) => ({ ...x, share: total ? x.cost / total : 0 })) };
  }

  balanceHistory(w) {
    const hist = this.store.balanceHistory.toArray();
    const lo = lowerBound(hist, w.from, (h) => h.ts);
    const hi = lowerBound(hist, w.to, (h) => h.ts);
    const pts = hist.slice(lo, hi).map((h) => ({ ts: h.ts, v: h.balance, available: h.available, est: !!h.estimated }));
    return { ...winInfo(w), points: lttb(pts, 240), raw: pts.length };
  }

  /** Spend by UTC weekday x hour-of-day: a 7x24 grid built in one pass. */
  heatmap(w) {
    const { lo, hi } = this.store.sliceBounds(w.from, w.to);
    const cost = Array.from({ length: 7 }, () => new Array(24).fill(0));
    const count = Array.from({ length: 7 }, () => new Array(24).fill(0));
    const days = Array.from({ length: 7 }, () => new Set());
    for (let i = lo; i < hi; i++) {
      const r = this.store.records[i];
      const d = new Date(r.ts);
      const wd = (d.getUTCDay() + 6) % 7; // Monday = 0
      cost[wd][d.getUTCHours()] += r.cost;
      count[wd][d.getUTCHours()]++;
      days[wd].add(Math.floor(r.ts / DAY));
    }
    // Average per occurrence of that weekday, so 7d and 30d ranges are comparable.
    const avg = cost.map((row, wd) => row.map((v) => (days[wd].size ? v / days[wd].size : 0)));
    let max = 0;
    for (const row of avg) for (const v of row) max = Math.max(max, v);
    return { ...winInfo(w), avg, count, max, samples: days.map((s) => s.size) };
  }
}
