/**
 * Error classification and helpers shared by the error boundary and page.
 * Kept free of heavy imports: this module ships in the entry bundle so it
 * still works when lazily loaded chunks fail to download.
 */

const CHUNK_RE = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|ChunkLoadError|Loading (CSS )?chunk [\w-]+ failed|Unable to preload CSS/i;

export const isChunkError = (e) => !!e && (e.name === 'ChunkLoadError' || CHUNK_RE.test(String(e.message ?? e)));

/** 'chunk' (stale deploy) | 'offline' (no network) | 'crash' (render bug) */
export function classify(error) {
  if (isChunkError(error)) return typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'chunk';
  return 'crash';
}

/** Short human reference such as "7F3A-21C9", quoted when reporting a problem. */
export function makeRef() {
  const b = new Uint8Array(4);
  try { crypto.getRandomValues(b); } catch { for (let i = 0; i < 4; i++) b[i] = Math.random() * 256; }
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4)}`;
}

const ROUTES = [
  { to: '/dashboard', label: 'Billing overview' },
  { to: '/dashboard/ai', label: 'Conversational AI' },
  { to: '/dashboard/reports', label: 'Monthly statements' },
  { to: '/login', label: 'Sign in' },
];

function lev(a, b) {
  if (a === b) return 0;
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

/**
 * Closest real route for a mistyped path ("/dashbord", "/reprots",
 * "/reports/2026-9"), or null when nothing is plausibly meant.
 */
export function suggestRoute(pathname) {
  const p = (pathname || '/').toLowerCase().replace(/\/+$/, '') || '/';

  const month = p.match(/(\d{4})[-/_.](\d{1,2})(?!\d)/);
  if (month && /rep|stat|month/.test(p)) {
    const mm = Number(month[2]);
    if (mm >= 1 && mm <= 12) {
      const key = `${month[1]}-${String(mm).padStart(2, '0')}`;
      return { to: `/dashboard/reports/${key}`, label: `Statement ${key}` };
    }
    return { to: '/dashboard/reports', label: 'Monthly statements' };
  }

  const seg = p.split('/').filter(Boolean).pop() || '';
  let best = null;
  for (const r of ROUTES) {
    const tseg = r.to.split('/').filter(Boolean).pop();
    // Last-segment match ("/reprots" → reports) only when the typo is small for that word.
    const segD = seg && tseg ? lev(seg, tseg) : Infinity;
    const segScore = segD <= Math.max(1, Math.floor(tseg.length / 3)) ? segD + 0.5 : Infinity;
    // Whole-path match, with the same tolerance scaled to the target word.
    const full = lev(p, r.to);
    const fullScore = full <= Math.max(2, Math.floor(tseg.length / 2)) ? full : Infinity;
    const score = Math.min(fullScore, segScore);
    if (!best || score < best.score) best = { ...r, score };
  }
  return best && Number.isFinite(best.score) && best.to !== p ? { to: best.to, label: best.label } : null;
}
