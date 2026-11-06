import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const prefersReduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Animate a number from its previous value to `target` (ease-out cubic). */
export function useTween(target, duration = 900) {
  const [value, setValue] = useState(target ?? 0);
  const from = useRef(target ?? 0);
  const current = useRef(target ?? 0);

  useEffect(() => {
    if (target === null || target === undefined) return undefined;
    if (prefersReduced()) { setValue(target); current.current = target; return undefined; }
    from.current = current.current;
    const t0 = performance.now();
    let raf;
    const step = (now) => {
      const k = Math.min(1, (now - t0) / duration);
      const e = 1 - (1 - k) ** 3;
      const v = from.current + (target - from.current) * e;
      current.current = v;
      setValue(v);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);

  return value;
}

/** True for `ms` after `value` changes (not on first render). */
export function useFlash(value, ms = 900) {
  const [on, setOn] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return undefined; }
    setOn(true);
    const id = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return on;
}

/** Element width via ResizeObserver (for crisp, responsive SVG). */
export function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

export function useNow(every = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(id);
  }, [every]);
  return now;
}

export function useDebounced(value, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/**
 * Lazy-load trigger. Returns [ref, seen, visible]: `seen` flips true the
 * first time the element comes within `margin` of the viewport and stays
 * true; `visible` tracks it live (for pausing polling off-screen).
 */
export function useInView(margin = '300px') {
  const [el, setEl] = useState(null);
  const [seen, setSeen] = useState(false);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!el) return undefined;
    if (typeof IntersectionObserver === 'undefined') { setSeen(true); setVisible(true); return undefined; }
    const io = new IntersectionObserver(([e]) => {
      setVisible(e.isIntersecting);
      if (e.isIntersecting) setSeen(true);
    }, { rootMargin: `${margin} 0px` });
    io.observe(el);
    return () => io.disconnect();
  }, [el, margin]);
  return [setEl, seen, visible];
}
