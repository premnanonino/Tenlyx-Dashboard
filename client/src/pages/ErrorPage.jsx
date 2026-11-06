import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ThemeToggle } from '../lib/theme.jsx';
import { useNow } from '../lib/hooks.js';
import { utcTime } from '../lib/format.js';
import { makeRef, suggestRoute } from '../lib/errors.js';
import '../styles/error.css';

/*
 * One page for every failure: 404, render crash, stale deploy, offline.
 * Statically bundled (never lazy) so it renders even when chunks fail.
 * Deliberately shows no error messages, stacks or setup hints: visitors
 * see a plain explanation and a reference id, nothing about internals.
 */
const KINDS = {
  notfound: {
    code: '404', status: 'Not found', stamp: 'Void', title: ['Page', 'not found'],
    lead: "There's no page at this address. The link may be mistyped, or the page has moved.",
  },
  crash: {
    code: '500', status: 'Render error', stamp: 'Failed', title: ['Something', 'broke'],
    lead: 'This screen ran into a problem. No data was changed and nothing was charged. Try again, or come back in a moment.',
  },
  chunk: {
    code: '410', status: 'Stale version', stamp: 'Expired', title: ['New version', 'deployed'],
    lead: 'The dashboard was updated while this tab was open, so a file this screen needs is gone. Reload to get the latest version.',
  },
  offline: {
    code: '000', status: 'No connection', stamp: 'Held', title: ["You're", 'offline'],
    lead: "The browser can't reach the network, so this screen couldn't load. It retries by itself as soon as you're back online.",
  },
};

const RELOAD_KEY = 'tlx-stale-reload';

const subscribeOnline = (cb) => {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => { window.removeEventListener('online', cb); window.removeEventListener('offline', cb); };
};
const useOnline = () => useSyncExternalStore(subscribeOnline, () => navigator.onLine);

export default function ErrorPage({ kind = 'notfound', onRetry, embedded = false }) {
  const k = KINDS[kind] ?? KINDS.crash;
  const location = useLocation();
  const navigate = useNavigate();
  const now = useNow(1000);
  const online = useOnline();
  const headRef = useRef(null);
  const [issuedAt] = useState(() => Date.now());
  const [ref] = useState(makeRef);

  const path = location.pathname + location.search;
  const suggestion = useMemo(() => (kind === 'notfound' ? suggestRoute(location.pathname) : null), [kind, location.pathname]);
  const issued = new Date(issuedAt).toISOString().slice(0, 19).replace('T', ' ');
  const canGoBack = typeof window !== 'undefined' && window.history.length > 1;
  const reload = () => window.location.reload();

  // Announce the error: move focus to the heading.
  useEffect(() => { headRef.current?.focus({ preventScroll: embedded }); }, [embedded]);

  useEffect(() => {
    if (embedded) return undefined;
    const prev = document.title;
    document.title = `${k.code} · ${k.status} — TLX/MON`;
    return () => { document.title = prev; };
  }, [k, embedded]);

  // Stale deploy: reload once automatically (guarded so it can never loop).
  useEffect(() => {
    if (kind !== 'chunk') return;
    try {
      const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
      if (Date.now() - last > 30_000) {
        sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
        window.location.reload();
      }
    } catch { /* storage blocked: the Reload button still works */ }
  }, [kind]);

  // Offline: lazy() caches the failed import, so recover with a full reload.
  useEffect(() => { if (kind === 'offline' && online) window.location.reload(); }, [kind, online]);

  const primary = {
    notfound: <Primary to="/dashboard">Open dashboard</Primary>,
    crash: <Primary onClick={onRetry ?? reload}>Try again</Primary>,
    chunk: <Primary onClick={reload}>Reload now</Primary>,
    offline: <Primary onClick={reload}>Retry now</Primary>,
  }[kind] ?? <Primary onClick={reload}>Reload</Primary>;

  return (
    <main className={`errp errp--${kind}${embedded ? ' errp--embedded' : ''}`} aria-labelledby="errp-title">
      {!embedded && <a href="#errp-actions" className="skip">Skip to actions</a>}

      <section className="errp__main">
        {!embedded && (
          <div className="errp__top">
            <Link to="/" className="errp__back mono">← Globe</Link>
            <ThemeToggle />
          </div>
        )}

        <div className="errp__body">
          <p className="errp__kicker mono"><span>ERR {k.code}</span> {k.status}</p>
          <h1 id="errp-title" ref={headRef} tabIndex={-1}>
            <span>{k.title[0]}</span>
            <span>{k.title[1]}<em>.</em></span>
          </h1>
          <p className="errp__lead">{k.lead}</p>

          {kind === 'notfound' && (
            <p className="errp__path mono"><span>requested</span><code title={path}>{path}</code></p>
          )}

          {suggestion && (
            <Link className="errp__suggest" to={suggestion.to}>
              <span className="errp__suggest-k mono">did you mean</span>
              <b>{suggestion.label}</b>
              <code className="mono">{suggestion.to}</code>
              <span className="errp__suggest-go" aria-hidden>→</span>
            </Link>
          )}

          {kind === 'offline' && !online && (
            <p className="errp__wait mono" role="status"><span className="spin-square" aria-hidden /> waiting for connection…</p>
          )}

          <div id="errp-actions" className="errp__actions">
            {primary}
            <div className="errp__secondary">
              {kind === 'notfound' && canGoBack && (
                <button type="button" className="errp__btn" onClick={() => navigate(-1)}>← Go back</button>
              )}
              {kind === 'crash' && <button type="button" className="errp__btn" onClick={reload}>Reload page</button>}
              {kind !== 'notfound' && !embedded && <Link className="errp__btn" to="/dashboard">Open dashboard</Link>}
              {kind !== 'notfound' && embedded && <Link className="errp__btn" to="/dashboard">Overview</Link>}
              {!embedded && kind === 'notfound' && <Link className="errp__btn" to="/dashboard/reports">Statements</Link>}
            </div>
          </div>

          <p className="errp__foot mono">ref {ref} · {issued} UTC</p>
        </div>
      </section>

      <aside className="errp__side" aria-label="Error statement">
        {!embedded && (
          <div className="errp__side-top">
            <Link to="/" className="mark mark--dark">TLX/MON</Link>
            <span className="mono">{utcTime(now)} UTC</span>
          </div>
        )}
        <Matrix code={k.code} />
        {!embedded && (
          <Receipt k={k} ref_={ref} issued={issued} path={path} />
        )}
      </aside>
    </main>
  );
}

