import { useEffect, useState } from 'react';
import { pct } from '../../lib/format.js';
import { DataTable, LiveRegion, useChartKeys, KEY_HINT } from './a11y.jsx';

/**
 * Donut or pie (variant="pie"). Each segment is a circle stroke with its own
 * dash window, so segments sweep in from 0 on mount without path maths.
 * Hover, focus+arrows or the legend highlight a segment and fill the centre.
 */
export default function Donut({
  items, colorFor, labelFor = (k) => k, format, caption, centerLabel = 'Total', variant = 'donut', size = 188,
}) {
  const [mounted, setMounted] = useState(false);
  const [hover, setHover] = useState(null);
  const { active: kActive, focusProps } = useChartKeys(items.length);
  useEffect(() => { const id = requestAnimationFrame(() => setMounted(true)); return () => cancelAnimationFrame(id); }, []);

  const total = items.reduce((s, x) => s + x.value, 0);
  const pie = variant === 'pie';
  const R = size / 2;
  const thick = pie ? R / 2 : 26;
  const r = pie ? R / 2 : R - thick / 2 - 4;
  const C = 2 * Math.PI * r;
  const gap = items.length > 1 ? (pie ? 0 : 2) : 0;
  const active = kActive ?? hover;
  const a = active !== null ? items[active] : null;

  let acc = 0;
  const segs = items.map((it, i) => {
    const len = total ? (it.value / total) * C : 0;
    const seg = { ...it, i, len: Math.max(0, len - gap), offset: -acc };
    acc += len;
    return seg;
  });

  const describe = (it) => `${labelFor(it.key)}: ${format(it.value)}, ${pct(total ? it.value / total : 0)}`;

  return (
    <div className={`donut donut--${variant}`}>
      <div className="donut__fig">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img"
          aria-label={`${caption}. ${items.map(describe).join('; ')}. ${KEY_HINT}`} {...focusProps}>
          {!pie && <circle cx={R} cy={R} r={r} fill="none" stroke="var(--paper-3)" strokeWidth={thick} />}
          <g transform={`rotate(-90 ${R} ${R})`}>
            {segs.map((s) => (
              <circle key={s.key} cx={R} cy={R} r={r} fill="none"
                style={{ stroke: colorFor(s.key), transitionDelay: `${s.i * 70}ms` }}
                strokeWidth={active === s.i ? thick + (pie ? 0 : 8) : thick}
                strokeDasharray={`${mounted ? s.len : 0} ${C}`}
                strokeDashoffset={s.offset}
                className={`donut__seg ${active !== null && active !== s.i ? 'is-dim' : ''}`}
                onMouseEnter={() => setHover(s.i)} onMouseLeave={() => setHover(null)} />
            ))}
          </g>
          {pie && <circle cx={R} cy={R} r={R - 1} fill="none" stroke="var(--paper)" strokeWidth="2" />}
        </svg>
        {!pie && (
          <div className="donut__center" aria-hidden>
            <span className="donut__cv mono">{a ? pct(total ? a.value / total : 0) : format(total)}</span>
            <span className="donut__cl">{a ? labelFor(a.key) : centerLabel}</span>
          </div>
        )}
      </div>
      <ul className="donut__legend">
        {items.map((it, i) => (
          <li key={it.key} className={active === i ? 'is-on' : ''} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <i style={{ background: colorFor(it.key) }} />
            <span className="donut__lk">{labelFor(it.key)}</span>
            <span className="mono donut__lv">{format(it.value)}</span>
            <span className="mono">{pct(total ? it.value / total : 0)}</span>
          </li>
        ))}
      </ul>
      <LiveRegion text={a ? describe(a) : ''} />
      <DataTable caption={caption} columns={['Item', 'Value', 'Share']}
        rows={items.map((it) => [labelFor(it.key), format(it.value), pct(total ? it.value / total : 0)])} />
    </div>
  );
}
