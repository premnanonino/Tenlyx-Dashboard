import { RingBuffer } from '../dsa/RingBuffer.js';
import { meanStd } from '../dsa/search.js';

const HOUR = 3_600_000;

/**
 * Rule-based alerting with state: an alert fires once when its condition
 * becomes true, stays "active" while true, and is resolved when it clears.
 * No flapping spam — only transitions are published.
 */
export class AlertEngine {
  constructor({ store, analytics, bus, scheduler, breaker, config }) {
    Object.assign(this, { store, analytics, bus, scheduler, breaker });
    this.thresholds = { ...config.alerts };
    this.poll = config.poll;
    this.active = new Map();
    this.history = new RingBuffer(200);
  }

  setThresholds(patch) {
    for (const k of ['lowBalance', 'runwayDays', 'spikeZ']) {
      if (patch[k] === undefined) continue;
      const v = Number(patch[k]);
      if (!Number.isFinite(v) || v < 0) throw Object.assign(new Error(`invalid ${k}`), { status: 400 });
      this.thresholds[k] = v;
    }
    this.evaluate();
    return this.thresholds;
  }

  #rules(now) {
    const out = [];
    const t = this.thresholds;
    const b = this.store.balance;
    const ov = this.analytics.overview(now);
    const cur = b?.currency ?? 'USD';

    if (b) {
      out.push({
        key: 'low_balance', severity: 'critical', when: b.availableCredit < t.lowBalance,
        title: 'Available credit below threshold',
        detail: `${b.availableCredit.toFixed(2)} ${cur} available, threshold ${t.lowBalance} ${cur}`,
      });
      out.push({
        key: 'runway', severity: 'warning', when: ov.runwayDays !== null && ov.runwayDays < t.runwayDays,
        title: 'Credit runway is short',
        detail: `~${ov.runwayDays?.toFixed(1)} days left at the 7-day average burn`,
      });
    }

    // Spend spike: z-score of the last complete hour vs the 7 days before it.
    const endHour = Math.floor(now / HOUR) * HOUR;
    const last = this.store.total.sum(endHour - HOUR, endHour);
    const hist = this.store.total.buckets(endHour - 169 * HOUR, endHour - HOUR).map((x) => x.v);
    const { mean, std, n } = meanStd(hist);
    const z = std > 0 ? (last - mean) / std : 0;
    out.push({
      key: 'spend_spike', severity: 'warning', when: n >= 24 && z >= t.spikeZ && last > 0.5,
      title: 'Hourly spend spike',
      detail: `${last.toFixed(2)} ${cur} last hour vs ${mean.toFixed(2)} avg (z = ${z.toFixed(1)})`,
    });

    const bs = this.breaker.stats();
    out.push({
      key: 'upstream_down', severity: 'critical', when: bs.state === 'OPEN',
      title: 'Telnyx API circuit open',
      detail: `Upstream calls short-circuited; retry in ${Math.ceil(bs.reopensInMs / 1000)}s`,
    });

    const job = this.scheduler.stats().find((j) => j.name === 'records');
    const staleMs = this.poll.recordsMs * 5;
    out.push({
      key: 'stale_data', severity: 'warning', when: !!job && job.lastOkAt > 0 && now - job.lastOkAt > staleMs,
      title: 'Usage data is stale',
      detail: `No successful record sync for ${Math.round((now - (job?.lastOkAt || now)) / 1000)}s`,
    });
    return out;
  }

  evaluate(now = Date.now()) {
    for (const rule of this.#rules(now)) {
      const current = this.active.get(rule.key);
      if (rule.when && !current) {
        const alert = { id: `${rule.key}-${now}`, key: rule.key, severity: rule.severity, title: rule.title, detail: rule.detail, firedAt: now, resolvedAt: null };
        this.active.set(rule.key, alert);
        this.history.push(alert);
        this.bus.publish('alert', { action: 'fired', alert });
      } else if (rule.when && current) {
        current.detail = rule.detail; // keep numbers fresh, no new event
      } else if (!rule.when && current) {
        current.resolvedAt = now;
        this.active.delete(rule.key);
        this.bus.publish('alert', { action: 'resolved', alert: current });
      }
    }
  }

  list() {
    return {
      thresholds: this.thresholds,
      active: [...this.active.values()],
      history: this.history.toArray().reverse().slice(0, 50),
    };
  }
}
