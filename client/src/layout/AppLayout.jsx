import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api, useResource } from '../lib/api.js';
import { useStream } from '../lib/stream.js';
import { useNow } from '../lib/hooks.js';
import { ago, utcDate, utcTime } from '../lib/format.js';
import { TopProgress } from '../components/ui.jsx';
import { ThemeToggle } from '../lib/theme.jsx';
import { ErrorBoundary } from '../components/ErrorBoundary.jsx';
import { classify } from '../lib/errors.js';
import ErrorPage from '../pages/ErrorPage.jsx';
import '../styles/dashboard.css';
import '../styles/nav.css';
import '../styles/charts.css';
import '../styles/hero.css';

const LiveContext = createContext(null);
export const useLive = () => useContext(LiveContext);

/**
 * Pages render their title/controls into the hero via a portal, so the
 * page keeps owning that state (range pickers etc.) while the markup is
 * layered over the hero image owned by the layout.
 */
const HeroSlotContext = createContext(null);
export function HeroContent({ children }) {
  const slot = useContext(HeroSlotContext);
  return slot ? createPortal(children, slot) : null;
}

const SECTIONS = {
  overview: { n: '01', label: 'Billing overview' },
  ai: { n: '02', label: 'Conversational AI' },
  reports: { n: '03', label: 'Monthly statements' },
};
const UNKNOWN_SECTION = { n: '404', label: 'Not found' };

/** Fixed floating nav once the in-hero nav has scrolled out of view. */
function useStuck() {
  const ref = useRef(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (!ref.current) return undefined;
    const io = new IntersectionObserver(([e]) => setStuck(!e.isIntersecting && e.boundingClientRect.top < 0), { threshold: 0 });
    io.observe(ref.current);
    return () => io.disconnect();
  }, []);
  return [ref, stuck];
}

const LINKS = [
  { to: '/dashboard', end: true, n: '01', label: 'Overview' },
  { to: '/dashboard/ai', n: '02', label: 'Conversational AI' },
  { to: '/dashboard/reports', n: '03', label: 'Reports' },
];

