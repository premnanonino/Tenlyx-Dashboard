import { useState } from 'react';
import { moneySmart } from '../../lib/format.js';
import { LiveRegion } from './a11y.jsx';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const STEPS = 5;

/**
 * Weekday x hour heatmap rendered as a real <table>, so screen readers get
 * row and column headers for free. Colour is quantised into 6 flat steps
 * (no gradients). The grid is one Tab stop; arrow keys move the active cell.
 */
export default function Heatmap({ data, currency }) {
  const [cell, setCell] = useState(null); // [day, hour]
  const max = data.max || 1;
  const level = (v) => (v <= 0 ? 0 : Math.min(STEPS, Math.ceil((v / max) * STEPS)));

  const onKeyDown = (e) => {
    const [d, h] = cell ?? [0, 0];
    const mv = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] }[e.key];
    if (mv) {
      e.preventDefault();
      setCell(cell ? [Math.min(6, Math.max(0, d + mv[0])), Math.min(23, Math.max(0, h + mv[1]))] : [0, 0]);
    } else if (e.key === 'Home') { e.preventDefault(); setCell([d, 0]); }
    else if (e.key === 'End') { e.preventDefault(); setCell([d, 23]); }
    else if (e.key === 'Escape') setCell(null);
  };

  const describe = (d, h) => `${DAYS[d]} ${String(h).padStart(2, '0')}:00 UTC: ${moneySmart(data.avg[d][h], currency)} average, ${data.count[d][h]} records`;
  // Busiest slot, for the summary line.
  let peak = [0, 0];
  data.avg.forEach((row, d) => row.forEach((v, h) => { if (v > data.avg[peak[0]][peak[1]]) peak = [d, h]; }));

  return (
    <div className="heat">
      <div className="heat__wrap" tabIndex={0} onKeyDown={onKeyDown} onBlur={() => setCell(null)}
        aria-label="Spend heatmap by weekday and hour. Use arrow keys to move between cells." role="group">
        <table className="heat__grid">
          <caption className="sr-only">Average spend per weekday and UTC hour</caption>
          <thead>
            <tr>
              <td />
              {Array.from({ length: 24 }, (_, h) => <th key={h} scope="col" className="mono">{h % 3 === 0 ? String(h).padStart(2, '0') : <span className="sr-only">{h}</span>}</th>)}
            </tr>
          </thead>
          <tbody>
            {data.avg.map((row, d) => (
              <tr key={DAYS[d]}>
                <th scope="row" className="mono">{DAYS[d]}</th>
                {row.map((v, h) => {
                  const on = cell && cell[0] === d && cell[1] === h;
                  return (
                    <td key={h} className={`heat__c ${on ? 'is-on' : ''}`}
                      style={{ background: `var(--heat-${level(v)})`, animationDelay: `${h * 12 + d * 20}ms` }}
                      onMouseEnter={() => setCell([d, h])} onMouseLeave={() => setCell(null)}>
                      <span className="sr-only">{moneySmart(v, currency)}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="heat__foot mono">
        <span className="heat__read">{cell ? describe(cell[0], cell[1]) : `Busiest: ${describe(peak[0], peak[1])}`}</span>
        <span className="heat__scale" aria-hidden>
          less {Array.from({ length: STEPS + 1 }, (_, i) => <i key={i} style={{ background: `var(--heat-${i})` }} />)} more
        </span>
      </div>
      <LiveRegion text={cell ? describe(cell[0], cell[1]) : ''} />
    </div>
  );
}