function Primary({ to, onClick, children }) {
  const inner = (
    <>
      <span className="errp__primary-fill" aria-hidden />
      <span>{children}</span>
      <span aria-hidden>→</span>
    </>
  );
  return to
    ? <Link className="errp__primary" to={to}>{inner}</Link>
    : <button type="button" className="errp__primary" onClick={onClick}>{inner}</button>;
}

/* ---- dot-matrix status display ------------------------------------------ */
const FONT = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};

function Matrix({ code }) {
  const { cols, cells } = useMemo(() => {
    const digits = code.split('');
    const inner = digits.length * 6 - 1;
    const width = inner + 2; // one-cell frame around the digits
    const out = [];
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < width; c++) {
        const gr = r - 1;
        const gc = c - 1;
        const d = Math.floor(gc / 6);
        const x = gc % 6;
        const on = gr >= 0 && gr < 7 && gc >= 0 && gc < inner && x < 5 && FONT[digits[d]]?.[gr][x] === '1';
        const i = r * width + c;
        out.push({ on, c, r, flick: !on && (i * 7) % 13 === 0, blink: on && (i * 5) % 17 === 0, d: (i * 37) % 2100 });
      }
    }
    return { cols: width, cells: out };
  }, [code]);

  return (
    <div className="errp__matrix" style={{ '--cols': cols }} aria-hidden>
      {cells.map((p, i) => (
        <i key={i}
          className={[p.on && 'on', p.flick && 'f', p.blink && 'b'].filter(Boolean).join(' ') || undefined}
          style={{ '--c': p.c, '--r': p.r, '--d': `${p.d}ms` }} />
      ))}
    </div>
  );
}

/* ---- printed receipt ------------------------------------------------------ */
const TEAR = `0,0 ${Array.from({ length: 41 }, (_, i) => `${i * 5},${i % 2 ? 7 : 0}`).join(' ')} 200,0`;

function Receipt({ k, ref_, issued, path }) {
  return (
    <div className="errp__printer">
      <div className="errp__slot" aria-hidden />
      <div className="errp__feed">
        <div className="errp__receipt">
          <div className="errp__r-head mono"><b>TLX/MON</b><span>Error statement</span></div>
          <dl className="errp__r-lines mono">
            <div><dt>No.</dt><dd>{ref_}</dd></div>
            <div><dt>Issued</dt><dd>{issued}</dd></div>
            <div><dt>Request</dt><dd title={path}>{path}</dd></div>
            <div><dt>Status</dt><dd>{k.code} · {k.status}</dd></div>
            <div><dt>Charge</dt><dd>$0.00</dd></div>
          </dl>
          <div className="errp__r-total mono"><span>Total due</span><b>$0.00</b></div>
          <p className="errp__r-note mono">Errors are never billed</p>
          <Barcode seed={ref_} />
          <span className="errp__stamp" aria-hidden>{k.stamp}</span>
          <svg className="errp__tear" viewBox="0 0 200 7" preserveAspectRatio="none" aria-hidden>
            <polygon points={TEAR} />
          </svg>
        </div>
      </div>
    </div>
  );
}

function Barcode({ seed }) {
  const bars = useMemo(() => {
    let h = [...seed].reduce((a, ch) => (Math.imul(a, 31) + ch.charCodeAt(0)) >>> 0, 2166136261);
    const out = [];
    for (let x = 0; x < 200;) {
      h = (Math.imul(h, 1103515245) + 12345) >>> 0;
      const w = 1 + ((h >>> 16) % 3);
      out.push({ x, w });
      x += w + 1 + ((h >>> 20) % 2);
    }
    return out;
  }, [seed]);
  return (
    <svg className="errp__barcode" viewBox="0 0 200 30" preserveAspectRatio="none" aria-hidden>
      {bars.map((b) => <rect key={b.x} x={b.x} width={b.w} height="30" />)}
    </svg>
  );
}
