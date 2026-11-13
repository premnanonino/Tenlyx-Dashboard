import { useMemo, useState } from 'react';
import { useWidth } from '../../lib/hooks.js';
import { niceMax, num, pct, utcDate, utcTime } from '../../lib/format.js';

const H = 190;
const PAD = { t: 10, r: 8, b: 22, l: 36 };
const SLOTS = 7; // named outcomes; the rest fold into "Other"

/**
 * Stable outcome → series mapping. `order` is the outcome list for the whole
 * history (most common first), so an outcome keeps its color when the range or
 * filters change. Outcomes past the first SLOTS fold into "Other"; calls with
 * no outcome get their own neutral series.
 */
function useSeries(order) {
  return useMemo(() => {
    const named = (order ?? []).filter((o) => o.id !== 'none').slice(0, SLOTS);
    const slotOf = new Map(named.map((o, i) => [o.id, i]));
    const series = [
      ...named.map((o, i) => ({ key: o.id, label: o.label, cls: `cchart__s${i + 1}`, pick: o.id })),
      { key: '__other', label: 'Other', cls: 'cchart__sother', pick: null },
      { key: 'none', label: 'No outcome', cls: 'cchart__snone', pick: 'none' },
    ];
    const keyOf = (id) => (id === 'none' ? 'none' : slotOf.has(id) ? id : '__other');
    return { series, keyOf };
  }, [order]);
}

/** Per-bucket counts by series key. */
function stack(p, keyOf) {
  const out = {};
  for (const [id, n] of Object.entries(p.by ?? {})) {
    const k = keyOf(id);
    out[k] = (out[k] || 0) + n;
  }
  return out;
}

/** Calls per bucket, stacked by outcome. Hover shows the bucket's breakdown; legend click filters. */
export default function CallsChart({ series: data, order, active, onPick }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const { series, keyOf } = useSeries(order);
  const pts = data?.points ?? [];
  const stacks = useMemo(() => pts.map((p) => stack(p, keyOf)), [pts, keyOf]);
  const present = useMemo(() => series.filter((s) => stacks.some((st) => st[s.key])), [series, stacks]);
  const hourly = data?.stepMs < 86_400_000;
  const { max, step } = niceMax(Math.max(1, ...pts.map((p) => p.total)));
  const innerW = Math.max(0, width - PAD.l - PAD.r);
  const innerH = H - PAD.t - PAD.b;
  const bw = pts.length ? innerW / pts.length : 0;
  const y = (v) => PAD.t + innerH - (v / max) * innerH;
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
  const labelEvery = Math.max(1, Math.ceil(pts.length / Math.max(1, Math.floor(innerW / 64))));
  const label = (t) => (hourly ? `${utcTime(t, false)}` : utcDate(t));
  const h = hover !== null ? pts[hover] : null;
  const hs = hover !== null ? stacks[hover] : null;
  const tipLeft = hover !== null ? PAD.l + (hover + 0.5) * bw : 0;
  const tipFlip = tipLeft > width / 2;

  return (
    <div className="cchart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={H} role="img" aria-label={`Calls per ${hourly ? 'hour' : 'day'}, stacked by outcome`}
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
            const w = Math.max(0.5, bw - gap * 2);
            let base = 0;
            const st = stacks[i];
            return (
              <g key={p.t} onMouseEnter={() => setHover(i)} className={`cchart__col ${hover === i ? 'is-hover' : ''} ${hover !== null && hover !== i ? 'is-dim' : ''}`} style={{ '--i': Math.min(i, 60) }}>
                <rect x={x} y={PAD.t} width={bw} height={innerH} fill="transparent" />
                {series.map((s) => {
                  const n = st[s.key];
                  if (!n) return null;
                  const y0 = y(base); base += n; const y1 = y(base);
                  const hgt = y0 - y1;
                  // 1px surface gap between stacked segments when there is room for it.
                  return <rect key={s.key} x={x + gap} y={y1} width={w} height={hgt > 3 ? hgt - 1 : hgt} className={`cchart__seg ${s.cls}`} />;
                })}
                {i % labelEvery === 0 && <text x={x + bw / 2} y={H - 6} className="cchart__axis" textAnchor="middle">{label(p.t)}</text>}
              </g>
            );
          })}
        </svg>
      )}
      {h && (
        <div className={`cchart__tipbox mono ${tipFlip ? 'is-flip' : ''}`} style={{ left: tipLeft }} role="status">
          <div className="cchart__tiphead">
            {hourly ? `${utcDate(h.t)} ${utcTime(h.t, false)}` : utcDate(h.t)} · <b>{num(h.total)}</b> calls · <b>{num(h.booked)}</b> booked
          </div>
          {series.filter((s) => hs[s.key]).reverse().map((s) => (
            <div key={s.key} className="cchart__tiprow">
              <i className={`cchart__sw ${s.cls}`} />
              <span className="cchart__tiplabel">{s.label}</span>
              <b>{num(hs[s.key])}</b>
              <span className="dim">{pct(h.total ? hs[s.key] / h.total : null, 0)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="cchart__legend mono" aria-label="Outcomes">
        {present.map((s) => {
          const on = active && s.pick === active;
          const content = <><i className={`cchart__sw ${s.cls}`} /> {s.label}</>;
          return onPick && s.pick
            ? <button key={s.key} type="button" className={`cchart__key ${on ? 'is-on' : ''}`} aria-pressed={on}
                title={on ? 'Clear filter' : `Show only "${s.label}"`} onClick={() => onPick(on ? '' : s.pick)}>{content}</button>
            : <span key={s.key} className="cchart__key">{content}</span>;
        })}
      </div>
    </div>
  );
}
