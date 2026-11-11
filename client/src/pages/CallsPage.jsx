import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, useResource } from '../lib/api.js';
import { useDebounced, useNow } from '../lib/hooks.js';
import { ago, duration, moneySmart, num, pct, utcDate, utcTime } from '../lib/format.js';
import { Figure, Panel, SkeletonRows, Tabs } from '../components/ui.jsx';
import CallsChart from '../components/charts/CallsChart.jsx';
import { HeroContent } from '../layout/AppLayout.jsx';
import '../styles/calls.css';

const PAGE_SIZE = 25;
const RANGES = [
  { value: '24h', label: '24H' },
  { value: '7d', label: '7D' },
  { value: '30d', label: '30D' },
  { value: '90d', label: '90D' },
];
const LEVELS = { golf_course: 'Golf course', organization: 'Organization' };
const shortId = (id = '') => (id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);
const when = (ts) => (ts ? `${utcDate(ts)} ${utcTime(ts, false)}` : '—');

/** Outcome → visual tone: booked (good), problem (warn), handed to staff (accent), info (neutral). */
function tone(outcome) {
  const o = (outcome || '').toLowerCase();
  if (!o) return 'none';
  if (o === 'booking created') return 'ok';
  if (o.includes('fail') || o.includes('unavailable') || o.includes('cancel')) return 'warn';
  if (o.includes('pro-shop') || o.includes('transfer')) return 'staff';
  return 'info';
}

function pageList(cur, count) {
  const set = new Set([1, count, cur - 1, cur, cur + 1].filter((p) => p >= 1 && p <= count));
  const out = [];
  let prev = 0;
  for (const p of [...set].sort((a, b) => a - b)) { if (p - prev > 1) out.push(null); out.push(p); prev = p; }
  return out;
}

function Select({ label, value, onChange, options, all = 'All' }) {
  return (
    <label className="cf">
      <span className="cf__l mono">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{all}</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.label}{o.count !== undefined ? ` (${num(o.count)})` : ''}</option>)}
      </select>
    </label>
  );
}

function OutcomeTag({ c }) {
  if (c.outcome) return <span className={`oc oc--${tone(c.outcome)}`}>{c.outcome}</span>;
  return <span className="dim mono oc-end">{c.endReason ? c.endReason.replace(/-/g, ' ') : '—'}</span>;
}

