import { deriveAi, scorecard } from './aiAnalytics.js';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = 86_400_000;

export function assertMonth(key) {
  if (!MONTH_RE.test(key)) throw Object.assign(new Error('month must be YYYY-MM'), { status: 400 });
}

function prevMonthKey(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
}

function monthBounds(key) {
  const [y, m] = key.split('-').map(Number);
  const from = Date.UTC(y, m - 1, 1);
  const to = Date.UTC(y, m, 1);
  return { from, to, days: Math.round((to - from) / DAY) };
}

const change = (cur, prev) => (prev ? (cur - prev) / prev : null);

function table(obj, total, prevObj, label = (k) => k) {
  return Object.entries(obj)
    .map(([key, a]) => ({
      key,
      label: label(key),
      cost: a.cost,
      count: a.count,
      units: a.units,
      share: total ? a.cost / total : 0,
      change: prevObj ? change(a.cost, prevObj[key]?.cost) : null,
    }))
    .sort((a, b) => b.cost - a.cost);
}

/** Builds monthly statements from the durable rollups. */
export class Reports {
  constructor({ rollups, store }) {
    this.rollups = rollups;
    this.store = store;
  }

  #coverage(key, m, now) {
    const { from, to, days } = monthBounds(key);
    const R = this.rollups.meta;
    const coveredFrom = Math.max(from, R.historyFrom ?? R.liveFrom ?? from);
    const inProgress = now < to;
    const historyGap = R.historyDoneThrough !== null && R.liveFrom !== null && R.historyDoneThrough < R.liveFrom
      && to > R.historyDoneThrough && from < R.liveFrom; // backfill hasn't reached this month yet
    const partial = coveredFrom > from || historyGap;
    const elapsedDays = Math.max(1, Math.min(days, (Math.min(now, to) - coveredFrom) / DAY));
    return {
      from, to, days, coveredFrom, elapsedDays,
      status: inProgress ? 'in_progress' : partial ? 'partial' : 'complete',
      firstRecordAt: m?.firstTs ?? null,
      lastRecordAt: m?.lastTs ?? null,
    };
  }

  list(now = Date.now()) {
    const items = this.rollups.keys().reverse().map((key) => {
      const m = this.rollups.get(key);
      const cov = this.#coverage(key, m, now);
      return {
        month: key, cost: m.cost, count: m.count, status: cov.status,
        aiConversations: Object.values(m.aiModels).reduce((s, a) => s + a.conversations, 0),
        byProduct: Object.fromEntries(Object.entries(m.byProduct).map(([p, a]) => [p, a.cost])),
      };
    });
    return { items, backfill: this.rollups.backfill, currency: this.store.balance?.currency ?? 'USD' };
  }

  build(key, now = Date.now()) {
    assertMonth(key);
    const m = this.rollups.get(key);
    if (!m) throw Object.assign(new Error(`no data for ${key}`), { status: 404 });
    const p = this.rollups.get(prevMonthKey(key));
    const cov = this.#coverage(key, m, now);

    // Full calendar of days (zero-filled) up to today for the current month.
    const daily = [];
    for (let t = cov.from; t < Math.min(cov.to, now + DAY); t += DAY) {
      const k = new Date(t).toISOString().slice(0, 10);
      const d = m.days[k];
      daily.push({ day: k, cost: d?.cost ?? 0, count: d?.count ?? 0, byProduct: d?.byProduct ?? {} });
    }
    const peak = daily.reduce((best, d) => (!best || d.cost > best.cost ? d : best), null);

    const aiTotal = Object.values(m.aiModels).reduce((s, a) => s + a.conversations, 0);
    const models = Object.entries(m.aiModels)
      .map(([model, agg]) => ({ model, ...deriveAi(agg, aiTotal), prevConversations: p?.aiModels[model]?.conversations ?? null }))
      .sort((a, b) => b.conversations - a.conversations);
    const aiCost = models.reduce((s, x) => s + x.cost, 0);

    return {
      month: key,
      generatedAt: now,
      currency: this.store.balance?.currency ?? 'USD',
      coverage: cov,
      summary: {
        cost: m.cost,
        count: m.count,
        failed: m.failed,
        avgDaily: m.cost / cov.elapsedDays,
        projected: cov.status === 'in_progress' ? (m.cost / cov.elapsedDays) * cov.days : null,
        peakDay: peak && peak.cost > 0 ? { day: peak.day, cost: peak.cost } : null,
        balanceOpen: m.balanceOpen,
        balanceClose: m.balanceClose,
        prevCost: p?.cost ?? null,
        change: p ? change(m.cost, p.cost) : null,
        prevCount: p?.count ?? null,
      },
      daily,
      products: table(m.byProduct, m.cost, p?.byProduct),
      countries: table(m.byCountry, m.cost, p?.byCountry).slice(0, 10),
      groups: table(m.byGroup, m.cost, p?.byGroup, (id) => (id === 'unassigned' ? 'Unassigned' : this.store.groupName(id))),
      directions: table(m.byDirection, m.cost, null),
      topNumbers: m.dest.top(10).map((x) => ({ number: x.key, cost: x.weight, count: x.count, maxError: x.error })),
      ai: {
        conversations: aiTotal,
        cost: aiCost,
        prevConversations: p ? Object.values(p.aiModels).reduce((s, a) => s + a.conversations, 0) : null,
        models,
        scorecard: scorecard(models),
        assistants: Object.entries(m.aiAssistants)
          .map(([id, agg]) => ({ id, name: this.store.assistantName(id), topModel: Object.entries(agg.models).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null, ...deriveAi(agg, aiTotal) }))
          .sort((a, b) => b.conversations - a.conversations),
      },
    };
  }

  /**
   * Month pace: cumulative spend by day-of-month for this month and the
   * previous one, so you can see whether you're running ahead or behind.
   */
  pace(now = Date.now()) {
    const cur = new Date(now).toISOString().slice(0, 7);
    const prev = prevMonthKey(cur);
    const cumulative = (key, limitTs) => {
      const m = this.rollups.get(key);
      const { from, days } = monthBounds(key);
      const out = [];
      let acc = 0;
      for (let d = 0; d < days; d++) {
        const t = from + d * DAY;
        if (limitTs !== undefined && t > limitTs) break;
        acc += m?.days[new Date(t).toISOString().slice(0, 10)]?.cost ?? 0;
        out.push(acc);
      }
      return { month: key, days, values: out, total: m?.cost ?? null };
    };
    const current = cumulative(cur, now);
    const previous = cumulative(prev);
    const dayIdx = current.values.length - 1;
    const elapsed = Math.max(1, dayIdx + (now % DAY) / DAY);
    const projected = current.values.length ? (current.values[dayIdx] / elapsed) * current.days : null;
    const sameDayPrev = previous.values[Math.min(dayIdx, previous.values.length - 1)] ?? null;
    return {
      current, previous, projected,
      vsPrevSameDay: sameDayPrev ? (current.values[dayIdx] - sameDayPrev) / sameDayPrev : null,
      currency: this.store.balance?.currency ?? 'USD',
    };
  }

  /** One CSV with every section of a month's statement. */
  csv(key) {
    const r = this.build(key);
    const esc = (v) => {
      if (v === null || v === undefined) return '';
      const s = typeof v === 'number' ? String(Math.round(v * 1e6) / 1e6) : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = [];
    const section = (title, header, data) => { rows.push([`# ${title}`], header, ...data, []); };
    section('Summary', ['metric', 'value'], [
      ['month', r.month], ['currency', r.currency], ['status', r.coverage.status],
      ['total_spend', r.summary.cost], ['records', r.summary.count], ['failed_records', r.summary.failed],
      ['avg_daily_spend', r.summary.avgDaily], ['previous_month_spend', r.summary.prevCost], ['change_vs_previous', r.summary.change],
      ['peak_day', r.summary.peakDay?.day], ['peak_day_spend', r.summary.peakDay?.cost],
      ['balance_open', r.summary.balanceOpen], ['balance_close', r.summary.balanceClose],
      ['ai_conversations', r.ai.conversations], ['ai_spend', r.ai.cost],
    ]);
    section('Daily', ['day', 'spend', 'records'], r.daily.map((d) => [d.day, d.cost, d.count]));
    section('Products', ['product', 'spend', 'records', 'units', 'share', 'change_vs_previous'], r.products.map((x) => [x.key, x.cost, x.count, x.units, x.share, x.change]));
    section('Countries', ['country', 'spend', 'records', 'share'], r.countries.map((x) => [x.key, x.cost, x.count, x.share]));
    section('Billing groups', ['group', 'spend', 'records', 'share'], r.groups.map((x) => [x.label, x.cost, x.count, x.share]));
    section('Top numbers', ['number', 'spend', 'records', 'max_overestimate'], r.topNumbers.map((x) => [x.number, x.cost, x.count, x.maxError]));
    section('AI models', ['model', 'conversations', 'share', 'spend', 'cost_per_conversation', 'cost_per_resolved', 'resolution_rate', 'avg_latency_ms', 'minutes', 'tokens'],
      r.ai.models.map((x) => [x.model, x.conversations, x.share, x.cost, x.costPerConversation, x.costPerResolved, x.resolutionRate, x.avgLatencyMs, x.minutes, x.tokens]));
    section('AI assistants', ['assistant', 'top_model', 'conversations', 'spend', 'resolution_rate'], r.ai.assistants.map((x) => [x.name, x.topModel, x.conversations, x.cost, x.resolutionRate]));
    return rows.map((row) => row.map(esc).join(',')).join('\n');
  }

  /** One row per month — the "every month" export. */
  summaryCsv() {
    const header = ['month', 'status', 'spend', 'records', 'failed', 'ai_conversations', 'ai_spend', 'top_ai_model', 'top_product', 'balance_open', 'balance_close'];
    const rows = this.rollups.keys().map((key) => {
      const r = this.build(key);
      return [key, r.coverage.status, r.summary.cost, r.summary.count, r.summary.failed, r.ai.conversations, r.ai.cost,
        r.ai.models[0]?.model ?? '', r.products[0]?.key ?? '', r.summary.balanceOpen ?? '', r.summary.balanceClose ?? ''];
    });
    return [header, ...rows].map((row) => row.map((v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v)).join(',')).join('\n');
  }
}
