import { useState } from 'react';
import { useWidth } from '../../lib/hooks.js';
import { niceMax, num, utcDate, utcTime } from '../../lib/format.js';

const H = 190;
const PAD = { t: 10, r: 8, b: 22, l: 36 };

/** Calls per bucket, booked calls stacked at the base. Hover shows the bucket. */
export default function CallsChart({ series }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const pts = series?.points ?? [];
  const hourly = series?.stepMs < 86_400_000;
  const { max, step } = niceMax(Math.max(1, ...pts.map((p) => p.total)));
  const innerW = Math.max(0, width - PAD.l - PAD.r);
  const innerH = H - PAD.t - PAD.b;
  const bw = pts.length ? innerW / pts.length : 0;
  const y = (v) => PAD.t + innerH - (v / max) * innerH;
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
  const labelEvery = Math.max(1, Math.ceil(pts.length / Math.max(1, Math.floor(innerW / 64))));
  const label = (t) => (hourly ? `${utcTime(t, false)}` : utcDate(t));
  const h = hover !== null ? pts[hover] : null;

  return (
    <div className="cchart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={H} role="img" aria-label={`Calls per ${hourly ? 'hour' : 'day'}, booked calls highlighted`}
          onMouseLeave={() => setHover(null)}>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={PAD.l} x2={width - PAD.r} y1={y(v)} y2={y(v)} className="cchart__grid" />
              <text x={PAD.l - 6} y={y(v) + 4} className="cchart__axis" textAnchor="end">{num(v)}</text>
            </g>
          ))}
          {pts.map((p, i) => {
            const x = PAD.l + i * bw;
            const gap = bw > 6 ? 1.5 : 0.5;
            return (
              <g key={p.t} onMouseEnter={() => setHover(i)} className="cchart__col" style={{ '--i': Math.min(i, 60) }}>
                <rect x={x} y={PAD.t} width={bw} height={innerH} fill="transparent" />
                {p.total > 0 && <rect x={x + gap} y={y(p.total)} width={Math.max(0.5, bw - gap * 2)} height={y(0) - y(p.total)} className={`cchart__all ${hover === i ? 'is-hover' : ''}`} />}
                {p.booked > 0 && <rect x={x + gap} y={y(p.booked)} width={Math.max(0.5, bw - gap * 2)} height={y(0) - y(p.booked)} className="cchart__booked" />}
                {i % labelEvery === 0 && <text x={x + bw / 2} y={H - 6} className="cchart__axis" textAnchor="middle">{label(p.t)}</text>}
              </g>
            );
          })}
        </svg>
      )}
      <div className="cchart__legend mono">
        <span><i className="cchart__sw cchart__sw--all" /> all calls</span>
        <span><i className="cchart__sw cchart__sw--booked" /> booked</span>
        {h && (
          <span className="cchart__tip">
            {hourly ? `${utcDate(h.t)} ${utcTime(h.t, false)}` : utcDate(h.t)} · <b>{num(h.total)}</b> calls · <b>{num(h.booked)}</b> booked
          </span>
        )}
      </div>
    </div>
  );
}
