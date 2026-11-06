const moneyFmt = new Map();

export function money(v, currency = 'USD', digits = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const key = `${currency}:${digits}`;
  if (!moneyFmt.has(key)) {
    moneyFmt.set(key, new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }));
  }
  return moneyFmt.get(key).format(v);
}

/** Small amounts keep precision: $0.0042 instead of $0.00. */
export function moneySmart(v, currency = 'USD') {
  if (v === null || v === undefined) return '—';
  const a = Math.abs(v);
  return money(v, currency, a > 0 && a < 0.1 ? 4 : 2);
}

export const num = (v, d = 0) =>
  v === null || v === undefined ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

export const pct = (v, d = 1) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(d)}%`);

export function signedPct(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}%`;
}

export function utcTime(ts, withSeconds = true) {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}${withSeconds ? `:${p(d.getUTCSeconds())}` : ''}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const utcDate = (ts) => { const d = new Date(ts); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; };
export const utcDay = (ts) => DAYS[new Date(ts).getUTCDay()];

export function ago(ts, now = Date.now()) {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Colours are CSS variables so every chart follows the light/dark theme.
const KNOWN = new Set(['messaging', 'voice', 'verify', 'numbers', 'sip', 'ai']);
export const productColor = (p, i = 0) => (KNOWN.has(p) ? `var(--p-${p})` : `var(--m-${6 + (i % 2)})`);

export const PRODUCT_LABELS = { messaging: 'Messaging', voice: 'Voice', verify: 'Verify', numbers: 'Numbers', sip: 'SIP trunking', ai: 'Conversational AI' };
export const productLabel = (p) => PRODUCT_LABELS[p] || p;

/** Round an axis maximum up to a 1/2/2.5/5 × 10^n step. */
export function niceMax(v, ticks = 4) {
  if (!v || v <= 0) return { max: 1, step: 0.25 };
  const raw = v / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  return { max: step * ticks, step };
}

/* ---- AI models --------------------------------------------------------- */
/** Stable colour per model, assigned by rank within the current dataset. */
export function modelColors(models) {
  const map = new Map(models.map((m, i) => [m, `var(--m-${i % 8})`]));
  return (m) => (m === 'other' ? 'var(--m-other)' : map.get(m) || 'var(--muted)');
}

/** 'openai/gpt-4o-mini' -> { vendor: 'openai', name: 'gpt-4o-mini' } */
export function splitModel(model = '') {
  const i = model.lastIndexOf('/');
  return i < 0 ? { vendor: '', name: model } : { vendor: model.slice(0, i), name: model.slice(i + 1) };
}
export const shortModel = (m) => (m === 'other' ? 'Other' : splitModel(m).name.replace(/-Instruct$/, ''));

export function ms(v) {
  if (v === null || v === undefined) return '—';
  return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
}

export function duration(sec) {
  if (sec === null || sec === undefined) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

export function compact(v) {
  if (v === null || v === undefined) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)}K`;
  return num(v);
}

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function monthName(key) {
  const [y, m] = key.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}
