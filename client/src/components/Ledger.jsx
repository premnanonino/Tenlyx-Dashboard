import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useDebounced } from '../lib/hooks.js';
import { money, moneySmart, num, productColor, productLabel, shortModel, utcDate, utcTime } from '../lib/format.js';
import { SkeletonRows, Tabs } from './ui.jsx';
import { rangeLabel, rangeQuery } from './RangePicker.jsx';

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
  const [extra, setExtra] = useState([]);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
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
  const params = (before) => {
    const p = new URLSearchParams(`${rq}&limit=40`);
    if (dq.trim()) p.set('q', dq.trim());
    if (product) p.set('product', product);
    if (before) p.set('before', String(before));
    return p.toString();
  };

  // Filters changed: reset paging and the "seen" set (no flash on filter change).
  useEffect(() => { setExtra([]); seen.current = null; }, [dq, product, rq]);

  useEffect(() => {
    if (extra.length) return undefined; // user is paging through history: hold still
    const c = new AbortController();
    setLoading(true);
    api(`/records?${params()}`, { signal: c.signal })
      .then((r) => {
        if (seen.current) {
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
  }, [dq, product, rq, tick, extra.length]);

  useEffect(() => {
    setOpt(-1);
    if (!q.trim()) { setSuggest([]); return undefined; }
    const c = new AbortController();
    api(`/search/suggest?q=${encodeURIComponent(q.trim())}&limit=6`, { signal: c.signal })
      .then((r) => setSuggest(r.items)).catch(() => {});
    return () => c.abort();
  }, [q]);

  const loadMore = async () => {
    const last = extra.length ? extra[extra.length - 1] : result;
    if (!last?.nextBefore) return;
    setMore(true);
    try {
      const r = await api(`/records?${params(last.nextBefore)}`);
      setExtra((x) => [...x, r]);
    } finally { setMore(false); }
  };

  const rows = result ? [...result.rows, ...extra.flatMap((x) => x.rows)] : [];
  const tail = extra.length ? extra[extra.length - 1] : result;

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
          {extra.length > 0 && <span className="paused"> · live updates paused while paging</span>}
        </p>
      )}

      {error && <p className="panel__error mono">Request failed: {error.message}</p>}

      {!result ? (
        <SkeletonRows rows={10} h={20} />
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

      {tail?.nextBefore && (
        <button type="button" className="btn btn--ghost ledger__more" onClick={loadMore} disabled={more}>
          {more ? <><span className="spin-square" /> Loading older records</> : `Load older · ${num(result.total - rows.length)} more`}
        </button>
      )}
    </div>
  );
}
