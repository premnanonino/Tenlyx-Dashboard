import { useMemo, useState } from 'react';
import { useWidth } from '../lib/hooks.js';
import { money, moneySmart, niceMax, num, productColor, productLabel, utcDate, utcDay, utcTime } from '../lib/format.js';
import { SkeletonRows } from './ui.jsx';
import { DataTable, LiveRegion, useChartKeys, KEY_HINT } from './charts/a11y.jsx';

const ORDER = ['numbers', 'messaging', 'voice', 'verify', 'sip'];
const H = 270;
const M = { l: 56, r: 8, t: 16, b: 30 };

/** Stacked bar chart of spend per bucket, one flat colour per product. */
export default function SpendChart({ data, currency }) {
  const [ref, width] = useWidth();
  const [mouse, setHover] = useState(null);
  const { active: kActive, focusProps } = useChartKeys(data?.points.length ?? 0);
  const hover = kActive ?? mouse;

  const model = useMemo(() => {
    if (!data || !width) return null;
    const products = [...data.products].sort((a, b) => {
      const ia = ORDER.indexOf(a); const ib = ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    const peak = Math.max(...data.points.map((p) => p.total), 0);
    const { max, step } = niceMax(peak);
    const iw = width - M.l - M.r;
    const ih = H - M.t - M.b;
    const bw = iw / data.points.length;
    const gap = Math.max(1, Math.min(6, bw * 0.22));
    const y = (v) => M.t + ih - (v / max) * ih;
    const every = Math.ceil(data.points.length / Math.max(3, Math.floor(iw / 80)));
    const label = (t, i) => {
      if (data.stepMs <= 3_600_000) return i % every === 0 ? utcTime(t, false) : '';
      if (data.stepMs < 86_400_000) return t % 86_400_000 === 0 ? utcDay(t) : '';
      return i % every === 0 ? utcDate(t) : '';
    };
    const ticks = [];
    for (let v = 0; v <= max + 1e-9; v += step) ticks.push(v);
    return { products, max, iw, ih, bw, gap, y, label, ticks };
  }, [data, width]);

  const onMove = (e) => {
    if (!model) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - rect.left - M.l) / model.bw);
    setHover(i >= 0 && i < data.points.length ? i : null);
  };

  const now = Date.now();
  const hp = hover !== null && data ? data.points[hover] : null;

  return (
    <div ref={ref} className="chart">
      {!model ? (
        <div style={{ height: H }}><SkeletonRows rows={7} h={22} /></div>
      ) : (
        <>
          <svg width={width} height={H} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" {...focusProps}
            aria-label={`Spend per ${data.stepMs >= 86_400_000 ? 'day' : `${data.stepMs / 3_600_000} hour`} bucket, stacked by product. ${KEY_HINT}`}>
            {model.ticks.map((v) => (
              <g key={v}>
                <line x1={M.l} x2={width - M.r} y1={model.y(v)} y2={model.y(v)} className={v === 0 ? 'axis-base' : 'grid'} />
                <text x={M.l - 8} y={model.y(v)} className="tick" textAnchor="end" dominantBaseline="middle">
                  {money(v, currency, model.max < 10 ? 2 : 0)}
                </text>
              </g>
            ))}

            {hover !== null && (
              <rect x={M.l + hover * model.bw} y={M.t} width={model.bw} height={model.ih} className="hover-col" />
            )}

            {data.points.map((p, i) => {
              let acc = 0;
              const x = M.l + i * model.bw + model.gap / 2;
              const w = Math.max(1, model.bw - model.gap);
              const isNow = now >= p.t && now < p.t + data.stepMs;
              return (
                <g key={`${data.range}-${p.t}`} className="bar" style={{ '--d': `${i * 16}ms` }}>
                  {model.products.map((prod) => {
                    const v = p.byProduct[prod] || 0;
                    if (v <= 0) return null;
                    const y0 = model.y(acc);
                    acc += v;
                    const y1 = model.y(acc);
                    return <rect key={prod} x={x} y={y1} width={w} height={Math.max(0.5, y0 - y1)} style={{ fill: productColor(prod) }} />;
                  })}
                  {isNow && <rect x={x} y={model.y(acc) - 7} width={w} height={3} fill="var(--accent)" className="now-cap" />}
                  <text x={x + w / 2} y={H - 10} className="tick" textAnchor="middle">{model.label(p.t, i)}</text>
                </g>
              );
            })}
          </svg>

          {hp && (
            <div className="tooltip mono" style={{ left: Math.min(M.l + hover * model.bw + model.bw + 8, width - 200) }}>
              <p className="tooltip__head">
                {data.stepMs < 86_400_000 ? `${utcDate(hp.t)} ${utcTime(hp.t, false)}` : utcDate(hp.t)} UTC
              </p>
              {model.products.slice().reverse().map((prod) => (
                <p key={prod} className="tooltip__row">
                  <i style={{ background: productColor(prod) }} />
                  <span>{productLabel(prod)}</span>
                  <b>{moneySmart(hp.byProduct[prod] || 0, currency)}</b>
                </p>
              ))}
              <p className="tooltip__row tooltip__total"><span>Total · {num(hp.count)} rec</span><b>{money(hp.total, currency)}</b></p>
            </div>
          )}
          <LiveRegion text={hp ? `${data.stepMs < 86_400_000 ? `${utcDate(hp.t)} ${utcTime(hp.t, false)}` : utcDate(hp.t)}: ${money(hp.total, currency)} across ${num(hp.count)} records` : ''} />
          <DataTable caption="Spend per bucket" columns={['Bucket (UTC)', 'Total', ...model.products.map(productLabel)]}
            rows={data.points.map((p) => [data.stepMs < 86_400_000 ? `${utcDate(p.t)} ${utcTime(p.t, false)}` : utcDate(p.t), money(p.total, currency), ...model.products.map((pr) => moneySmart(p.byProduct[pr] || 0, currency))])} />
        </>
      )}
    </div>
  );
}
