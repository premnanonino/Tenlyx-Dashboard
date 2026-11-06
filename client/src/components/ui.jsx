import { useInflight } from '../lib/api.js';
import { useFlash, useTween } from '../lib/hooks.js';

/** 2px bar under the header; animates while any request is in flight. */
export function TopProgress() {
  const n = useInflight();
  return <div className={`top-progress ${n > 0 ? 'is-active' : ''}`} aria-hidden />;
}

export function Panel({ n, title, aside, children, className = '', busy, error, i = 0 }) {
  return (
    <section className={`panel reveal ${className}`} style={{ '--i': i }} aria-busy={busy || undefined}>
      <header className="panel__head">
        <span className="panel__n">{String(n).padStart(2, '0')}</span>
        <h2>{title}</h2>
        {busy && <span className="panel__spin" role="status"><span className="spin-square" /><span className="sr-only">Refreshing</span></span>}
        {aside && <div className="panel__aside">{aside}</div>}
      </header>
      <div className={`panel__body ${busy ? 'is-busy' : ''}`}>{children}</div>
      {error && <p className="panel__error mono">Request failed: {error.message}</p>}
    </section>
  );
}

/** Skeleton block — blinks in hard steps rather than shimmering. */
export function Skeleton({ h = 14, w = '100%', className = '' }) {
  return <span className={`sk ${className}`} style={{ height: h, width: w }} aria-hidden />;
}

export function SkeletonRows({ rows = 6, h = 14 }) {
  return (
    <div className="sk-rows" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} h={h} w={`${92 - ((i * 37) % 40)}%`} />
      ))}
    </div>
  );
}

export function LoadingCaption({ path }) {
  return <p className="loading-caption mono"><span className="spin-square" /> GET {path}</p>;
}

export const RANGES = [
  { value: '24h', label: '24H' },
  { value: '7d', label: '7D' },
  { value: '30d', label: '30D' },
];

/**
 * Segmented control with roving tabindex: one Tab stop for the group,
 * ←/→ (Home/End) move the selection, as in the WAI-ARIA tabs pattern.
 */
export function Tabs({ value, onChange, options, label }) {
  const onKeyDown = (e) => {
    const i = options.findIndex((o) => o.value === value);
    const map = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: options.length - 1 };
    if (!(e.key in map)) return;
    e.preventDefault();
    const next = options[(map[e.key] + options.length) % options.length];
    onChange(next.value);
    const btns = e.currentTarget.querySelectorAll('button');
    btns[options.indexOf(next)]?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          tabIndex={value === o.value ? 0 : -1}
          className={value === o.value ? 'is-on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Ledger figure: count-up number, flash on change, sub-line below. */
export function Figure({ label, value, format, sub, tone, loading, n }) {
  const v = useTween(value ?? null);
  const flash = useFlash(value);
  return (
    <div className={`figure ${flash ? 'is-flash' : ''}`}>
      <p className="figure__label"><span>{n}</span>{label}</p>
      {loading ? (
        <><Skeleton h={34} w="70%" /><Skeleton h={12} w="50%" className="mt8" /></>
      ) : (
        <>
          <p className="figure__value mono">{value === null || value === undefined ? '—' : format(v)}</p>
          <p className={`figure__sub mono ${tone ? `tone-${tone}` : ''}`}>{sub}</p>
        </>
      )}
    </div>
  );
}
