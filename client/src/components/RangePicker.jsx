import { useEffect, useId, useRef, useState } from 'react';
import { RANGES } from './ui.jsx';
import { utcDate } from '../lib/format.js';

const DAY = 86_400_000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);

/** Range value -> query string. {range:'7d'} or {from:'YYYY-MM-DD', to:'YYYY-MM-DD'}. */
export const rangeQuery = (v) => (v.range ? `range=${v.range}` : `from=${v.from}&to=${v.to}`);
export const rangeLabel = (v) => (v.range ? v.range.toUpperCase() : `${utcDate(Date.parse(v.from))} – ${utcDate(Date.parse(v.to))}`);

/**
 * Preset ranges plus a "Custom" popover with two date fields.
 * Limited to the 35 days of raw data the backend keeps (older months
 * live on the Reports page). Esc or an outside click closes it and
 * returns focus to the trigger.
 */
export default function RangePicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const today = iso(Date.now());
  const min = iso(Date.now() - 34 * DAY);
  const [from, setFrom] = useState(value.from || iso(Date.now() - 6 * DAY));
  const [to, setTo] = useState(value.to || today);
  const [err, setErr] = useState(null);
  const wrap = useRef(null);
  const trigger = useRef(null);
  const firstField = useRef(null);
  const id = useId();

  useEffect(() => {
    if (!open) return undefined;
    firstField.current?.focus();
    const onDoc = (e) => { if (!wrap.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const close = () => { setOpen(false); trigger.current?.focus(); };

  const apply = (e) => {
    e.preventDefault();
    if (!from || !to) return setErr('Pick both dates.');
    if (from > to) return setErr('Start must be on or before end.');
    if (from < min) return setErr(`Raw data starts ${utcDate(Date.parse(min))}. Use Reports for older months.`);
    setErr(null);
    onChange({ from, to });
    close();
  };

  const custom = !value.range;
  const presetKeys = (e) => {
    const keys = [...RANGES.map((r) => r.value), 'custom'];
    const cur = custom ? 'custom' : value.range;
    const i = keys.indexOf(cur);
    const map = { ArrowRight: i + 1, ArrowLeft: i - 1 };
    if (!(e.key in map)) return;
    e.preventDefault();
    const next = keys[(map[e.key] + keys.length) % keys.length];
    const btns = wrap.current.querySelectorAll('[role="tab"]');
    btns[keys.indexOf(next)]?.focus();
    if (next !== 'custom') onChange({ range: next });
  };

  return (
    <div className="range" ref={wrap}>
      <div className="tabs" role="tablist" aria-label="Date range" onKeyDown={presetKeys}>
        {RANGES.map((r) => (
          <button key={r.value} type="button" role="tab" aria-selected={value.range === r.value}
            tabIndex={value.range === r.value ? 0 : -1}
            className={value.range === r.value ? 'is-on' : ''} onClick={() => onChange({ range: r.value })}>
            {r.label}
          </button>
        ))}
        <button ref={trigger} type="button" role="tab" aria-selected={custom} tabIndex={custom ? 0 : -1}
          aria-haspopup="dialog" aria-expanded={open} aria-controls={`${id}-pop`}
          className={custom ? 'is-on' : ''} onClick={() => setOpen((o) => !o)}>
          {custom ? rangeLabel(value) : 'Custom'} ▾
        </button>
      </div>

      {open && (
        <form id={`${id}-pop`} className="range__pop" role="dialog" aria-label="Custom date range" onSubmit={apply}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
          <p className="range__h mono">Custom range · UTC</p>
          <label>
            <span>From</span>
            <input ref={firstField} type="date" value={from} min={min} max={today} onChange={(e) => setFrom(e.target.value)} required />
          </label>
          <label>
            <span>To</span>
            <input type="date" value={to} min={min} max={today} onChange={(e) => setTo(e.target.value)} required />
          </label>
          <div className="range__quick mono">
            {[['Today', 0], ['Last 3 days', 2], ['Last 14 days', 13], ['This month', null]].map(([l, d]) => (
              <button key={l} type="button" onClick={() => {
                if (d === null) { const n = new Date(); setFrom(iso(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1))); }
                else setFrom(iso(Date.now() - d * DAY));
                setTo(today);
              }}>{l}</button>
            ))}
          </div>
          {err && <p className="range__err mono" role="alert">{err}</p>}
          <div className="range__foot">
            <button type="button" className="btn btn--ghost btn--small" onClick={close}>Cancel</button>
            <button type="submit" className="btn btn--small">Apply</button>
          </div>
        </form>
      )}
    </div>
  );
}
