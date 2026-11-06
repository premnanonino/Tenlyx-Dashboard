import { useState } from 'react';
import { moneySmart, ms, pct, shortModel } from '../../lib/format.js';
import { DataTable } from './a11y.jsx';

const AXES = [
  { key: 'volume', label: 'Volume', raw: (m) => m.share, better: 'high', fmt: (v) => pct(v) },
  { key: 'resolution', label: 'Resolution', raw: (m) => m.resolutionRate, better: 'high', fmt: (v) => pct(v) },
  { key: 'value', label: 'Value', raw: (m) => m.costPerResolved, better: 'low', fmt: (v) => `${moneySmart(v)}/res` },
  { key: 'speed', label: 'Speed', raw: (m) => m.p50LatencyMs, better: 'low', fmt: ms },
  { key: 'containment', label: 'Containment', raw: (m) => (m.transferRate === null ? null : 1 - m.transferRate), better: 'high', fmt: (v) => pct(v) },
];

/**
 * Model profile radar. Each axis is scaled so the best model on that axis
 * reaches the rim (higher-is-better: v / max; lower-is-better: min / v).
 * Outlines only, with a light flat fill on the highlighted model.
 */
export default function Radar({ models, colorFor, size = 300 }) {
  const top = models.slice(0, 4);
  const [focus, setFocus] = useState(null);
  const R = size / 2 - 46;
  const c = size / 2;

  const best = AXES.map((a) => {
    const vals = top.map(a.raw).filter((v) => v !== null && v !== undefined);
    return a.better === 'high' ? Math.max(...vals) : Math.min(...vals);
  });
  const score = (m, i) => {
    const v = AXES[i].raw(m);
    if (v === null || v === undefined || !best[i]) return 0;
    return AXES[i].better === 'high' ? v / best[i] : best[i] / v;
  };
  const pt = (i, s) => {
    const ang = -Math.PI / 2 + (i * 2 * Math.PI) / AXES.length;
    return [c + Math.cos(ang) * R * s, c + Math.sin(ang) * R * s];
  };

  return (
    <div className="radar">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img"
        aria-label={`Model profiles across ${AXES.map((a) => a.label).join(', ')}. Details in the table that follows.`}>
        {[0.25, 0.5, 0.75, 1].map((s) => (
          <polygon key={s} points={AXES.map((_, i) => pt(i, s).join(',')).join(' ')} className="radar__ring" />
        ))}
        {AXES.map((a, i) => {
          const [x, y] = pt(i, 1);
          const [lx, ly] = pt(i, 1.2);
          return (
            <g key={a.key}>
              <line x1={c} y1={c} x2={x} y2={y} className="radar__axis" />
              <text x={lx} y={ly} className="tick radar__label" textAnchor="middle" dominantBaseline="middle">{a.label}</text>
            </g>
          );
        })}
        {top.map((m, k) => {
          const pts = AXES.map((_, i) => pt(i, score(m, i)).join(',')).join(' ');
          const on = focus === m.model;
          return (
            <polygon key={m.model} points={pts} className={`radar__shape ${focus && !on ? 'is-dim' : ''} ${on ? 'is-on' : ''}`}
              style={{ stroke: colorFor(m.model), fill: on ? colorFor(m.model) : 'none', animationDelay: `${k * 120}ms` }} />
          );
        })}
      </svg>
      <ul className="radar__legend">
        {top.map((m) => (
          <li key={m.model}>
            <button type="button" aria-pressed={focus === m.model} className={focus === m.model ? 'is-on' : ''}
              onClick={() => setFocus((f) => (f === m.model ? null : m.model))}
              onMouseEnter={() => setFocus(m.model)} onMouseLeave={() => setFocus(null)}
              onFocus={() => setFocus(m.model)} onBlur={() => setFocus(null)}>
              <i style={{ background: colorFor(m.model) }} />{shortModel(m.model)}
            </button>
          </li>
        ))}
      </ul>
      <p className="foot-note mono">rim = best of these models on that axis</p>
      <DataTable caption="Model profile by axis" columns={['Model', ...AXES.map((a) => a.label)]}
        rows={top.map((m) => [m.model, ...AXES.map((a) => { const v = a.raw(m); return v === null || v === undefined ? '—' : a.fmt(v); })])} />
    </div>
  );
}
