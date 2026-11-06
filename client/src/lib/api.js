import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

/* Global in-flight counter → drives the top progress bar. */
let inflight = 0;
const subs = new Set();
const notify = () => subs.forEach((f) => f());
export const useInflight = () =>
  useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => inflight);

export async function api(path, { method = 'GET', body, signal } = {}) {
  inflight++; notify();
  try {
    const res = await fetch(`/api${path}`, {
      method,
      signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    // Session gone or never existed: tell the app shell to go to /login.
    if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new CustomEvent('tlx:unauthorized'));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
    return data;
  } finally {
    inflight--; notify();
  }
}

/**
 * Fetch hook that keeps the previous data while refetching
 * (so panels show a loader overlay, not an empty flash).
 */
export function useResource(path, refreshKey = 0) {
  const [state, setState] = useState({ data: null, error: null, loading: true, path: null });
  const ctrl = useRef(null);

  const load = useCallback(() => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setState((s) => ({ ...s, loading: true }));
    api(path, { signal: c.signal })
      .then((data) => { if (!c.signal.aborted) setState({ data, error: null, loading: false, path }); })
      .catch((error) => { if (!c.signal.aborted) setState((s) => ({ ...s, error, loading: false })); });
  }, [path]);

  useEffect(() => { load(); return () => ctrl.current?.abort(); }, [load, refreshKey]);

  return {
    ...state,
    reload: load,
    initial: state.loading && !state.data,
    // true only when the *query* changed (e.g. new range), not on live refreshes
    switching: state.loading && !!state.data && state.path !== path,
  };
}