/** Clickable outcome bars: click to filter the table, click again to clear. */
function OutcomeBars({ items, active, onPick, total }) {
  if (!items) return <SkeletonRows rows={6} h={18} />;
  if (!items.length) return <p className="empty mono">No calls in this view.</p>;
  const top = items.slice(0, 8);
  const max = top[0].count || 1;
  return (
    <ul className="ob">
      {top.map((o, i) => (
        <li key={o.id} style={{ '--i': i }}>
          <button type="button" className={`ob__row ${active === o.id ? 'is-on' : ''}`} onClick={() => onPick(active === o.id ? '' : o.id)}
            aria-pressed={active === o.id} title={active === o.id ? 'Clear filter' : `Show only "${o.label}"`}>
            <span className="ob__label">{o.label}</span>
            <span className="ob__bar"><i className={`ob__fill ob__fill--${o.id === 'none' ? 'none' : tone(o.id)}`} style={{ width: `${(o.count / max) * 100}%` }} /></span>
            <span className="ob__n mono">{num(o.count)}</span>
            <span className="ob__p mono dim">{pct(total ? o.count / total : null, 0)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** "AI: …" / "User: …" lines → chat bubbles; unlabelled lines continue the previous turn. */
function Transcript({ text }) {
  const turns = useMemo(() => {
    const out = [];
    for (const raw of String(text || '').split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(/^(AI|User|Assistant|Bot|Customer)\s*:\s*(.*)$/i);
      if (m) out.push({ who: /^(ai|assistant|bot)$/i.test(m[1]) ? 'ai' : 'user', text: m[2] });
      else if (out.length) out[out.length - 1].text += `\n${line}`;
      else out.push({ who: 'note', text: line });
    }
    return out;
  }, [text]);
  if (!turns.length) return <p className="dim">No transcript.</p>;
  return (
    <ol className="chat">
      {turns.map((t, i) => (
        <li key={i} className={`chat__msg chat__msg--${t.who}`} style={{ '--i': Math.min(i, 20) }}>
          <span className="chat__who mono">{t.who === 'ai' ? 'AI agent' : t.who === 'user' ? 'Caller' : ''}</span>
          <p>{t.text}</p>
        </li>
      ))}
    </ol>
  );
}

function Copy({ value, label }) {
  const [done, setDone] = useState(false);
  if (!value) return null;
  const copy = () => navigator.clipboard?.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); }).catch(() => {});
  return <button type="button" className="copy mono" onClick={copy} aria-label={`Copy ${label}`}>{done ? 'copied' : 'copy'}</button>;
}

/** Side drawer: one call. Heavy fields are fetched on open; ←/→ step through the current page. */
function CallDrawer({ callId, onClose, onPrev, onNext, position }) {
  const res = useResource(`/calls/${encodeURIComponent(callId)}`);
  const [tab, setTab] = useState('overview');
  const [translated, setTranslated] = useState(false);
  const closeRef = useRef(null);
  useEffect(() => { setTab('overview'); setTranslated(false); }, [callId]);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && onPrev && !e.target.closest('audio')) onPrev();
      else if (e.key === 'ArrowRight' && onNext && !e.target.closest('audio')) onNext();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onPrev, onNext]);
  const c = res.data?.call;
  const d = res.data?.detail;

  // Rendered into <body>: the page area has its own stacking context, which
  // would otherwise keep the drawer under the header.
  return createPortal(
    <div className="cd" role="dialog" aria-modal="true" aria-label={`Call ${callId}`}>
      <button type="button" className="cd__scrim" aria-label="Close" onClick={onClose} tabIndex={-1} />
      <aside className="cd__panel">
        <header className="cd__head">
          <div className="cd__title">
            <h2>{c ? (c.name || 'Unknown caller') : 'Loading…'}</h2>
            <p className="mono dim cd__id" title={callId}>{shortId(callId)} <Copy value={callId} label="call id" /></p>
          </div>
          <div className="cd__nav">
            {position && (
              <>
                <button type="button" className="btn btn--ghost btn--small" onClick={onPrev ?? undefined} disabled={!onPrev} aria-label="Previous call">‹</button>
                <span className="mono dim">{position}</span>
                <button type="button" className="btn btn--ghost btn--small" onClick={onNext ?? undefined} disabled={!onNext} aria-label="Next call">›</button>
              </>
            )}
            <button ref={closeRef} type="button" className="btn btn--ghost btn--small" onClick={onClose}>Close ✕</button>
          </div>
        </header>

        {c && (
          <div className="cd__chips">
            <OutcomeTag c={c} />
            {c.booked && <span className="oc oc--ok">✓ Booked{c.bookingNumber ? ` #${c.bookingNumber}` : ''}</span>}
            {c.endReason === 'assistant-forwarded-call' && <span className="oc oc--staff">Transferred to staff</span>}
            <span className="oc oc--info">{duration(c.durationSec)}</span>
            <span className="oc oc--info mono">{when(c.ts)} UTC</span>
          </div>
        )}

        <div className="cd__tabs">
          <Tabs value={tab} onChange={setTab} label="Call detail" options={[{ value: 'overview', label: 'Overview' }, { value: 'transcript', label: 'Transcript' }]} />
        </div>

        {res.error && <p className="panel__error mono" role="alert">{res.error.status === 404 ? 'This call is no longer in the 90-day history.' : 'Couldn\'t load this call. Try again in a moment.'}</p>}

        {!c ? <SkeletonRows rows={10} h={16} /> : tab === 'overview' ? (
          <div className="cd__body cd__fade" key={`o-${callId}`}>
            {d?.recordingUrl && (
              <section className="cd__card">
                <h3>Recording</h3>
                <audio controls preload="none" src={d.recordingUrl} className="cd__audio">
                  <a href={d.recordingUrl} target="_blank" rel="noopener noreferrer">Open recording</a>
                </audio>
              </section>
            )}
            <section className="cd__card">
              <h3>Summary</h3>
              {!d ? <SkeletonRows rows={3} h={12} /> : <p className="cd__text">{d.summary || <span className="dim">No summary.</span>}</p>}
            </section>
            <dl className="cd__grid">
              <div><dt>Customer</dt><dd>{c.name || '—'}</dd></div>
              <div><dt>Phone</dt><dd className="mono">{c.phone || '—'} <Copy value={c.phone} label="phone" /></dd></div>
              <div className="cd__wide"><dt>Email</dt><dd className="mono">{c.email || '—'} <Copy value={c.email} label="email" /></dd></div>
              <div><dt>Golf course</dt><dd>{c.course || '—'}</dd></div>
              <div><dt>Organization</dt><dd>{c.org || '—'}{c.orgType ? <span className="dim"> · {c.orgType.toUpperCase()}</span> : ''}</dd></div>
              <div><dt>Type</dt><dd>{LEVELS[c.level] || c.level || '—'}</dd></div>
              <div><dt>Course line</dt><dd className="mono">{c.coursePhone || '—'}</dd></div>
              <div><dt>Booking</dt><dd>{c.booked
                ? <>{c.bookingNumber ? <span className="mono">#{c.bookingNumber}</span> : 'Booked'}{c.bookingStatus ? <span className="dim"> · {c.bookingStatus}</span> : ''}</>
                : <span className="dim">No booking</span>}</dd></div>
              <div><dt>Booked on</dt><dd className="mono">{c.bookedAt ? when(c.bookedAt) : '—'}{c.teeDate ? <span className="dim"> · tee {c.teeDate}</span> : ''}</dd></div>
              <div><dt>End reason</dt><dd className="mono dim">{c.endReason || '—'}</dd></div>
              <div><dt>Call cost</dt><dd className="mono">{moneySmart(c.cost)}</dd></div>
            </dl>
          </div>
        ) : (
          <div className="cd__body cd__fade" key={`t-${callId}`}>
            {!d ? <SkeletonRows rows={8} h={14} /> : (
              <>
                {d.translatedTranscript && (
                  <div className="cd__tr-tools">
                    <button type="button" className="btn btn--ghost btn--small" onClick={() => setTranslated((v) => !v)}>
                      {translated ? 'Show original' : 'Show translation'}
                    </button>
                  </div>
                )}
                <Transcript text={translated ? d.translatedTranscript : d.transcript} />
              </>
            )}
          </div>
        )}
      </aside>
    </div>,
    document.body,
  );
}

export default function CallsPage() {
  const now = useNow(30_000);
  const [range, setRange] = useState('7d');
  const [q, setQ] = useState('');
  const [courseId, setCourseId] = useState('');
  const [orgId, setOrgId] = useState('');
  const [outcome, setOutcome] = useState('');
  const [booked, setBooked] = useState('');
  const [level, setLevel] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const dq = useDebounced(q.trim(), 250);

  const filters = useMemo(() => {
    const p = new URLSearchParams({ range, limit: String(PAGE_SIZE) });
    if (dq) p.set('q', dq);
    if (courseId) p.set('courseId', courseId);
    if (orgId) p.set('orgId', orgId);
    if (outcome) p.set('outcome', outcome);
    if (booked) p.set('booked', booked);
    if (level) p.set('level', level);
    return p.toString();
  }, [range, dq, courseId, orgId, outcome, booked, level]);

  useEffect(() => { setPage(1); }, [filters]);

  const meta = useResource('/calls/meta', refresh);
  const list = useResource(`/calls?${filters}&page=${page}`, refresh);
  const data = list.data;
  const pages = data?.pages ?? 1;
  const loadingCopy = meta.data?.enabled && !meta.data?.hydrated;

  // Page 1 refreshes every 30 s for new calls; every 5 s while the copy is still loading.
  useEffect(() => {
    if (page !== 1 && !loadingCopy) return undefined;
    const id = setInterval(() => setRefresh((n) => n + 1), loadingCopy ? 5_000 : 30_000);
    return () => clearInterval(id);
  }, [page, loadingCopy]);

  // Warm the next page so paging feels instant (served from the API cache).
  useEffect(() => {
    if (data && page < pages) api(`/calls?${filters}&page=${page + 1}`).catch(() => {});
  }, [data, page, pages, filters]);

  const clear = () => { setQ(''); setCourseId(''); setOrgId(''); setOutcome(''); setBooked(''); setLevel(''); };
  const chips = [
    q && { k: 'q', label: `“${q}”`, clear: () => setQ('') },
    courseId && { k: 'c', label: meta.data?.courses?.find((x) => String(x.id) === courseId)?.label ?? 'Course', clear: () => setCourseId('') },
    orgId && { k: 'o', label: meta.data?.orgs?.find((x) => String(x.id) === orgId)?.label ?? 'Organization', clear: () => setOrgId('') },
    outcome && { k: 'oc', label: outcome === 'none' ? 'No outcome' : outcome, clear: () => setOutcome('') },
    booked && { k: 'b', label: booked === 'yes' ? 'Booked' : 'Not booked', clear: () => setBooked('') },
    level && { k: 'l', label: LEVELS[level] || level, clear: () => setLevel('') },
  ].filter(Boolean);

  // Drawer navigation within the current page.
  const rows = data?.rows ?? [];
  const idx = open ? rows.findIndex((r) => r.callId === open) : -1;
  const close = useCallback(() => setOpen(null), []);
  const prev = idx > 0 ? () => setOpen(rows[idx - 1].callId) : null;
  const next = idx >= 0 && idx < rows.length - 1 ? () => setOpen(rows[idx + 1].callId) : null;

  const m = meta.data;
  const s = data?.summary;
  const label = RANGES.find((r) => r.value === range).label;
  const fig = !data;

  if (m?.enabled === false) {
    return (
      <>
        <HeroContent><div className="hero__title"><div><h1>Call history</h1><p className="mono title-sub">not configured</p></div></div></HeroContent>
        <div className="dash-grid"><Panel n={1} title="Call history" className="span-12">
          <p className="empty mono">Call history is not configured on this server (CR_DATABASE_URL).</p>
        </Panel></div>
      </>
    );
  }

  return (
    <>
      <HeroContent>
        <div className="hero__title">
          <div>
            <h1>Call history</h1>
            <p className="mono title-sub">
              {data ? `${num(data.total)} calls · ${pct(s?.conversion)} booked · ${num(s?.courses)} courses` : 'loading calls…'}
              {loadingCopy && ' · loading 90-day history'}
            </p>
          </div>
          <div className="title-tools">
            {list.switching && <span className="spin-square" aria-label="Loading" />}
            <Tabs value={range} onChange={setRange} options={RANGES} label="Call date range" />
          </div>
        </div>
      </HeroContent>

      <section className={`figures reveal ${list.switching ? 'is-busy' : ''}`} style={{ '--i': 1 }} aria-label="Call figures">
        <Figure n="A" label={`Calls · ${label}`} loading={fig} value={data?.total} format={(v) => num(Math.round(v))}
          sub={chips.length ? `${chips.length} filter${chips.length > 1 ? 's' : ''} applied` : 'all courses'} />
        <Figure n="B" label="Bookings" loading={fig} value={s?.booked} format={(v) => num(Math.round(v))}
          sub={`${pct(s?.conversion)} of calls booked`} tone={s?.conversion > 0.15 ? 'up' : undefined} />
        <Figure n="C" label="Sent to staff" loading={fig} value={s?.transferred} format={(v) => num(Math.round(v))}
          sub={`${pct(s?.transferRate)} transferred by the agent`} />
        <Figure n="D" label="Avg duration" loading={fig} value={s?.avgDurationSec} format={(v) => duration(v)}
          sub="per call" />
        <Figure n="E" label="Golf courses" loading={fig} value={s?.courses} format={(v) => num(Math.round(v))}
          sub={m ? `${num(m.orgs?.length)} organizations in 90 days` : ''} />
      </section>

      <div className="dash-grid">
        <Panel n={1} i={2} title={`Calls over time · ${label}`} className="span-8" busy={list.switching} error={list.error}>
          {data ? <CallsChart key={filters} series={data.series} /> : <SkeletonRows rows={7} h={20} />}
        </Panel>
        <Panel n={2} i={3} title="Outcomes" className="span-4" busy={list.switching}
          aside={outcome ? <button type="button" className="btn btn--ghost btn--small" onClick={() => setOutcome('')}>Clear</button> : null}>
          <OutcomeBars key={filters.replace(/&?outcome=[^&]*/, '')} items={data?.outcomes} active={outcome} onPick={setOutcome} total={data?.total} />
          {data && <p className="foot-note mono">click an outcome to filter the calls below</p>}
        </Panel>

        <Panel n={3} i={4} title="Calls" className="span-12" busy={list.switching}>
          <div className="ledger__bar calls__bar">
            <div className="search">
              <label htmlFor="calls-q" className="sr-only">Search calls</label>
              <span className="search__icon mono" aria-hidden>/</span>
              <input id="calls-q" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" spellCheck="false"
                placeholder="Search call ID, name, email, phone, course…" />
              {list.loading && <span className="spin-square search__spin" aria-hidden />}
            </div>
            <Select label="Golf course" value={courseId} onChange={setCourseId} options={m?.courses ?? []} />
            <Select label="Organization" value={orgId} onChange={setOrgId} options={m?.orgs ?? []} />
            <Select label="Outcome" value={outcome} onChange={setOutcome} options={m?.outcomes ?? []} />
            <Select label="Booked" value={booked} onChange={setBooked} options={[{ id: 'yes', label: 'Booked' }, { id: 'no', label: 'Not booked' }]} />
            <Select label="Type" value={level} onChange={setLevel} options={m?.levels ?? []} />
          </div>

          {chips.length > 0 && (
            <div className="fchips" aria-label="Active filters">
              {chips.map((c) => (
                <button key={c.k} type="button" className="fchip" onClick={c.clear} aria-label={`Remove filter ${c.label}`}>{c.label} <span aria-hidden>×</span></button>
              ))}
              <button type="button" className="fchip fchip--clear" onClick={clear}>Clear all</button>
            </div>
          )}

          {!data ? <SkeletonRows rows={10} h={22} /> : rows.length === 0 ? (
            <div className="calls__empty">
              <p className="mono">{loadingCopy ? 'Loading call history…' : 'No calls match these filters.'}</p>
              {chips.length > 0 && <button type="button" className="btn btn--ghost btn--small" onClick={clear}>Clear filters</button>}
            </div>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl calls__tbl">
                <thead>
                  <tr>
                    <th>When (UTC)</th><th>Customer</th><th>Golf course / organization</th><th>Type</th>
                    <th className="r">Duration</th><th>Booked</th><th>Outcome</th><th>Call ID</th>
                  </tr>
                </thead>
                <tbody key={`${filters}|${page}`} className="calls__body">
                  {rows.map((c, i) => (
                    <tr key={c.callId} tabIndex={0} style={{ '--i': i }} className={`calls__row ${open === c.callId ? 'is-open' : ''}`} onClick={() => setOpen(c.callId)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(c.callId); } }}>
                      <td className="nowrap">
                        <span className="calls__name mono">{utcDate(c.ts)} {utcTime(c.ts, false)}</span>
                        <span className="calls__sub mono">{ago(c.ts, now)}</span>
                      </td>
                      <td>
                        <span className="calls__name">{c.name || <span className="dim">Unknown caller</span>}</span>
                        <span className="calls__sub mono">{c.email || c.phone || '—'}</span>
                      </td>
                      <td>
                        <span className="calls__name">{c.course || <span className="dim">—</span>}</span>
                        <span className="calls__sub">{c.org || '—'}{c.orgType ? ` · ${c.orgType.toUpperCase()}` : ''}</span>
                      </td>
                      <td>{c.level ? <span className="pill">{LEVELS[c.level] || c.level}</span> : <span className="dim">—</span>}</td>
                      <td className="r mono">{duration(c.durationSec)}</td>
                      <td>{c.booked
                        ? <span className="bk"><i aria-hidden>✓</i> {c.bookedAt ? utcDate(c.bookedAt) : 'Booked'}{c.teeDate ? <span className="calls__sub mono">tee {c.teeDate}</span> : null}</span>
                        : <span className="dim">—</span>}</td>
                      <td><OutcomeTag c={c} /></td>
                      <td className="mono dim" title={c.callId}>{shortId(c.callId)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data && data.total > PAGE_SIZE && (
            <nav className="pager mono" aria-label="Call history pages">
              <span className="pager__info">{num((page - 1) * PAGE_SIZE + 1)}–{num(Math.min(page * PAGE_SIZE, data.total))} of {num(data.total)}</span>
              <div className="pager__btns">
                <button type="button" onClick={() => setPage(page - 1)} disabled={page === 1} aria-label="Previous page">‹ Prev</button>
                {pageList(page, pages).map((p, i) => (p === null
                  ? <span key={`gap-${i}`} className="pager__gap" aria-hidden>…</span>
                  : <button key={p} type="button" className={p === page ? 'is-on' : ''} aria-current={p === page ? 'page' : undefined} onClick={() => setPage(p)}>{num(p)}</button>))}
                <button type="button" onClick={() => setPage(page + 1)} disabled={page === pages} aria-label="Next page">Next ›</button>
              </div>
            </nav>
          )}
        </Panel>
      </div>

      {open && (
        <CallDrawer callId={open} onClose={close} onPrev={prev} onNext={next}
          position={idx >= 0 ? `${(page - 1) * PAGE_SIZE + idx + 1} / ${num(data?.total)}` : ''} />
      )}
    </>
  );
}
