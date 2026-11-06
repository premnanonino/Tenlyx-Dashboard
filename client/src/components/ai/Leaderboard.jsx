import { useMemo, useState } from 'react';
import { compact, duration, money, moneySmart, ms, num, pct, splitModel } from '../../lib/format.js';

const COLS = [
  { key: 'conversations', label: 'Conversations', desc: true },
  { key: 'share', label: 'Share', desc: true },
  { key: 'cost', label: 'Spend', desc: true },
  { key: 'costPerConversation', label: '$ / conv', desc: false },
  { key: 'costPerResolved', label: '$ / resolved', desc: false },
  { key: 'resolutionRate', label: 'Resolved', desc: true },
  { key: 'transferRate', label: 'Transfer', desc: false },
  { key: 'p50LatencyMs', label: 'p50', desc: false },
  { key: 'p95LatencyMs', label: 'p95', desc: false },
  { key: 'avgDurationSec', label: 'Avg length', desc: false },
  { key: 'tokens', label: 'Tokens', desc: true },
];

/** Sortable model table. Rank stays tied to usage, whatever the sort. */
export default function Leaderboard({ models, colorFor, currency, best }) {
  const [sort, setSort] = useState({ key: 'conversations', desc: true });
  const rows = useMemo(() => {
    const ranked = models.map((m, i) => ({ ...m, rank: i + 1 }));
    return ranked.sort((a, b) => {
      const av = a[sort.key]; const bv = b[sort.key];
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      return sort.desc ? bv - av : av - bv;
    });
  }, [models, sort]);
  const maxConv = Math.max(...models.map((m) => m.conversations), 1);

  const fmt = {
    conversations: (v) => num(v),
    share: (v) => pct(v),
    cost: (v) => money(v, currency),
    costPerConversation: (v) => moneySmart(v, currency),
    costPerResolved: (v) => moneySmart(v, currency),
    resolutionRate: (v) => pct(v),
    transferRate: (v) => pct(v),
    p50LatencyMs: ms,
    p95LatencyMs: ms,
    avgDurationSec: duration,
    tokens: compact,
  };
  const awardFor = (model, key) => (
    (key === 'resolutionRate' && best?.bestResolution?.model === model)
    || (key === 'costPerResolved' && best?.bestValue?.model === model)
    || (key === 'p50LatencyMs' && best?.fastest?.model === model)
  );

  return (
    <div className="tbl-wrap">
      <table className="tbl leaderboard">
        <thead>
          <tr>
            <th className="rank">#</th>
            <th>Model</th>
            {COLS.map((c) => (
              <th key={c.key} className="r" aria-sort={sort.key === c.key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
                <button type="button" className={`th-sort ${sort.key === c.key ? 'is-on' : ''}`}
                  onClick={() => setSort((s) => (s.key === c.key ? { key: c.key, desc: !s.desc } : { key: c.key, desc: c.desc }))}>
                  {c.label}<span aria-hidden>{sort.key === c.key ? (sort.desc ? '▼' : '▲') : '·'}</span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((m, i) => {
            const { vendor, name } = splitModel(m.model);
            return (
              <tr key={m.model} style={{ '--d': `${i * 40}ms` }}>
                <td className="rank mono">{String(m.rank).padStart(2, '0')}</td>
                <td className="model-cell">
                  <i className="sq" style={{ background: colorFor(m.model) }} />
                  <span className="mono dim">{vendor}/</span><b>{name}</b>
                </td>
                {COLS.map((c) => (
                  <td key={c.key} className={`r mono ${awardFor(m.model, c.key) ? 'best' : ''}`}>
                    {c.key === 'conversations' ? (
                      <span className="conv-cell">
                        <span className="meter meter--inline"><i style={{ width: `${(m.conversations / maxConv) * 100}%`, background: colorFor(m.model) }} /></span>
                        {fmt[c.key](m[c.key])}
                      </span>
                    ) : fmt[c.key](m[c.key])}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