/** Nav links with a solid indicator that slides to the active tab. */
function NavLinks({ alerts }) {
  const listRef = useRef(null);
  const location = useLocation();
  const [bar, setBar] = useState(null);

  const measure = useCallback(() => {
    const el = listRef.current?.querySelector('a.is-active');
    if (el) setBar({ x: el.offsetLeft, w: el.offsetWidth });
  }, []);

  useLayoutEffect(() => { measure(); }, [location.pathname, measure, alerts]);
  useEffect(() => {
    window.addEventListener('resize', measure);
    document.fonts?.ready.then(measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  return (
    <nav className="nav__links" aria-label="Sections">
      <ul ref={listRef}>
        {LINKS.map((l) => (
          <li key={l.to}>
            <NavLink to={l.to} end={l.end} className={({ isActive }) => (isActive ? 'is-active' : '')}>
              <span className="nav__n mono">{l.n}</span>
              {l.label}
              {l.end && alerts > 0 && <span className="nav__badge mono" title={`${alerts} active alerts`}>{alerts}</span>}
            </NavLink>
          </li>
        ))}
      </ul>
      {bar && <span className="nav__bar" style={{ transform: `translateX(${bar.x}px)`, width: bar.w }} aria-hidden />}
    </nav>
  );
}

/**
 * Auth gate: verify the session before rendering anything. Any later 401
 * (expired session) raises 'tlx:unauthorized' from the api layer and sends
 * the user back to /login with a return path.
 */
export default function AppLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [user, setUser] = useState(null);

  useEffect(() => {
    // Capture the return path now, and redirect at most once: in dev,
    // StrictMode mounts effects twice, and a second redirect fired after the
    // first would otherwise produce /login?next=/login.
    const next = window.location.pathname + window.location.search;
    let active = true;
    const toLogin = () => {
      if (!active || window.location.pathname === '/login') return;
      active = false;
      navigate(`/login?next=${encodeURIComponent(next)}`, { replace: true });
    };
    api('/auth/me')
      .then((me) => { if (!active) return; if (me.authenticated) setUser(me); else toLogin(); })
      .catch(toLogin);
    window.addEventListener('tlx:unauthorized', toLogin);
    return () => { active = false; window.removeEventListener('tlx:unauthorized', toLogin); };
  }, [navigate]);

  if (!user) {
    return (
      <div className="module-loader" role="status">
        <span className="spin-square" aria-hidden />
        <span>verifying session</span>
      </div>
    );
  }
  return <Shell user={user} location={location} />;
}

function Shell({ user, location }) {
  const now = useNow(1000);
  const [slot, setSlot] = useState(null);
  const [navSpacer, stuck] = useStuck();
  const navigate = useNavigate();
  const [tape, setTape] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);

  const onRecords = useCallback((evt) => setTape((t) => [...evt.latest, ...t].slice(0, 24)), []);
  const stream = useStream({ onRecords });
  const alerts = useResource('/alerts', stream.tick);

  useEffect(() => {
    api('/records?range=24h&limit=16').then((r) => setTape((t) => (t.length ? t : r.rows))).catch(() => {});
  }, []);

  // Sync progress: initial snapshot, then live updates over the stream.
  const [syncSnap, setSyncSnap] = useState(null);
  useEffect(() => { api('/sync/status').then(setSyncSnap).catch(() => {}); }, []);
  const syncInfo = stream.sync ?? syncSnap;
  const fill = syncInfo?.backfill;
  const throttled = (syncInfo?.throttle?.coolingDownMs ?? 0) > 0
    || (syncInfo?.throttle?.lastThrottleAt && now - syncInfo.throttle.lastThrottleAt < 60_000);

  const syncNow = async () => {
    setSyncing(true); setSyncMsg(null);
    try {
      const r = await api('/sync', { method: 'POST' });
      // Runs in the background; new rows stream in as they arrive.
      setSyncMsg(r.throttledForMs > 0 ? `queued · ${Math.ceil(r.throttledForMs / 1000)}s` : 'syncing…');
    } catch (e) {
      setSyncMsg(e.status === 429 ? 'slow down' : 'try again');
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMsg(null), 3000);
    }
  };

  const streamLabel = {
    live: `live · ${stream.lastEventAt ? ago(stream.lastEventAt, now) : 'connected'}`,
    connecting: 'connecting',
    reconnecting: 'reconnecting',
    closed: 'offline',
  }[stream.status];

  const signOut = async () => {
    try { await api('/auth/logout', { method: 'POST' }); } finally { navigate('/login', { replace: true }); }
  };

  const section = location.pathname.split('/')[2] || 'overview';
  const sec = SECTIONS[section] ?? UNKNOWN_SECTION;
  const activeAlerts = alerts.data?.active.length || 0;

  return (
    <LiveContext.Provider value={{ stream, tick: stream.tick, tape, mode: stream.mode, alerts }}>
      <div className="dash">
        <a href="#main" className="skip">Skip to content</a>
        <TopProgress />
        <div className="hero-wrap">
          {/* The nav sits OUTSIDE .hero (which isolates its own stacking
              context for the image layers) so that when pinned, its z-index
              competes with the page, not just with the hero. */}
          <div className="hero__navbox on-dark" ref={navSpacer}>
        <header className={`nav nav--float ${stuck ? 'is-stuck' : ''}`}>
          <div className="nav__row">
            <Link to="/" className="mark" aria-label="Back to globe">TLX/MON</Link>
            {stream.mode && <span className="chip mono chip--live">LIVE API</span>}
            <NavLinks alerts={activeAlerts} />
            <div className="nav__right">
              <span className={`stream mono stream--${stream.status}`}><i />{streamLabel}</span>
              {fill && !fill.done && (
                <span className="fill mono" role="status" title="Older records load in the background, newest first">
                  <span className="fill__bar" aria-hidden><i style={{ transform: `scaleX(${fill.pct})` }} /></span>
                  {throttled ? 'pacing · ' : 'loading · '}back to {utcDate(fill.coveredFrom)}
                </span>
              )}
              {fill?.done && throttled && <span className="fill mono" role="status">pacing requests</span>}
              <span className="mono clock">{utcTime(now)} UTC</span>
              <button type="button" className="btn" onClick={syncNow} disabled={syncing}>
                {syncing ? <><span className="spin-square" /> Syncing</> : syncMsg || 'Sync now'}
              </button>
              <ThemeToggle compact />
              <button type="button" className="btn btn--ghost nav__out" onClick={signOut} title={`Signed in as ${user.email}`}>
                <span className="nav__who mono" aria-hidden>{user.email[0].toUpperCase()}</span> Sign out
              </button>
            </div>
          </div>
        </header>
          </div>
          <section className={`hero hero--${section} on-dark`} aria-label={`${sec.label} header`}>
            <div className="hero__img" aria-hidden />
            <div className="hero__shade" aria-hidden />
            <div className="hero__nav-spacer" aria-hidden />
            <p className="hero__kicker mono" key={section}>
              <span>{sec.n}</span> {sec.label}
              <i aria-hidden /> api.telnyx.com/v2
            </p>
            <div className="hero__slot" ref={setSlot} />
            <a className="hero__credit mono" href="https://commons.wikimedia.org/wiki/File:Wikimedia_Foundation_Servers-8055_13.jpg"
              target="_blank" rel="noopener noreferrer" title="Photo by Victorgrigas, CC BY-SA 3.0, via Wikimedia Commons">
              Photo: Victorgrigas · CC BY-SA 3.0
            </a>
          </section>
        </div>

        <HeroSlotContext.Provider value={slot}>
          <main className="page" key={section} id="main" tabIndex={-1}>
            {/* A broken section shows the error inside the dashboard; nav keeps working. */}
            <ErrorBoundary
              resetKey={location.pathname}
              fallback={({ error, reset }) => (
                <ErrorPage kind={classify(error)} onRetry={reset} embedded />
              )}
            >
              <Outlet />
            </ErrorBoundary>
          </main>
        </HeroSlotContext.Provider>

        <footer className="dash-foot mono">
          <span>TLX/MON</span>
          <span>polling api.telnyx.com/v2</span>
          <span>all times UTC</span>
        </footer>
      </div>
    </LiveContext.Provider>
  );
}
