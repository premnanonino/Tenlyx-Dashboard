import { useMemo, useState } from 'react';
import { useWidth } from '../../lib/hooks.js';
import { moneySmart, ms, num, pct, shortModel } from '../../lib/format.js';
import { DataTable, LiveRegion, useChartKeys, KEY_HINT } from '../charts/a11y.jsx';

const H = 260;
const M = { l: 46, r: 16, t: 16, b: 34 };

/**
 * Cost per conversation (x) against resolution rate (y). Square area is
 * proportional to volume. Up-and-left is better: resolves more for less.
 */
export default function ModelScatter({ models, colorFor, currency }) {
  const [ref, width] = useWidth();
  const [mouse, setHover] = useState(null);
  const pts = models.filter((m) => m.costPerConversation !== null && m.resolutionRate !== null);
  const { active: kActive, focusProps } = useChartKeys(pts.length);
  const hover = kActive !== null ? pts[kActive]?.model : mouse;

  const s = useMemo(() => {
    if (!width || !pts.length) return null;
    const xs = pts.map((m) => m.costPerConversation);
    const ys = pts.map((m) => m.resolutionRate);
    const xMax = Math.max(...xs) * 1.15;
    const yMin = Math.max(0, Math.min(...ys) - 0.06);
    const yMax = Math.min(1, Math.max(...ys) + 0.04);
    const x = (v) => M.l + (v / xMax) * (width - M.l - M.r);
    const y = (v) => M.t + (1 - (v - yMin) / (yMax - yMin)) * (H - M.t - M.b);
    const maxN = Math.max(...pts.map((m) => m.conversations));
    const size = (n) => 8 + Math.sqrt(n / maxN) * 18;
    const medX = [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const avgY = ys.reduce((a, b) => a + b, 0) / ys.length;
    const yTicks = [];
    for (let v = Math.ceil(yMin * 20) / 20; v <= yMax + 1e-9; v += 0.05) yTicks.push(v);
    // Greedy label placement: flip labels left near the right edge, then
    // walk labels top-to-bottom nudging any that collide with one above.
    const boxes = pts.map((m) => {
      const cx = x(m.costPerConversation); const cy = y(m.resolutionRate); const sz = size(m.conversations);
      return { model: m.model, x0: cx - sz / 2, x1: cx + sz / 2, y0: cy - sz / 2, y1: cy + sz / 2 };
    });
    const hitsMarker = (model, x0, x1, cy) => boxes.some((b) => b.model !== model && x0 < b.x1 && b.x0 < x1 && cy - 6 < b.y1 && b.y0 < cy + 6);
    const labels = pts.map((m, i) => {
      const b = boxes[i]; const cy = (b.y0 + b.y1) / 2;
      const w = shortModel(m.model).length * 6.8;
      const right = { lx: b.x1 + 6, anchor: 'start', x0: b.x1 + 6 };
      const left = { lx: b.x0 - 6, anchor: 'end', x0: b.x0 - 6 - w };
      const fitsRight = right.x0 + w <= width - M.r && !hitsMarker(m.model, right.x0, right.x0 + w, cy);
      const fitsLeft = left.x0 >= M.l && !hitsMarker(m.model, left.x0, left.x0 + w, cy);
      const side = fitsRight ? right : fitsLeft ? left : (right.x0 + w <= width - M.r ? right : left);
      return { model: m.model, ly: cy, w, ...side };
    }).sort((a, b) => a.ly - b.ly);
    for (let i = 0; i < labels.length; i++) {
      for (let j = 0; j < i; j++) {
        const a = labels[j]; const b = labels[i];
        const overlapX = a.x0 < b.x0 + b.w && b.x0 < a.x0 + a.w;
        if (overlapX && Math.abs(b.ly - a.ly) < 13) b.ly = a.ly + 13;
      }
    }
    const labelPos = new Map(labels.map((l) => [l.model, l]));
    return { x, y, size, medX, avgY, yTicks, xMax, labelPos };
  }, [width, pts]);

  const hm = hover ? pts.find((m) => m.model === hover) : null;

  return (
    <div ref={ref} className="chart scatter">
      {s && (
        <svg width={width} height={H} role="img" {...focusProps} aria-label={`Cost per conversation versus resolution rate by model. ${KEY_HINT}`}>
          {s.yTicks.map((v) => (
            <g key={v}>
              <line x1={M.l} x2={width - M.r} y1={s.y(v)} y2={s.y(v)} className="grid" />
              <text x={M.l - 8} y={s.y(v)} className="tick" textAnchor="end" dominantBaseline="middle">{pct(v, 0)}</text>
            </g>
          ))}
          <line x1={s.x(s.medX)} x2={s.x(s.medX)} y1={M.t} y2={H - M.b} className="guide" />
          <line x1={M.l} x2={width - M.r} y1={s.y(s.avgY)} y2={s.y(s.avgY)} className="guide" />
          <text x={M.l + 6} y={M.t + 10} className="tick quad">↖ better: resolves more, costs less</text>
          <line x1={M.l} x2={width - M.r} y1={H - M.b} y2={H - M.b} className="axis-base" />
          <text x={M.l} y={H - 8} className="tick">$0</text>
          <text x={width - M.r} y={H - 8} className="tick" textAnchor="end">{moneySmart(s.xMax, currency)} / conversation →</text>

          {pts.map((m, i) => {
            const sz = s.size(m.conversations);
            const cx = s.x(m.costPerConversation);
            const cy = s.y(m.resolutionRate);
            return (
              <g key={m.model} className="pt" style={{ '--d': `${i * 80}ms` }}
                onMouseEnter={() => setHover(m.model)} onMouseLeave={() => setHover(null)}>
                <rect x={cx - sz / 2} y={cy - sz / 2} width={sz} height={sz} style={{ fill: colorFor(m.model) }}
                  className={hover && hover !== m.model ? 'pt--dim' : ''} />
                <text x={s.labelPos.get(m.model).lx} y={s.labelPos.get(m.model).ly} textAnchor={s.labelPos.get(m.model).anchor}
                  dominantBaseline="middle" className="pt__label">{shortModel(m.model)}</text>
              </g>
            );
          })}
        </svg>
      )}
      {hm && (
        <div className="tooltip mono" style={{ left: Math.min(s.x(hm.costPerConversation) + 18, width - 214), width: 204, top: Math.max(0, s.y(hm.resolutionRate) - 60) }}>
          <p className="tooltip__head">{hm.model}</p>
          <p className="tooltip__row"><span>Conversations</span><b>{num(hm.conversations)}</b></p>
          <p className="tooltip__row"><span>Resolution</span><b>{pct(hm.resolutionRate)}</b></p>
          <p className="tooltip__row"><span>$ / conversation</span><b>{moneySmart(hm.costPerConversation, currency)}</b></p>
          <p className="tooltip__row"><span>$ / resolved</span><b>{moneySmart(hm.costPerResolved, currency)}</b></p>
          <p className="tooltip__row"><span>p50 latency</span><b>{ms(hm.p50LatencyMs ?? hm.avgLatencyMs)}</b></p>
        </div>
      )}
      <LiveRegion text={hm ? `${hm.model}: ${pct(hm.resolutionRate)} resolved, ${moneySmart(hm.costPerConversation, currency)} per conversation, ${num(hm.conversations)} conversations` : ''} />
      <DataTable caption="Cost and resolution by model" columns={['Model', 'Conversations', 'Cost per conversation', 'Resolution rate']}
        rows={pts.map((m) => [m.model, num(m.conversations), moneySmart(m.costPerConversation, currency), pct(m.resolutionRate)])} />
    </div>
  );
}
