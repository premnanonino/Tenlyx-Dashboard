import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useDebounced } from '../lib/hooks.js';
import { money, moneySmart, num, productColor, productLabel, shortModel, utcDate, utcTime } from '../lib/format.js';
import { SkeletonRows, Tabs } from './ui.jsx';
import { rangeLabel, rangeQuery } from './RangePicker.jsx';

const PAGE_SIZE = 10;

/** Page numbers to show: first, last, and a window around the current page, with gaps as null. */
function pageList(cur, count) {
  const set = new Set([1, count, cur - 1, cur, cur + 1].filter((p) => p >= 1 && p <= count));
  const out = [];
  let prev = 0;
  for (const p of [...set].sort((a, b) => a - b)) {
    if (p - prev > 1) out.push(null);
    out.push(p);
    prev = p;
  }
  return out;
}

const PRODUCTS = [
  { value: '', label: 'All' },
  { value: 'messaging', label: 'SMS' },
  { value: 'voice', label: 'Voice' },
  { value: 'verify', label: 'Verify' },
  { value: 'sip', label: 'SIP' },
  { value: 'ai', label: 'AI' },
  { value: 'numbers', label: 'Numbers' },
];

/**
 * Searchable record ledger. Text search hits the backend trie (prefix
 * match on numbers, countries, products, groups); the response says which
 * query plan the store chose. New rows flash in when the live stream ticks.
 */
