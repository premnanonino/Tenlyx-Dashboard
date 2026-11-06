import { lowerBound } from '../dsa/search.js';
import { percentile } from '../dsa/RingBuffer.js';
import { topK } from '../dsa/MinHeap.js';

import { addAi } from './monthlyRollups.js';

const MIN_SAMPLE = 20; // a model needs this many conversations to win an award

const emptyAgg = () => ({ conversations: 0, cost: 0, minutes: 0, turns: 0, tokensIn: 0, tokensOut: 0, latencySum: 0, latencyN: 0, resolved: 0, transferred: 0, abandoned: 0, outcomeN: 0 });

/** Derived per-model / per-assistant metrics from a raw aggregate. */
export function deriveAi(a, total) {
  return {
    conversations: a.conversations,
    share: total ? a.conversations / total : 0,
    cost: a.cost,
    costPerConversation: a.conversations ? a.cost / a.conversations : null,
    costPerResolved: a.resolved ? a.cost / a.resolved : null,
    resolutionRate: a.outcomeN ? a.resolved / a.outcomeN : null,
    transferRate: a.outcomeN ? a.transferred / a.outcomeN : null,
    abandonRate: a.outcomeN ? a.abandoned / a.outcomeN : null,
    avgLatencyMs: a.latencyN ? a.latencySum / a.latencyN : null,
    minutes: a.minutes,
    avgDurationSec: a.conversations ? (a.minutes * 60) / a.conversations : null,
    avgTurns: a.conversations ? a.turns / a.conversations : null,
    tokens: a.tokensIn + a.tokensOut,
  };
}

/**
 * "Which model is better" depends on what you value, so the scorecard names
 * a winner per axis instead of inventing a single opaque score. Only models
 * with enough conversations to be meaningful are eligible.
 */
export function scorecard(models) {
  const eligible = models.filter((m) => m.conversations >= MIN_SAMPLE);
  const pick = (score, better) => {
    let best = null;
    for (const m of eligible) {
      const v = score(m);
      if (v === null || v === undefined) continue;
      if (!best || better(v, best.v)) best = { model: m.model, v };
    }
    return best;
  };
  return {
    mostUsed: models[0] ? { model: models[0].model, v: models[0].share } : null,
    bestResolution: pick((m) => m.resolutionRate, (a, b) => a > b),
    bestValue: pick((m) => m.costPerResolved, (a, b) => a < b),
    fastest: pick((m) => m.p50LatencyMs ?? m.avgLatencyMs, (a, b) => a < b),
    minSample: MIN_SAMPLE,
  };
}

export class AiAnalytics {
  constructor({ store }) {
    this.store = store;
  }

  overview(w) {
    const { step } = w;
    const start = w.from;
    const span = w.to - w.from;
    const arr = this.store.aiRecords;
    const lo = lowerBound(arr, w.from, (r) => r.ts); // O(log n) on the AI-only index
    const hi = lowerBound(arr, w.to, (r) => r.ts);

    const total = emptyAgg();
    const byModel = new Map();
    const byAssistant = new Map();
    const latencies = new Map();
    const channels = {};
    const allLat = [];

    for (let i = lo; i < hi; i++) {
      const r = arr[i];
      const a = r.ai;
      addAi(total, r);
      if (!byModel.has(a.model)) { byModel.set(a.model, emptyAgg()); latencies.set(a.model, []); }
      addAi(byModel.get(a.model), r);
      if (Number.isFinite(a.latencyMs)) { latencies.get(a.model).push(a.latencyMs); allLat.push(a.latencyMs); }
      const asId = a.assistantId || 'unknown';
      if (!byAssistant.has(asId)) byAssistant.set(asId, { ...emptyAgg(), models: {} });
      const as = byAssistant.get(asId);
      addAi(as, r);
      as.models[a.model] = (as.models[a.model] || 0) + 1;
      channels[a.channel] = (channels[a.channel] || 0) + 1;
    }

    // Rank every model by conversation volume (heap top-K with k = all).
    const ranked = topK(byModel.entries(), byModel.size, ([, agg]) => agg.conversations).map(([model, agg]) => {
      const lat = latencies.get(model);
      return {
        model,
        ...deriveAi(agg, total.conversations),
        p50LatencyMs: lat.length ? percentile(lat, 50) : null,
        p95LatencyMs: lat.length ? percentile(lat, 95) : null,
      };
    });

    // Conversations per bucket for the top 5 models, rest folded into "other".
    const top = ranked.slice(0, 5).map((m) => m.model);
    const keys = byModel.size > 5 ? [...top, 'other'] : top;
    const buckets = Math.round(span / step);
    const points = Array.from({ length: buckets }, (_, i) => ({ t: start + i * step, total: 0, by: Object.fromEntries(keys.map((k) => [k, 0])) }));
    for (let i = lo; i < hi; i++) {
      const r = arr[i];
      const b = Math.floor((r.ts - start) / step);
      if (b < 0 || b >= buckets) continue;
      const k = top.includes(r.ai.model) ? r.ai.model : 'other';
      points[b].by[k]++;
      points[b].total++;
    }

    const assistants = [...byAssistant.entries()]
      .map(([id, agg]) => ({
        id,
        name: this.store.assistantName(id),
        configuredModel: this.store.assistants.get(id)?.model ?? null,
        models: Object.entries(agg.models).sort((a, b) => b[1] - a[1]).map(([model, n]) => ({ model, conversations: n, share: n / agg.conversations })),
        ...deriveAi(agg, total.conversations),
      }))
      .sort((a, b) => b.conversations - a.conversations);

    // Latency histogram (100 ms bins, last bin = 2 s+) for all models and the top 3.
    const BIN = 100; const NB = 21;
    const hist = (xs) => { const h = new Array(NB).fill(0); for (const v of xs) h[Math.min(NB - 1, Math.floor(v / BIN))]++; return h; };
    const latency = {
      binMs: BIN,
      all: hist(allLat),
      models: ranked.slice(0, 3).map((m) => ({ model: m.model, bins: hist(latencies.get(m.model)) })),
    };

    return {
      range: w.key, from: w.from, to: w.to, stepMs: w.step,
      latency,
      totals: {
        ...deriveAi(total, total.conversations),
        p50LatencyMs: allLat.length ? percentile(allLat, 50) : null,
        models: byModel.size,
        assistants: byAssistant.size,
      },
      outcomes: { resolved: total.resolved, transferred: total.transferred, abandoned: total.abandoned, unknown: total.conversations - total.outcomeN },
      channels,
      models: ranked,
      scorecard: scorecard(ranked),
      series: { stepMs: step, keys, points },
      assistants,
    };
  }
}
