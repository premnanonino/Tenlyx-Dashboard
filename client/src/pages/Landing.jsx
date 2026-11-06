import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { GlobeScene } from '../three/GlobeScene.js';
import BootLoader from '../components/BootLoader.jsx';
import { api } from '../lib/api.js';
import { money, num, utcTime } from '../lib/format.js';
import { useNow } from '../lib/hooks.js';
import '../styles/landing.css';

const prefetchDashboard = () => import('./Dashboard.jsx');

function Coord({ value, pos, neg }) {
  if (value === null || value === undefined) return <span className="dim">——.——</span>;
  return <span>{Math.abs(value).toFixed(2).padStart(6, '0')}° {value >= 0 ? pos : neg}</span>;
}

export default function Landing() {
  const canvasRef = useRef(null);
  const sceneRef = useRef(null);
  const navigate = useNavigate();
  const now = useNow(1000);

  const [progress, setProgress] = useState(0);
  const [lines, setLines] = useState([]);
  const [booted, setBooted] = useState(false);
  const [webglError, setWebglError] = useState(null);
  const [leaving, setLeaving] = useState(false);
  const [coords, setCoords] = useState(null);
  const [stats, setStats] = useState(null);

  useEffect(() => {
    const scene = new GlobeScene(canvasRef.current, {
      onProgress: (p, msg) => {
        setProgress(p);
        if (msg) setLines((l) => [...l, msg].slice(-9));
      },
      onPointer: (c) => setCoords(c),
    });
    sceneRef.current = scene;
    scene.init()
      .then(() => { if (!scene.disposed) scene.start(); })
      .catch((e) => { setWebglError(e.message || 'WebGL unavailable'); setProgress(100); });
    return () => scene.dispose();
  }, []);

  useEffect(() => {
    api('/auth/me')
      .then((me) => (me.authenticated ? api('/overview').then(setStats) : setStats({ error: true, locked: true })))
      .catch(() => setStats({ error: true }));
  }, []);

  const finishBoot = useCallback(() => setBooted(true), []);

  const enter = async () => {
    if (leaving) return;
    setLeaving(true);
    prefetchDashboard();
    try { await sceneRef.current?.diveIn(); } catch { /* scene gone */ }
    navigate(stats?.locked ? '/login?next=/dashboard' : '/dashboard');
  };

  const cur = stats?.currency || 'USD';
  const ready = stats && !stats.error;

  return (
    <main className={`landing ${booted ? 'is-booted' : ''} ${leaving ? 'is-leaving' : ''}`}>
      <canvas ref={canvasRef} className="landing__canvas" aria-label="Interactive 3D network globe. Drag to rotate." />

      <header className="lp-top">
        <span className="mark mark--dark">TLX/MON</span>
        <nav className="lp-top__nav">
          <span>Billing telemetry for Telnyx</span>
          <span className="lp-top__sep" />
          <span className="mono">{utcTime(now)} UTC</span>
        </nav>
      </header>

      <section className="lp-copy">
        <p className="lp-kicker"><span className="lp-index">01</span> Account monitor</p>
        <h1 className="lp-title">
          <span className="line"><span>Billing</span></span>
          <span className="line"><span>monitor<em>.</em></span></span>
        </h1>
        <p className="lp-lede">
          Balance, burn rate and per-number spend from your Telnyx account.
          Polled continuously, indexed in memory, pushed to your screen live.
        </p>

        <button type="button" className="cta" onClick={enter} onMouseEnter={prefetchDashboard} disabled={leaving}>
          <span className="cta__fill" aria-hidden />
          <span className="cta__label">Click here</span>
          <span className="cta__sub">{leaving ? 'opening…' : 'open dashboard'}</span>
          <span className="cta__arrow" aria-hidden>→</span>
        </button>

        <dl className="lp-readout">
          <div>
            <dt>Balance</dt>
            <dd className={ready || stats?.locked ? '' : 'loading-dash'}>{ready ? money(stats.balance, cur) : '———'}</dd>
          </div>
          <div>
            <dt>Spend · 24h</dt>
            <dd className={ready || stats?.locked ? '' : 'loading-dash'}>{ready ? money(stats.spend24h, cur) : '———'}</dd>
          </div>
          <div>
            <dt>Runway</dt>
            <dd className={ready || stats?.locked ? '' : 'loading-dash'}>{ready ? (stats.runwayDays ? `${num(stats.runwayDays, 1)} d` : '∞') : '———'}</dd>
          </div>
        </dl>
        <p className="lp-source mono">
          {stats?.locked ? 'sign in to see live figures' : stats?.error ? 'backend offline — start the server on :8787' : ready ? 'source: api.telnyx.com/v2' : 'contacting backend…'}
        </p>
      </section>

      <footer className="lp-bottom mono">
        <div className="lp-coords">
          <span>LAT <Coord value={coords?.lat} pos="N" neg="S" /></span>
          <span>LON <Coord value={coords?.lon} pos="E" neg="W" /></span>
          <span className="dim">drag to rotate</span>
        </div>
        <ul className="lp-legend">
          <li><i className="sw sw--land" /> node</li>
          <li><i className="sw sw--arc" /> live route</li>
          <li><i className="sw sw--sat" /> poller</li>
        </ul>
      </footer>

      {webglError && (
        <div className="lp-fallback mono">3D view unavailable ({webglError}). The dashboard still works.</div>
      )}

      <div className="wipe" aria-hidden />
      {!booted && <BootLoader progress={progress} lines={lines} onDone={finishBoot} />}
    </main>
  );
}
