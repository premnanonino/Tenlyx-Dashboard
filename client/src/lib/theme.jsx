import { useEffect, useState, useSyncExternalStore } from 'react';

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
  return { theme, resolved, setTheme, toggle: () => setTheme(resolved === 'dark' ? 'light' : 'dark') };
}

export function ThemeToggle({ compact = false }) {
  const { resolved, toggle } = useTheme();
  const next = resolved === 'dark' ? 'light' : 'dark';
  return (
    <button type="button" className="theme-toggle" onClick={toggle} aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`}>
      <span className="theme-toggle__icon" aria-hidden />
      {!compact && <span>{resolved === 'dark' ? 'Dark' : 'Light'}</span>}
    </button>
  );
}
