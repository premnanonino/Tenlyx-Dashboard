import { useEffect, useRef, useState } from 'react';

/**
 * Full-screen boot sequence shown while the 3D scene builds its geometry.
 * The displayed number chases the real progress so it never jumps, and the
 * panel lifts away only after both the counter and the scene are done.
 */
export default function BootLoader({ progress, lines, onDone }) {
  const [shown, setShown] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const target = useRef(progress);
  target.current = progress;

  useEffect(() => {
    let raf;
    let last = performance.now();
    const step = (now) => {
      const dt = (now - last) / 1000;
      last = now;
      setShown((s) => {
        const next = Math.min(target.current, s + Math.max(28, (target.current - s) * 6) * dt);
        return next;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (shown >= 100 && !leaving) {
      const id = setTimeout(() => { setLeaving(true); setTimeout(onDone, 750); }, 250);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [shown, leaving, onDone]);

  const n = Math.floor(shown);
  return (
    <div className={`boot ${leaving ? 'boot--leaving' : ''}`} role="status" aria-live="polite" aria-label={`Loading ${n}%`}>
      <div className="boot__top">
        <span className="mark mark--dark">TLX/MON</span>
        <span className="boot__meta">BOOT SEQUENCE · BILLING TELEMETRY</span>
      </div>

      <ol className="boot__log">
        {lines.map((l, i) => (
          <li key={`${i}-${l}`} style={{ animationDelay: `${i * 30}ms` }}>
            <span className="boot__ok">OK</span> {l}
          </li>
        ))}
        <li className="boot__cursor" aria-hidden>_</li>
      </ol>

      <div className="boot__bottom">
        <div className="boot__count">
          {String(n).padStart(3, '0')}
          <span>%</span>
        </div>
        <div className="boot__bar"><i style={{ transform: `scaleX(${shown / 100})` }} /></div>
        <div className="boot__ticks" aria-hidden>
          {Array.from({ length: 40 }, (_, i) => <b key={i} className={i / 40 < shown / 100 ? 'on' : ''} />)}
        </div>
      </div>
    </div>
  );
}
