import { useMemo } from 'react';
import { useWidth } from '../lib/hooks.js';
import { money, utcDate, utcTime } from '../lib/format.js';
import { SkeletonRows } from './ui.jsx';
import { DataTable } from './charts/a11y.jsx';

const H = 190;
const M = { l: 4, r: 4, t: 14, b: 22 };

/** Balance line. Reconstructed (estimated) history is drawn dashed. */
export default function BalanceChart({ data, currency }) {
  const [ref, width] = useWidth();

  const model = useMemo(() => {
    if (!data || !width || data.points.length < 2) return null;
    const pts = data.points;
    const t0 = pts[0].ts; const t1 = pts[pts.length - 1].ts;
    let lo = Infinity; let hi = -Infinity;
    for (const p of pts) { lo = Math.min(lo, p.v); hi = Math.max(hi, p.v); }
    const pad = Math.max((hi - lo) * 0.15, 1);
    lo -= pad; hi += pad;
    const x = (t) => M.l + ((t - t0) / Math.max(1, t1 - t0)) * (width - M.l - M.r);
    const y = (v) => M.t + (1 - (v - lo) / (hi - lo)) * (H - M.t - M.b);
    const toPath = (arr) => arr.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
    const splitAt = pts.findIndex((p) => !p.est);
    const est = splitAt > 0 ? pts.slice(0, splitAt + 1) : splitAt === -1 ? pts : [];
    const real = splitAt >= 0 ? pts.slice(splitAt) : [];
    const area = `${toPath(pts)}L${x(t1).toFixed(1)},${H - M.b}L${x(t0).toFixed(1)},${H - M.b}Z`;
    const last = pts[pts.length - 1];
    return { x, y, est: toPath(est), real: toPath(real), area, last, first: pts[0], t0, t1, hasEst: est.length > 1 };
  }, [data, width]);

  const change = model ? model.last.v - model.first.v : 0;
  return (
    <div ref={ref} className="chart">
      {!data ? (
        <SkeletonRows rows={5} h={20} />
      ) : !model ? (
        <p className="empty mono">Collecting balance snapshots…</p>
      ) : (
        <>
          <div className="bal-head">
            <span className="mono bal-head__v">{money(model.last.v, currency)}</span>
            <span className="mono bal-head__d">
              {change >= 0 ? '+' : '−'}{money(Math.abs(change), currency)} over {data.range === 'custom' ? 'range' : data.range}
            </span>
          </div>
          <svg width={width} height={H} role="img" aria-label={`Balance over ${data.range === 'custom' ? 'the selected range' : data.range}: from ${money(model.first.v, currency)} to ${money(model.last.v, currency)}`}>
            <path d={model.area} className="bal-area" />
            {model.hasEst && <path d={model.est} className="bal-line bal-line--est" pathLength="1" />}
            {model.real && <path d={model.real} className="bal-line" pathLength="1" key={`${data.range}-${model.t0}`} />}
            <circle cx={model.x(model.last.ts)} cy={model.y(model.last.v)} r="3.5" className="bal-dot" />
            <circle cx={model.x(model.last.ts)} cy={model.y(model.last.v)} r="3.5" className="bal-pulse" />
            <text x={M.l} y={H - 6} className="tick">{utcDate(model.t0)} {utcTime(model.t0, false)}</text>
            <text x={width - M.r} y={H - 6} className="tick" textAnchor="end">now</text>
          </svg>
          <DataTable caption="Balance summary" columns={['Point', 'Balance']}
            rows={[['Start', money(model.first.v, currency)], ['Lowest', money(Math.min(...data.points.map((p) => p.v)), currency)],
              ['Highest', money(Math.max(...data.points.map((p) => p.v)), currency)], ['Now', money(model.last.v, currency)]]} />
          {model.hasEst && <p className="foot-note mono">dashed = reconstructed from spend (before first poll)</p>}
        </>
      )}
    </div>
  );
}
