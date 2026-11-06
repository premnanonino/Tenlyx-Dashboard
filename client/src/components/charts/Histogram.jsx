import { useMemo, useState } from 'react';
import { useWidth } from '../../lib/hooks.js';
import { niceMax, num, pct, shortModel } from '../../lib/format.js';
import { Tabs } from '../ui.jsx';
import { DataTable, LiveRegion, useChartKeys, KEY_HINT } from './a11y.jsx';

const H = 220;
const M = { l: 44, r: 8, t: 12, b: 30 };

/** Latency distribution in 100 ms bins, switchable between all models and the top 3. */
export default function Histogram({ latency, colorFor }) {
  const [ref, width] = useWidth();
  const [sel, setSel] = useState('all');
  const series = sel === 'all' ? latency.all : latency.models.find((x) => x.model === sel)?.bins ?? latency.all;
  const { active, focusProps } = useChartKeys(series.length);
  const total = series.reduce((a, b) => a + b, 0);

  const m = useMemo(() => {
    if (!width) return null;
    const { max, step } = niceMax(Math.max(...series, 1));
    const bw = (width - M.l - M.r) / series.length;
    const y = (v) => M.t + (1 - v / max) * (H - M.t - M.b);
    const ticks = [];
    for (let v = 0; v <= max + 1e-9; v += step) ticks.push(v);
    // Median bin, for the marker line.
    let acc = 0; let med = 0;
    for (let i = 0; i < series.length; i++) { acc += series[i]; if (acc >= total / 2) { med = i; break; } }
    return { bw, y, ticks, med };
  }, [width, series, total]);

  const binLabel = (i) => (i === series.length - 1 ? `${(i * latency.binMs) / 1000}s+` : `${i * latency.binMs}–${(i + 1) * latency.binMs} ms`);
  const describe = (i) => `${binLabel(i)}: ${num(series[i])} conversations, ${pct(total ? series[i] / total : 0)}`;
  const color = sel === 'all' ? 'var(--ink)' : colorFor(sel);

  return (
    <div ref={ref} className="chart">
      <div className="chart-tools">
        <Tabs value={sel} onChange={setSel} label="Latency series"
          options={[{ value: 'all', label: 'All' }, ...latency.models.map((x) => ({ value: x.model, label: shortModel(x.model) }))]} />
      </div>
      {m && (
        <svg width={width} height={H} role="img" {...focusProps} aria-label={`Response latency distribution. ${KEY_HINT}`}>
          {m.ticks.map((v) => (
            <g key={v}>
              <line x1={M.l} x2={width - M.r} y1={m.y(v)} y2={m.y(v)} className={v === 0 ? 'axis-base' : 'grid'} />
              <text x={M.l - 8} y={m.y(v)} className="tick" textAnchor="end" dominantBaseline="middle">{num(v)}</text>
            </g>
          ))}
          {series.map((v, i) => (
            <rect key={`${sel}-${i}`} x={M.l + i * m.bw + 1} y={m.y(v)} width={Math.max(1, m.bw - 2)} height={Math.max(0, H - M.b - m.y(v))}
              style={{ fill: i === series.length - 1 ? 'var(--crit)' : color, '--d': `${i * 20}ms` }} className={`bar ${active !== null && active !== i ? 'is-dim' : ''}`}
            />
          ))}
          <line x1={M.l + (m.med + 0.5) * m.bw} x2={M.l + (m.med + 0.5) * m.bw} y1={M.t} y2={H - M.b} className="median-line" />
          <text x={M.l + (m.med + 0.5) * m.bw + 4} y={M.t + 8} className="tick median-l">median</text>
          {[0, 5, 10, 15, 20].map((i) => <text key={i} x={M.l + i * m.bw} y={H - 10} className="tick">{i === 20 ? '2s+' : `${i * 100}`}</text>)}
        </svg>
      )}
      {active !== null && <p className="chart-readout mono">{describe(active)}</p>}
      <p className="foot-note mono">milliseconds to first response · red bar = 2 s or slower</p>
      <LiveRegion text={active !== null ? describe(active) : ''} />
      <DataTable caption="Latency distribution" columns={['Bin', 'Conversations']} rows={series.map((v, i) => [binLabel(i), num(v)])} />
    </div>
  );
}
