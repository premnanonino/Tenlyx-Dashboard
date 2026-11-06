import { moneySmart, productLabel, utcTime } from '../lib/format.js';

/** Scrolling tape of the most recent billed events, like an exchange ticker. */
export default function Ticker({ items }) {
  if (!items.length) {
    return (
      <div className="ticker ticker--idle mono" aria-live="polite">
        <span className="spin-square" /> waiting for billed events on the stream…
      </div>
    );
  }
  const row = items.map((r) => (
    <span className="ticker__item" key={r.id}>
      <span className="dim">{utcTime(r.ts)}</span>
      <b>{productLabel(r.product)}</b>
      <span>{r.direction === 'inbound' ? '←' : '→'} {r.destination}</span>
      <span className="dim">{r.country}</span>
      <span className={r.cost > 0.05 ? 'hot' : ''}>{moneySmart(r.cost, r.currency)}</span>
    </span>
  ));
  return (
    <div className="ticker mono" aria-label="Latest billed events">
      <div className="ticker__track" style={{ animationDuration: `${Math.max(30, items.length * 4)}s` }}>
        <div className="ticker__run">{row}</div>
        <div className="ticker__run" aria-hidden>{row}</div>
      </div>
    </div>
  );
}
