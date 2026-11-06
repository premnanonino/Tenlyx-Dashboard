import { useMemo, useState } from 'react';
import { useWidth } from '../../lib/hooks.js';
import { niceMax, num, shortModel, utcDate, utcDay, utcTime } from '../../lib/format.js';
import { SkeletonRows } from '../ui.jsx';
import { DataTable, LiveRegion, useChartKeys, KEY_HINT } from '../charts/a11y.jsx';

const H = 250;
const M = { l: 44, r: 8, t: 12, b: 30 };

/** Stacked bars of conversation counts per bucket, one flat colour per model. */
export default function ModelBars({ series, colorFor }) {
  const [ref, width] = useWidth();
  const [mouse, setHover] = useState(null);
  const { active: kActive, focusProps } = useChartKeys(series?.points.length ?? 0);
  const hover = kActive ?? mouse;

  const model = useMemo(() => {
    if (!series || !width) return null;
    const { max, step } = niceMax(Math.max(...series.points.map((p) => p.total), 1));
    const iw = width - M.l - M.r;
    const ih = H - M.t - M.b;
    const bw = iw / series.points.length;
    const gap = Math.max(1, Math.min(6, bw * 0.22));
    const y = (v) => M.t + ih - (v / max) * ih;
    const every = Math.ceil(series.points.length / Math.max(3, Math.floor(iw / 80)));
    const ticks = [];
    for (let v = 0; v <= max + 1e-9; v += step) ticks.push(v);
    // Draw the biggest model at the bottom.
    const keys = [...series.keys].reverse();
    return { iw, ih, bw, gap, y, every, ticks, keys };
  }, [series, width]);

  const label = (t, i) => {
    if (series.stepMs <= 3_600_000) return i % model.every === 0 ? utcTime(t, false) : '';
    if (series.stepMs < 86_400_000) return t % 86_400_000 === 0 ? utcDay(t) : '';
    return i % model.every === 0 ? utcDate(t) : '';
  };

  const hp = hover !== null && series ? series.points[hover] : null;

  return (
    <div ref={ref} className="chart">
      {!model ? <div style={{ height: H }}><SkeletonRows rows={7} h={22} /></div> : (
        <>
          <svg width={width} height={H} role="img" {...focusProps} aria-label={`Conversations per model over time. ${KEY_HINT}`}
            onMouseMove={(e) => {
              const i = Math.floor((e.clientX - e.currentTarget.getBoundingClientRect().left - M.l) / model.bw);
              setHover(i >= 0 && i < series.points.length ? i : null);
            }}
            onMouseLeave={() => setHover(null)}>
            {model.ticks.map((v) => (
              <g key={v}>
                <line x1={M.l} x2={width - M.r} y1={model.y(v)} y2={model.y(v)} className={v === 0 ? 'axis-base' : 'grid'} />
                <text x={M.l - 8} y={model.y(v)} className="tick" textAnchor="end" dominantBaseline="middle">{num(v)}</text>
              </g>
            ))}
            {hover !== null && <rect x={M.l + hover * model.bw} y={M.t} width={model.bw} height={model.ih} className="hover-col" />}
            {series.points.map((p, i) => {
              let acc = 0;
              const x = M.l + i * model.bw + model.gap / 2;
              const w = Math.max(1, model.bw - model.gap);
              return (
                <g key={`${series.stepMs}-${p.t}`} className="bar" style={{ '--d': `${i * 16}ms` }}>
                  {model.keys.map((k) => {
                    const v = p.by[k] || 0;
                    if (!v) return null;
                    const y0 = model.y(acc);
                    acc += v;
                    const y1 = model.y(acc);
                    return <rect key={k} x={x} y={y1} width={w} height={Math.max(0.5, y0 - y1)} style={{ fill: colorFor(k) }} />;
                  })}
                  <text x={x + w / 2} y={H - 10} className="tick" textAnchor="middle">{label(p.t, i)}</text>
                </g>
              );
            })}
          </svg>
          {hp && (
            <div className="tooltip mono" style={{ left: Math.min(M.l + hover * model.bw + model.bw + 8, width - 210), width: 200 }}>
              <p className="tooltip__head">{series.stepMs < 86_400_000 ? `${utcDate(hp.t)} ${utcTime(hp.t, false)}` : utcDate(hp.t)} UTC</p>
              {series.keys.map((k) => (
                <p key={k} className="tooltip__row"><i style={{ background: colorFor(k) }} /><span>{shortModel(k)}</span><b>{num(hp.by[k] || 0)}</b></p>
              ))}
              <p className="tooltip__row tooltip__total"><span>Conversations</span><b>{num(hp.total)}</b></p>
            </div>
          )}
          <LiveRegion text={hp ? `${utcDate(hp.t)} ${utcTime(hp.t, false)}: ${num(hp.total)} conversations; ${series.keys.map((k) => `${shortModel(k)} ${hp.by[k] || 0}`).join(', ')}` : ''} />
          <DataTable caption="Conversations per bucket by model" columns={['Bucket (UTC)', ...series.keys.map(shortModel)]}
            rows={series.points.map((p) => [`${utcDate(p.t)} ${utcTime(p.t, false)}`, ...series.keys.map((k) => num(p.by[k] || 0))])} />
          <ul className="legend mono">
            {series.keys.map((k) => <li key={k}><i style={{ background: colorFor(k) }} />{shortModel(k)}</li>)}
          </ul>
        </>
      )}
    </div>
  );
}
