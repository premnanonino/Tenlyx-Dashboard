import { useEffect, useRef, useState } from 'react';

/**
 * Subscribes to the backend's Server-Sent Events stream.
 * EventSource reconnects on its own (server sends `retry: 3000`).
 * `tick` increments at most once per `throttleMs` when data changes,
 * which panels use as a refetch key.
 */
export function useStream({ throttleMs = 2500, onRecords, onAlert } = {}) {
  const [status, setStatus] = useState('connecting');
  const [lastEventAt, setLastEventAt] = useState(null);
  const [tick, setTick] = useState(0);
  const [mode, setMode] = useState(null);
  const handlers = useRef({ onRecords, onAlert });
  handlers.current = { onRecords, onAlert };

  useEffect(() => {
    const es = new EventSource('/api/stream');
    let lastBump = 0;
    let pending = null;
    const bump = () => {
      const now = Date.now();
      setLastEventAt(now);
      const wait = lastBump + throttleMs - now;
      if (wait <= 0) { lastBump = now; setTick((x) => x + 1); return; }
      if (!pending) pending = setTimeout(() => { pending = null; lastBump = Date.now(); setTick((x) => x + 1); }, wait);
    };

    es.onopen = () => setStatus('live');
    es.onerror = () => setStatus(es.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting');
    es.addEventListener('hello', (e) => { setStatus('live'); setMode(JSON.parse(e.data).mode); });
    es.addEventListener('balance', bump);
    es.addEventListener('records', (e) => { bump(); handlers.current.onRecords?.(JSON.parse(e.data)); });
    es.addEventListener('alert', (e) => { bump(); handlers.current.onAlert?.(JSON.parse(e.data)); });
    es.addEventListener('breaker', bump);

    return () => { clearTimeout(pending); es.close(); };
  }, [throttleMs]);

  return { status, lastEventAt, tick, mode };
}
