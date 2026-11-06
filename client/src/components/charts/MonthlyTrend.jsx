import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useWidth } from '../../lib/hooks.js';
import { money, monthName, niceMax, productColor, productLabel } from '../../lib/format.js';
import { DataTable } from './a11y.jsx';

const H = 200;
const M = { l: 56, r: 8, t: 12, b: 28 };
const ORDER = ['numbers', 'messaging', 'voice', 'verify', 'sip', 'ai'];

/**
 * Spend per month stacked by product. Each column is a real link to that
 * month's statement, so it is clickable and reachable with Tab + Enter.
 */
export default function MonthlyTrend({ items, active, currency }) {
  const [ref, width] = useWidth();
  const months = useMemo(() => [...items].reverse(), [items]); // oldest -> newest
  const m = useMemo(() => {
    if (!width || !months.length) return null;
    const { max, step } = niceMax(Math.max(...months.map((x) => x.cost), 1));
    const bw = (width - M.l - M.r) / months.length;
    const y = (v) => M.t + (1 - v / max) * (H - M.t - M.b);
    const ticks = [];
    for (let v = 0; v <= max + 1e-9; v += step) ticks.push(v);
    const products = [...new Set(months.flatMap((x) => Object.keys(x.byProduct || {})))]
      .sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
    return { bw, y, ticks, products };
  }, [width, months]);

  return (
    <div ref={ref} className="chart trend">
      {m && (
        <svg width={width} height={H} aria-labelledby="trend-title">
          <title id="trend-title">Spend per month by product. Each column links to its statement.</title>
          {m.ticks.map((v) => (
            <g key={v}>
              <line x1={M.l} x2={width - M.r} y1={m.y(v)} y2={m.y(v)} className={v === 0 ? 'axis-base' : 'grid'} />
              <text x={M.l - 8} y={m.y(v)} className="tick" textAnchor="end" dominantBaseline="middle">{money(v, currency, 0)}</text>
            </g>
          ))}
          {months.map((mo, i) => {
            let acc = 0;
            const w = Math.min(64, m.bw * 0.6);
            const x = M.l + i * m.bw + (m.bw - w) / 2;
            return (
              <Link key={mo.month} to={`/dashboard/reports/${mo.month}`} className={`trend__col ${mo.month === active ? 'is-active' : ''}`}
                aria-label={`${monthName(mo.month)}: ${money(mo.cost, currency)}${mo.status === 'in_progress' ? ', in progress' : ''}`}>
                <rect x={M.l + i * m.bw} y={M.t} width={m.bw} height={H - M.t - M.b} className="trend__hit" />
                <g className="bar" style={{ '--d': `${i * 60}ms` }}>
                  {m.products.map((p) => {
                    const v = mo.byProduct?.[p] || 0;
                    if (!v) return null;
                    const y0 = m.y(acc); acc += v; const y1 = m.y(acc);
                    return <rect key={p} x={x} y={y1} width={w} height={Math.max(0.5, y0 - y1)} style={{ fill: productColor(p) }}
                      className={mo.status === 'in_progress' ? 'is-partial' : ''} />;
                  })}
                </g>
                <text x={x + w / 2} y={H - 9} className="tick" textAnchor="middle">{monthName(mo.month).slice(0, 3)}</text>
              </Link>
            );
          })}
        </svg>
      )}
      <DataTable caption="Spend per month" columns={['Month', 'Spend', ...(m?.products ?? []).map(productLabel)]}
        rows={months.map((mo) => [monthName(mo.month), money(mo.cost, currency), ...(m?.products ?? []).map((p) => money(mo.byProduct?.[p] || 0, currency))])} />
    </div>
  );
}
