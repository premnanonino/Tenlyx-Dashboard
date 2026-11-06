import { useMemo } from 'react';
import { useWidth } from '../../lib/hooks.js';
import { money, monthName, niceMax, signedPct } from '../../lib/format.js';
import { DataTable, LiveRegion, useChartKeys, KEY_HINT } from './a11y.jsx';
import { SkeletonRows } from '../ui.jsx';

const H = 230;
const M = { l: 56, r: 64, t: 14, b: 28 };

/** Cumulative spend by day-of-month: this month vs last, plus projection. */
export default function PaceChart({ data }) {
  const [ref, width] = useWidth();
  const cur = data?.current;
  const prev = data?.previous;
  const { active, focusProps } = useChartKeys(cur?.values.length ?? 0);

  const m = useMemo(() => {
    if (!data || !width) return null;
    const days = Math.max(cur.days, prev.days);
    const peak = Math.max(...prev.values, data.projected ?? 0, ...cur.values, 1);
    const { max, step } = niceMax(peak);
    const x = (d) => M.l + (d / (days - 1)) * (width - M.l - M.r);
    const y = (v) => M.t + (1 - v / max) * (H - M.t - M.b);
    const path = (vals) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const ticks = [];
    for (let v = 0; v <= max + 1e-9; v += step) ticks.push(v);
    const last = cur.values.length - 1;
    return { x, y, path, ticks, days, last };
  }, [data, width, cur, prev]);

  const cy = data?.currency ?? 'USD';
  const describe = (i) => `Day ${i + 1}: ${money(cur.values[i], cy, 0)} this month, ${prev.values[i] !== undefined ? money(prev.values[i], cy, 0) : 'n/a'} last month`;

  return (
    <div ref={ref} className="chart">
      {!m ? <SkeletonRows rows={6} h={22} /> : (
        <>
          <p className="pace-head mono">
            <b>{money(cur.values[m.last] ?? 0, cy, 0)}</b> so far ·{' '}
            <span className={data.vsPrevSameDay > 0 ? 'tone-up' : 'tone-down'}>{signedPct(data.vsPrevSameDay)}</span> vs same day last month ·
            projected <b>{money(data.projected, cy, 0)}</b>
          </p>
          <svg width={width} height={H} role="img" {...focusProps}
            aria-label={`Month pace for ${monthName(cur.month)} versus ${monthName(prev.month)}. ${KEY_HINT}`}>
            {m.ticks.map((v) => (
              <g key={v}>
                <line x1={M.l} x2={width - M.r} y1={m.y(v)} y2={m.y(v)} className={v === 0 ? 'axis-base' : 'grid'} />
                <text x={M.l - 8} y={m.y(v)} className="tick" textAnchor="end" dominantBaseline="middle">{money(v, cy, 0)}</text>
              </g>
            ))}
            {[0, 9, 19, m.days - 1].map((d) => <text key={d} x={m.x(d)} y={H - 8} className="tick" textAnchor="middle">{d + 1}</text>)}

            <path d={m.path(prev.values)} className="pace-prev" />
            <text x={m.x(prev.values.length - 1) + 6} y={m.y(prev.values.at(-1) ?? 0)} className="tick" dominantBaseline="middle">{monthName(prev.month).slice(0, 3)}</text>

            {data.projected !== null && (
              <line x1={m.x(m.last)} y1={m.y(cur.values[m.last])} x2={m.x(cur.days - 1)} y2={m.y(data.projected)} className="pace-proj" />
            )}
            <path d={m.path(cur.values)} className="pace-cur" pathLength="1" />
            <circle cx={m.x(m.last)} cy={m.y(cur.values[m.last])} r="4" className="bal-dot" />
            {data.projected !== null && (
              <text x={m.x(cur.days - 1) + 6} y={m.y(data.projected)} className="tick pace-proj-l" dominantBaseline="middle">proj.</text>
            )}

            {active !== null && (
              <g>
                <line x1={m.x(active)} x2={m.x(active)} y1={M.t} y2={H - M.b} className="guide" />
                <circle cx={m.x(active)} cy={m.y(cur.values[active])} r="5" className="focus-dot" />
              </g>
            )}
          </svg>
          {active !== null && <p className="chart-readout mono">{describe(active)}</p>}
          <ul className="legend mono">
            <li><i style={{ background: 'var(--ink)' }} />{monthName(cur.month)}</li>
            <li><i className="legend__dash" />{monthName(prev.month)}</li>
            <li><i className="legend__dot" />projection</li>
          </ul>
          <LiveRegion text={active !== null ? describe(active) : ''} />
          <DataTable caption="Cumulative spend by day of month" columns={['Day', monthName(cur.month), monthName(prev.month)]}
            rows={prev.values.map((v, i) => [i + 1, cur.values[i] !== undefined ? money(cur.values[i], cy, 0) : '—', money(v, cy, 0)])} />
        </>
      )}
    </div>
  );
}