export default function Ledger({ tick, currency, range }) {
  const [q, setQ] = useState('');
  const [product, setProduct] = useState('');
  const [result, setResult] = useState(null);
  const [page, setPage] = useState(1);
  // Newest timestamp seen on page 1, +1. Pages 2+ are read below this cursor
  // so new live records don't shift rows between pages while you browse.
  const [anchor, setAnchor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [suggest, setSuggest] = useState([]);
  const [focus, setFocus] = useState(false);
  const [opt, setOpt] = useState(-1);
  const seen = useRef(null);
  const [fresh, setFresh] = useState(new Set());
  const dq = useDebounced(q, 200);

  const rq = rangeQuery(range);
  const filterParams = () => {
    const p = new URLSearchParams(rq);
    if (dq.trim()) p.set('q', dq.trim());
    if (product) p.set('product', product);
    return p;
  };
  const params = () => {
    const p = filterParams();
    p.set('limit', String(PAGE_SIZE));
    if (page > 1) {
      p.set('offset', String((page - 1) * PAGE_SIZE));
      if (anchor) p.set('before', String(anchor));
    }
    return p.toString();
  };

  // Filters changed: back to page 1 and reset the "seen" set (no flash on filter change).
  useEffect(() => { setPage(1); setAnchor(null); seen.current = null; }, [dq, product, rq]);

  useEffect(() => {
    const c = new AbortController();
    setLoading(true);
    api(`/records?${params()}`, { signal: c.signal })
      .then((r) => {
        if (page === 1 && r.rows[0]) setAnchor(r.rows[0].ts + 1);
        if (page === 1 && seen.current) {
          const next = new Set(r.rows.filter((x) => !seen.current.has(x.id)).map((x) => x.id));
          setFresh(next);
        }
        seen.current = new Set(r.rows.map((x) => x.id));
        setResult(r); setError(null);
      })
      .catch((e) => { if (!c.signal.aborted) setError(e); })
      .finally(() => { if (!c.signal.aborted) setLoading(false); });
    return () => c.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq, product, rq, page, page === 1 ? tick : 0]); // live refresh only on page 1

  useEffect(() => {
    setOpt(-1);
    if (!q.trim()) { setSuggest([]); return undefined; }
    const c = new AbortController();
    api(`/search/suggest?q=${encodeURIComponent(q.trim())}&limit=6`, { signal: c.signal })
      .then((r) => setSuggest(r.items)).catch(() => {});
    return () => c.abort();
  }, [q]);

  const rows = result?.rows ?? [];
  const pages = result ? Math.max(1, Math.ceil(result.total / PAGE_SIZE)) : 1;
  const go = (p) => { if (p >= 1 && p <= pages && p !== page) setPage(p); };

  return (
    <div className="ledger">
      <div className="ledger__bar">
        <div className="search">
          <label htmlFor="ledger-q" className="sr-only">Search records</label>
          <span className="search__icon mono" aria-hidden>/</span>
          <input
            id="ledger-q"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            role="combobox"
            aria-expanded={focus && suggest.length > 0}
            aria-controls="ledger-suggest"
            aria-autocomplete="list"
            aria-activedescendant={opt >= 0 ? `ledger-opt-${opt}` : undefined}
            onKeyDown={(e) => {
              if (!suggest.length) return;
              if (e.key === 'ArrowDown') { e.preventDefault(); setFocus(true); setOpt((o) => (o + 1) % suggest.length); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setOpt((o) => (o <= 0 ? suggest.length - 1 : o - 1)); }
              else if (e.key === 'Enter' && opt >= 0) { e.preventDefault(); setQ(suggest[opt].token); setOpt(-1); setFocus(false); }
              else if (e.key === 'Escape') { setFocus(false); setOpt(-1); }
            }}
            onFocus={() => setFocus(true)}
            onBlur={() => setTimeout(() => setFocus(false), 120)}
            aria-describedby="ledger-hint"
            placeholder="Search number, country, group, model…  e.g. 1415  gb  llama"
            autoComplete="off"
            spellCheck="false"
          />
          {loading && <span className="spin-square search__spin" aria-hidden />}
          <span id="ledger-hint" className="sr-only">Prefix search; results update as you type.</span>
          {focus && suggest.length > 0 && (
            <ul className="suggest mono" role="listbox" id="ledger-suggest" aria-label="Suggestions">
              {suggest.map((s, i) => (
                <li key={s.token} id={`ledger-opt-${i}`} role="option" aria-selected={i === opt}
                  className={i === opt ? 'is-on' : ''} onMouseDown={() => { setQ(s.token); setOpt(-1); }}>
                  <span>{s.token}</span><em>{num(s.count)}</em>
                </li>
              ))}
            </ul>
          )}
        </div>
        <Tabs value={product} onChange={setProduct} options={PRODUCTS} label="Product filter" />
        <a className="btn btn--ghost btn--small ledger__export" href={`/api/records/export.csv?${filterParams()}`} download
          title="Download every record matching the current search, product and date range">
          ↓ Export CSV
        </a>
      </div>

      {result && (
        <p className="ledger__meta mono">
          <b>{num(result.total)}</b> records · <b>{money(result.sumCost, currency)}</b> · {rangeLabel(range)}
          <span className="sep" />plan <b className={`plan plan--${result.plan}`}>{result.plan}</b>
          · scanned {num(result.scanned)} · {result.tookMs} ms
          {page > 1 && <span className="paused"> · live updates paused while paging</span>}
        </p>
      )}

      {error && <p className="panel__error mono" role="alert">Couldn't load records. Try again in a moment.</p>}

      {!result ? (
        <SkeletonRows rows={PAGE_SIZE} h={20} />
      ) : rows.length === 0 ? (
        <p className="empty mono">No records match.</p>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl ledger__tbl">
            <thead>
              <tr>
                <th>Time UTC</th><th>Product</th><th>Dir</th><th>Destination</th><th>Ctry</th>
                <th>Billing group</th><th className="r">Units</th><th className="r">Rate</th><th className="r">Cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={`${fresh.has(r.id) ? 'row--new' : ''} ${r.status === 'failed' ? 'row--failed' : ''}`}>
                  <td className="mono nowrap"><span className="dim">{utcDate(r.ts)}</span> {utcTime(r.ts)}</td>
                  <td className="nowrap"><i className="sq" style={{ background: productColor(r.product) }} />{r.ai ? 'AI' : productLabel(r.product)}{r.ai && <span className="mono dim"> · {shortModel(r.ai.model)}</span>}</td>
                  <td className="mono dim">{r.direction === 'inbound' ? 'IN' : r.direction === 'outbound' ? 'OUT' : '—'}</td>
                  <td className="mono">{r.destination}</td>
                  <td className="mono">{r.country}</td>
                  <td>{r.billingGroup}</td>
                  <td className="r mono">{num(r.units, r.unitLabel === 'min' ? 1 : 0)} <span className="dim">{r.unitLabel}</span></td>
                  <td className="r mono dim">{moneySmart(r.rate, r.currency)}</td>
                  <td className="r mono">{r.status === 'failed' ? <span className="tag">failed</span> : moneySmart(r.cost, r.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {result && result.total > PAGE_SIZE && (
        <nav className="pager mono" aria-label="Ledger pages">
          <span className="pager__info">
            {num((page - 1) * PAGE_SIZE + 1)}–{num(Math.min(page * PAGE_SIZE, result.total))} of {num(result.total)}
          </span>
          <div className="pager__btns">
            <button type="button" onClick={() => go(page - 1)} disabled={page === 1 || loading} aria-label="Previous page">‹ Prev</button>
            {pageList(page, pages).map((p, i) => (p === null
              ? <span key={`gap-${i}`} className="pager__gap" aria-hidden>…</span>
              : (
                <button key={p} type="button" className={p === page ? 'is-on' : ''} aria-current={p === page ? 'page' : undefined}
                  onClick={() => go(p)} disabled={loading && p !== page}>
                  {num(p)}
                </button>
              )))}
            <button type="button" onClick={() => go(page + 1)} disabled={page === pages || loading} aria-label="Next page">Next ›</button>
          </div>
        </nav>
      )}
    </div>
  );
}
