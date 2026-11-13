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
const DAY = 86_400_000;
const RANGES = [
  { value: '24h', label: '24H' },
  { value: '7d', label: '7D' },
  { value: '30d', label: '30D' },
  { value: '90d', label: '90D' },
];
const VIEWS = [
  { value: 'calls', label: 'Calls' },
  { value: 'callers', label: 'Repeat callers' },
];
const CALLER_SORTS = [
  { value: 'calls', label: 'Most calls' },
  { value: 'busiest', label: 'Busiest day' },
  { value: 'courses', label: 'Most courses' },
  { value: 'attention', label: 'Needs attention' },
  { value: 'recent', label: 'Most recent' },
];
const LEVELS = { golf_course: 'Golf course', organization: 'Organization' };
const shortId = (id = '') => (id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);
const when = (ts) => (ts ? `${utcDate(ts)} ${utcTime(ts, false)}` : '—');
const isToday = (ts, now) => Math.floor(ts / DAY) === Math.floor(now / DAY);
const ordinal = (n) => `${n}${['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) || n % 10 > 3 ? 0 : n % 10]}`;

/** Outcome → visual tone: booked (good), problem (warn), handed to staff (accent), info (neutral). */
function tone(outcome) {
  const o = (outcome || '').toLowerCase();
  if (!o || o === 'none') return 'none';
  if (o === 'booking created') return 'ok';
  if (o.includes('fail') || o.includes('unavailable') || o.includes('cancel') || o.includes('declined') || o.includes('incomplete')) return 'warn';
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

function Pager({ page, pages, total, onPage, label }) {
  if (!total || total <= PAGE_SIZE) return null;
  return (
    <nav className="pager mono" aria-label={label}>
      <span className="pager__info">{num((page - 1) * PAGE_SIZE + 1)}–{num(Math.min(page * PAGE_SIZE, total))} of {num(total)}</span>
      <div className="pager__btns">
        <button type="button" onClick={() => onPage(page - 1)} disabled={page === 1} aria-label="Previous page">‹ Prev</button>
        {pageList(page, pages).map((p, i) => (p === null
          ? <span key={`gap-${i}`} className="pager__gap" aria-hidden>…</span>
          : <button key={p} type="button" className={p === page ? 'is-on' : ''} aria-current={p === page ? 'page' : undefined} onClick={() => onPage(p)}>{num(p)}</button>))}
        <button type="button" onClick={() => onPage(page + 1)} disabled={page === pages} aria-label="Next page">Next ›</button>
      </div>
    </nav>
  );
}

function Select({ label, value, onChange, options, all = 'All' }) {
  return (
    <label className="cf">
      <span className="cf__l mono">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {all !== null && <option value="">{all}</option>}
        {options.map((o) => <option key={o.id ?? o.value} value={o.id ?? o.value}>{o.label}{o.count !== undefined ? ` (${num(o.count)})` : ''}</option>)}
      </select>
    </label>
  );
}

function OutcomeTag({ c }) {
  if (c.outcome) return <span className={`oc oc--${tone(c.outcome)}`}>{c.outcome}</span>;
  return <span className="dim mono oc-end">{c.endReason ? c.endReason.replace(/-/g, ' ') : '—'}</span>;
}

/** "×3 today" — this caller's calls on the same UTC day. Opens their history. */
function RepeatBadge({ c, now, onOpenCaller }) {
  if (!c.callerId || !(c.dayCount > 1)) return null;
  const day = isToday(c.ts, now) ? 'today' : 'that day';
  return (
    <button type="button" className="rpt mono" title={`${ordinal(c.dayIndex)} of ${c.dayCount} calls from this number ${day} (UTC). Click for their call history.`}
      onClick={(e) => { e.stopPropagation(); onOpenCaller(c.callerId); }}>
      ×{c.dayCount} {day}
    </button>
  );
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
            <span className="ob__bar"><i className={`ob__fill ob__fill--${tone(o.id)}`} style={{ width: `${(o.count / max) * 100}%` }} /></span>
            <span className="ob__n mono">{num(o.count)}</span>
            <span className="ob__p mono dim">{pct(total ? o.count / total : null, 0)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Thin stacked bar of a caller's outcomes by tone. */
function OutcomeMix({ outcomes, calls }) {
  const tones = { ok: 0, staff: 0, warn: 0, info: 0, none: 0 };
  for (const o of outcomes) tones[tone(o.id)] += o.count;
  const title = outcomes.slice(0, 5).map((o) => `${o.id === 'none' ? 'No outcome' : o.id}: ${o.count}`).join(' · ');
  return (
    <span className="mix" title={title} aria-label={title}>
      {Object.entries(tones).filter(([, n]) => n).map(([t, n]) => <i key={t} className={`mix__seg ob__fill--${t}`} style={{ flexGrow: n / calls }} />)}
    </span>
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

/** Shared drawer shell, rendered into <body> (the page area has its own stacking context). */
function Drawer({ label, onClose, escapeEnabled = true, onKey, children, className = '' }) {
  const panelRef = useRef(null);
  useEffect(() => { panelRef.current?.focus(); }, []);
  useEffect(() => {
    const h = (e) => {
      if (!escapeEnabled) return;
      if (e.key === 'Escape') onClose();
      else onKey?.(e);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose, onKey, escapeEnabled]);
  return createPortal(
    <div className={`cd ${className}`} role="dialog" aria-modal="true" aria-label={label}>
      <button type="button" className="cd__scrim" aria-label="Close" onClick={onClose} tabIndex={-1} />
      <aside className="cd__panel" ref={panelRef} tabIndex={-1}>{children}</aside>
    </div>,
    document.body,
  );
}

/** One call. Heavy fields are fetched on open; ←/→ step through the current page. */
function CallDrawer({ callId, onClose, onPrev, onNext, position, onOpenCaller, callerOpen }) {
  const res = useResource(`/calls/${encodeURIComponent(callId)}`);
  const [tab, setTab] = useState('overview');
  const [translated, setTranslated] = useState(false);
  useEffect(() => { setTab('overview'); setTranslated(false); }, [callId]);
  const onKey = useCallback((e) => {
    if (e.target.closest?.('audio')) return;
    if (e.key === 'ArrowLeft' && onPrev) onPrev();
    else if (e.key === 'ArrowRight' && onNext) onNext();
  }, [onPrev, onNext]);
  const c = res.data?.call;
  const d = res.data?.detail;

  return (
    <Drawer label={`Call ${callId}`} onClose={onClose} onKey={onKey}>
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
          <button type="button" className="btn btn--ghost btn--small" onClick={onClose}>Close ✕</button>
        </div>
      </header>

      {c && (
        <div className="cd__chips">
          <OutcomeTag c={c} />
          {c.booked && <span className="oc oc--ok">✓ Booked{c.bookingNumber ? ` #${c.bookingNumber}` : ''}</span>}
          {c.endReason === 'assistant-forwarded-call' && <span className="oc oc--staff">Transferred to staff</span>}
          <span className="oc oc--info">{duration(c.durationSec)}</span>
          <span className="oc oc--info mono">{when(c.ts)} UTC</span>
          {c.dayCount > 1 && <span className="oc oc--warn">{ordinal(c.dayIndex)} of {c.dayCount} calls that day</span>}
        </div>
      )}
      {c?.callerId && c.callerCalls > 1 && !callerOpen && (
        <button type="button" className="cd__caller-link" onClick={() => onOpenCaller(c.callerId)}>
          View this caller's history <span className="mono">· {num(c.callerCalls)} calls in 90 days →</span>
        </button>
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
            <div><dt>Golf course</dt><dd>{c.course || '—'}{c.mappedFrom === 'line' && <span className="dim mono" title="This call record had no course; it was matched from the course line the caller dialled."> · via dialled line</span>}</dd></div>
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
    </Drawer>
  );
}

/** One caller: calls per day (newest first) in the selected range, with courses and outcomes. */
function CallerDrawer({ callerId, range, onClose, onOpenCall, callOpen }) {
  const res = useResource(`/calls/callers/${callerId}?range=${range}`);
  const k = res.data;
  const maxDay = k && k.days.length ? Math.max(...k.days.map((d) => d.count)) : 0;
  return (
    <Drawer label="Caller history" onClose={onClose} escapeEnabled={!callOpen} className="cd--caller">
      <header className="cd__head">
        <div className="cd__title">
          <p className="cd__k mono">Caller history · {RANGES.find((r) => r.value === range)?.label}</p>
          <h2>{k ? (k.name || 'Unknown caller') : 'Loading…'}</h2>
          {k && (
            <p className="mono dim cd__id">
              {k.phone} <Copy value={k.phone} label="phone" />
              {k.email && <> · {k.email} <Copy value={k.email} label="email" /></>}
            </p>
          )}
        </div>
        <div className="cd__nav"><button type="button" className="btn btn--ghost btn--small" onClick={onClose}>Close ✕</button></div>
      </header>

      {res.error && <p className="panel__error mono" role="alert">{res.error.status === 404 ? 'No calls from this number in the 90-day history.' : 'Couldn\'t load this caller.'}</p>}
      {!k ? (!res.error && <SkeletonRows rows={10} h={16} />) : (
        <div className="cd__body cd__fade">
          <dl className="kv4">
            <div><dt>Calls in range</dt><dd className="mono">{num(k.calls)}</dd></div>
            <div><dt>Busiest day</dt><dd className={`mono ${maxDay >= 3 ? 'hot' : ''}`}>{num(maxDay)}</dd></div>
            <div><dt>Booked</dt><dd className="mono">{num(k.booked)}</dd></div>
            <div><dt>90-day total</dt><dd className="mono">{num(k.totalCalls)}</dd></div>
          </dl>
          {k.internal && <p><span className="oc oc--info">Internal / test caller</span></p>}

          {k.courses.length > 0 && (
            <section className="cd__card">
              <h3>Courses called</h3>
              <ul className="ob">
                {k.courses.map((co, i) => (
                  <li key={co.id ?? 'none'} style={{ '--i': i }}>
                    <div className="ob__row ob__row--static">
                      <span className="ob__label">{co.label}</span>
                      <span className="ob__bar"><i className="ob__fill ob__fill--info" style={{ width: `${(co.count / k.courses[0].count) * 100}%` }} /></span>
                      <span className="ob__n mono">{num(co.count)}</span>
                      <span className="ob__p mono dim">{pct(co.count / k.calls, 0)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h3 className="tl__h">Timeline</h3>
            {k.days.length === 0 && <p className="dim mono">No calls in this range.</p>}
            <ol className="tl">
              {k.days.map((d, di) => (
                <li key={d.day} className="tl__day" style={{ '--i': Math.min(di, 15) }}>
                  <div className="tl__dh">
                    <span className="mono tl__date">{utcDate(d.day)}</span>
                    <span className="tl__count mono">{d.count} call{d.count > 1 ? 's' : ''} · {d.courses} course{d.courses > 1 ? 's' : ''}</span>
                    <span className="tl__bar"><i style={{ width: `${(d.count / Math.max(1, maxDay)) * 100}%` }} className={d.count >= 3 ? 'is-hot' : ''} /></span>
                  </div>
                  <ul className="tl__calls">
                    {d.calls.map((c) => (
                      <li key={c.callId}>
                        <button type="button" className="tl__call" onClick={() => onOpenCall(c.callId)}>
                          <span className="mono dim">{utcTime(c.ts, false)}</span>
                          <span className="tl__course">{c.course || c.org || 'Unknown course'}</span>
                          <OutcomeTag c={c} />
                          <span className="mono dim">{duration(c.durationSec)}</span>
                          {c.booked ? <span className="bk"><i aria-hidden>✓</i></span> : <span />}
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </Drawer>
  );
}

/** Calls grouped by caller (phone) for the current range and filters. */
function RepeatCallers({ filters, onOpenCaller, now }) {
  const [sort, setSort] = useState('calls');
  const [minCalls, setMinCalls] = useState('2');
  const [minPerDay, setMinPerDay] = useState('');
  const [page, setPage] = useState(1);
  const query = `${filters}&sort=${sort}&minCalls=${minCalls}${minPerDay ? `&minPerDay=${minPerDay}` : ''}`;
  useEffect(() => { setPage(1); }, [query]);
  const res = useResource(`/calls/callers?${query}&page=${page}`);
  const d = res.data;
  const s = d?.summary;
  return (
    <>
      <div className="ledger__bar calls__bar calls__bar--sub">
        <Select label="Sort" value={sort} onChange={setSort} options={CALLER_SORTS} all={null} />
        <Select label="Calls in range" value={minCalls} onChange={setMinCalls} all={null}
          options={[{ value: '2', label: '2 or more' }, { value: '3', label: '3 or more' }, { value: '5', label: '5 or more' }, { value: '10', label: '10 or more' }]} />
        <Select label="Calls on one day" value={minPerDay} onChange={setMinPerDay} all="Any"
          options={[{ value: '2', label: '2+ in a day' }, { value: '3', label: '3+ in a day' }, { value: '4', label: '4+ in a day' }, { value: '10', label: '10+ in a day' }]} />
        {res.loading && <span className="spin-square" aria-label="Loading" />}
      </div>
      {s && (
        <p className="ledger__meta mono">
          <b>{num(s.uniqueCallers)}</b> callers · <b>{num(s.repeatCallers)}</b> called more than once ({pct(s.repeatRate)}) · <b>{num(s.callsPerCaller, 1)}</b> calls per caller ·{' '}
          <button type="button" className="linkish mono" onClick={() => setSort('attention')}><b>{num(s.needsAttention)}</b> need attention</button>
          {s.highVolume > 0 && <> · <b>{num(s.highVolume)}</b> high-volume numbers</>}
        </p>
      )}
      {res.error && <p className="panel__error mono" role="alert">Couldn't load callers. It will retry on the next change.</p>}
      {!d ? <SkeletonRows rows={10} h={22} /> : d.rows.length === 0 ? (
        <div className="calls__empty"><p className="mono">No callers match. Try a lower minimum or a longer range.</p></div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl calls__tbl">
            <thead>
              <tr><th>Caller</th><th className="r">Calls</th><th>Busiest day</th><th>Courses called</th><th className="r">Booked</th><th>Outcomes</th><th>Last call</th></tr>
            </thead>
            <tbody key={`${query}|${page}`} className="calls__body">
              {d.rows.map((k, i) => (
                <tr key={k.id} tabIndex={0} style={{ '--i': i }} className="calls__row" onClick={() => onOpenCaller(k.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenCaller(k.id); } }}>
                  <td>
                    <span className="calls__name">
                      {k.name || <span className="dim">Unknown caller</span>}
                      {k.needsAttention && <span className="flag flag--warn">needs attention</span>}
                      {k.highVolume && <span className="flag">high volume</span>}
                    </span>
                    <span className="calls__sub mono">{k.phone}{k.email ? ` · ${k.email}` : ''}</span>
                  </td>
                  <td className="r mono calls__big">{num(k.calls)}</td>
                  <td>
                    <span className="calls__name mono"><b className={k.busiest.count >= 3 ? 'hot' : ''}>{k.busiest.count}</b> on {utcDate(k.busiest.day)}</span>
                    <span className="calls__sub mono">{k.days} day{k.days > 1 ? 's' : ''} with calls</span>
                  </td>
                  <td>
                    <span className="cchips">
                      {k.courses.slice(0, 3).map((co) => <span key={co.id ?? 'none'} className="cchip">{co.label} <b className="mono">×{co.count}</b></span>)}
                      {k.courses.length > 3 && <span className="cchip cchip--more mono">+{k.courses.length - 3}</span>}
                    </span>
                  </td>
                  <td className="r mono">{k.booked ? <span className="bk"><i aria-hidden>✓</i> {k.booked}</span> : <span className="dim">0</span>}</td>
                  <td><OutcomeMix outcomes={k.outcomes} calls={k.calls} /></td>
                  <td className="nowrap"><span className="calls__name mono">{ago(k.lastTs, now)}</span><span className="calls__sub mono">{when(k.lastTs)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager page={page} pages={d?.pages ?? 1} total={d?.total} onPage={setPage} label="Repeat caller pages" />
    </>
  );
}

export default function CallsPage() {
  const now = useNow(30_000);
  const [view, setView] = useState('calls');
  const [range, setRange] = useState('7d');
  const [q, setQ] = useState('');
  const [courseId, setCourseId] = useState('');
  const [orgId, setOrgId] = useState('');
  const [outcome, setOutcome] = useState('');
  const [booked, setBooked] = useState('');
  const [level, setLevel] = useState('');
  const [internal, setInternal] = useState(true); // internal/test calls shown by default
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(null);
  const [caller, setCaller] = useState(null);
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
    if (internal) p.set('internal', '1');
    return p.toString();
  }, [range, dq, courseId, orgId, outcome, booked, level, internal]);

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
    if (view === 'calls' && data && page < pages) api(`/calls?${filters}&page=${page + 1}`).catch(() => {});
  }, [view, data, page, pages, filters]);

  const clear = () => { setQ(''); setCourseId(''); setOrgId(''); setOutcome(''); setBooked(''); setLevel(''); setInternal(true); };
  const chips = [
    q && { k: 'q', label: `“${q}”`, clear: () => setQ('') },
    courseId && { k: 'c', label: meta.data?.courses?.find((x) => String(x.id) === courseId)?.label ?? 'Course', clear: () => setCourseId('') },
    orgId && { k: 'o', label: meta.data?.orgs?.find((x) => String(x.id) === orgId)?.label ?? 'Organization', clear: () => setOrgId('') },
    outcome && { k: 'oc', label: outcome === 'none' ? 'No outcome' : outcome, clear: () => setOutcome('') },
    booked && { k: 'b', label: booked === 'yes' ? 'Booked' : 'Not booked', clear: () => setBooked('') },
    level && { k: 'l', label: LEVELS[level] || level, clear: () => setLevel('') },
    !internal && { k: 'i', label: 'Hiding internal', clear: () => setInternal(true) },
  ].filter(Boolean);

  // Drawer navigation within the current page.
  const rows = data?.rows ?? [];
  const idx = open ? rows.findIndex((r) => r.callId === open) : -1;
  const closeCall = useCallback(() => setOpen(null), []);
  const closeCaller = useCallback(() => setCaller(null), []);
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
        <Figure n="E" label="Unique callers" loading={fig} value={s?.uniqueCallers} format={(v) => num(Math.round(v))}
          sub={`${pct(s?.repeatRate)} called more than once`} />
      </section>

      <div className="dash-grid">
        <Panel n={1} i={2} title={`Calls over time · ${label}`} className="span-8" busy={list.switching} error={list.error}>
          {data ? <CallsChart key={filters} series={data.series} order={m?.outcomes ?? data.outcomes} active={outcome} onPick={setOutcome} /> : <SkeletonRows rows={7} h={20} />}
        </Panel>
        <Panel n={2} i={3} title="Outcomes" className="span-4" busy={list.switching}
          aside={outcome ? <button type="button" className="btn btn--ghost btn--small" onClick={() => setOutcome('')}>Clear</button> : null}>
          <OutcomeBars key={filters.replace(/&?outcome=[^&]*/, '')} items={data?.outcomes} active={outcome} onPick={setOutcome} total={data?.total} />
          {data && <p className="foot-note mono">click an outcome to filter the calls below</p>}
        </Panel>

        <Panel n={3} i={4} title={view === 'calls' ? 'Calls' : 'Repeat callers'} className="span-12" busy={view === 'calls' && list.switching}
          aside={<Tabs value={view} onChange={setView} options={VIEWS} label="View" />}>
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
            <label className="cf cf--check">
              <span className="cf__l mono">Internal</span>
              <span className="cf__box"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> include test calls</span>
            </label>
          </div>

          {chips.length > 0 && (
            <div className="fchips" aria-label="Active filters">
              {chips.map((c) => (
                <button key={c.k} type="button" className="fchip" onClick={c.clear} aria-label={`Remove filter ${c.label}`}>{c.label} <span aria-hidden>×</span></button>
              ))}
              <button type="button" className="fchip fchip--clear" onClick={clear}>Clear all</button>
            </div>
          )}

          {view === 'callers' ? (
            <RepeatCallers filters={filters} onOpenCaller={setCaller} now={now} />
          ) : (
            <>
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
                        <th className="r">Duration</th><th className="r">Cost</th><th>Booked</th><th>Outcome</th><th>Call ID</th>
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
                            <span className="calls__name">
                              {c.name || <span className="dim">Unknown caller</span>}
                              <RepeatBadge c={c} now={now} onOpenCaller={setCaller} />
                            </span>
                            <span className="calls__sub mono">{c.email || c.phone || '—'}</span>
                          </td>
                          <td>
                            <span className="calls__name">{c.course || <span className="dim">—</span>}</span>
                            <span className="calls__sub">{c.org || '—'}{c.orgType ? ` · ${c.orgType.toUpperCase()}` : ''}</span>
                          </td>
                          <td>{c.level ? <span className="pill">{LEVELS[c.level] || c.level}</span> : <span className="dim">—</span>}</td>
                          <td className="r mono">{duration(c.durationSec)}</td>
                          <td className={`r mono ${c.cost === null || c.cost === undefined ? 'dim' : ''}`}>{moneySmart(c.cost)}</td>
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
              <Pager page={page} pages={pages} total={data?.total} onPage={setPage} label="Call history pages" />
            </>
          )}
        </Panel>
      </div>

      {caller && <CallerDrawer callerId={caller} range={range} onClose={closeCaller} onOpenCall={setOpen} callOpen={!!open} />}
      {open && (
        <CallDrawer callId={open} onClose={closeCall} onPrev={prev} onNext={next} onOpenCaller={setCaller} callerOpen={!!caller}
          position={idx >= 0 ? `${(page - 1) * PAGE_SIZE + idx + 1} / ${num(data?.total)}` : ''} />
      )}
    </>
  );
}
