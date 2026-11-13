import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  animateThemeChange, getThemeAnimation, setThemeAnimation, THEME_ANIMATIONS,
} from './themeFx.js';

export { THEME_ANIMATIONS, getThemeAnimation };

const KEY = 'tlx-theme';
const mq = () => window.matchMedia('(prefers-color-scheme: dark)');

export function getStoredTheme() {
  try { return localStorage.getItem(KEY) || 'system'; } catch { return 'system'; }
}

/** 'light' | 'dark' sets data-theme; 'system' removes it and follows the OS. */
export function applyTheme(theme) {
  const el = document.documentElement;
  if (theme === 'system') el.removeAttribute('data-theme');
  else el.dataset.theme = theme;
}

const subscribeOs = (cb) => { const m = mq(); m.addEventListener('change', cb); return () => m.removeEventListener('change', cb); };

export function useTheme() {
  const [theme, setTheme] = useState(getStoredTheme);
  const osDark = useSyncExternalStore(subscribeOs, () => mq().matches);
  useEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem(KEY, theme); } catch { /* private mode: fine */ }
  }, [theme]);
  const resolved = theme === 'system' ? (osDark ? 'dark' : 'light') : theme;
  const toggle = (origin, style) => {
    const next = resolved === 'dark' ? 'light' : 'dark';
    animateThemeChange(next, () => { setTheme(next); applyTheme(next); }, origin, style);
  };
  return { theme, resolved, setTheme, toggle };
}

const SunIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <circle cx="12" cy="12" r="4.2" fill="currentColor" stroke="none" />
    <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" />
  </svg>
);
const MoonIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1z" />
  </svg>
);

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function ThemeToggle({ compact = false }) {
  const { resolved, toggle } = useTheme();
  const next = resolved === 'dark' ? 'light' : 'dark';
  const body = useRef(null);
  const [styleName, setStyleName] = useState(getThemeAnimation);

  const onClick = (e) => {
    // Option/Alt-click: move on to the next page effect (remembered).
    let style;
    if (e.altKey) {
      const i = THEME_ANIMATIONS.indexOf(getThemeAnimation());
      style = THEME_ANIMATIONS[(i + 1) % THEME_ANIMATIONS.length];
      setThemeAnimation(style);
      setStyleName(style);
    }
    if (!reducedMotion()) {
      // The block stretches along its path, then settles.
      body.current?.animate([
        { transform: 'scale(1, 1)' },
        { transform: 'scale(1.35, 0.88)', offset: 0.3 },
        { transform: 'scale(0.92, 1.04)', offset: 0.6 },
        { transform: 'scale(1, 1)' },
      ], { duration: 650, easing: 'cubic-bezier(0.3, 0.6, 0.3, 1)' });
    }
    toggle(e, style);
  };

  const label = resolved === 'dark' ? 'Dark' : 'Light';
  return (
    <button
      type="button"
      className={`theme-toggle${compact ? ' theme-toggle--compact' : ''}`}
      data-mode={resolved}
      onClick={onClick}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme · effect: ${next === 'light' ? 'sunrise' : styleName} (⌥-click for next)`}
    >
      <span className="lg-track" aria-hidden>
        <span className="lg-label">
          <span>
            {[...label].map((ch, i) => (
              <span key={`${resolved}${i}`} style={{ animationDelay: `${120 + i * 40}ms` }}>{ch}</span>
            ))}
          </span>
        </span>
      </span>
      <span className="lg-knob" aria-hidden>
        <span className="lg-knob__press">
          <span className="lg-knob__body" ref={body}>
            <span className="lg-glass" />
            <span className="lg-icon lg-icon--sun"><SunIcon /></span>
            <span className="lg-icon lg-icon--moon"><MoonIcon /></span>
          </span>
        </span>
      </span>
    </button>
  );
}
