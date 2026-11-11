import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';

export function requestContext(logger) {
  return (req, res, next) => {
    req.id = req.get('x-request-id') || randomUUID();
    res.set('x-request-id', req.id);
    const t0 = performance.now();
    res.on('finish', () => {
      logger.debug('http', { id: req.id, method: req.method, path: req.originalUrl, status: res.statusCode, ms: Math.round(performance.now() - t0) });
    });
    next();
  };
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  // Call recordings (Call History page) are streamed from CourseRev's CDNs.
  "media-src 'self' https://cdn.v2.courserev.ai https://cdn.courserev.ai https://*.r2.cloudflarestorage.com",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Baseline browser hardening for every response (no extra dependency). */
export function securityHeaders({ hsts = false } = {}) {
  return (req, res, next) => {
    res.set({
      'content-security-policy': CSP,
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cross-origin-opener-policy': 'same-origin',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    });
    if (hsts) res.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
    // Billing data must not be kept by browser or proxy caches.
    if (req.path.startsWith('/api')) res.set('cache-control', 'no-store');
    next();
  };
}

/**
 * Gzip JSON responses of 1 KB or more when the client accepts it (all
 * browsers do). No dependency: Node's zlib. JSON compresses ~5-10x, so a
 * 25 KB filter list becomes ~3 KB. Streams (SSE) are untouched: they don't
 * use res.json().
 */
export function compressJson({ threshold = 1024, level = 6 } = {}) {
  return (req, res, next) => {
    if (!/\bgzip\b/.test(req.headers['accept-encoding'] || '')) return next();
    const json = res.json.bind(res);
    res.json = (body) => {
      const str = JSON.stringify(body);
      if (str === undefined || str.length < threshold) return json(body);
      res.vary('Accept-Encoding');
      res.set({ 'content-type': 'application/json; charset=utf-8', 'content-encoding': 'gzip' });
      return res.send(zlib.gzipSync(str, { level }));
    };
    return next();
  };
}

/** Per-client token bucket. Expensive endpoints can charge more tokens. */
export function rateLimit(limiter, cost = 1) {
  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const r = limiter.take(key, cost);
    res.set('x-ratelimit-remaining', String(r.remaining));
    if (r.ok) return next();
    res.set('retry-after', String(Math.ceil(r.retryAfterMs / 1000)));
    res.status(429).json({ error: 'rate_limited', retryAfterMs: r.retryAfterMs });
  };
}

/**
 * Read-through response cache. The key includes the store version, so any
 * write to the store makes old entries unreachable (they age out via LRU).
 */
export function cached(cache, store) {
  return (compute) => (req, res, next) => {
    const key = `${req.path}?${new URLSearchParams(req.query)}|v${store.version}`;
    const hit = cache.get(key);
    if (hit !== undefined) { res.set('x-cache', 'HIT'); return res.json(hit); }
    try {
      const value = compute(req);
      cache.set(key, value);
      res.set('x-cache', 'MISS');
      res.json(value);
    } catch (err) {
      next(err);
    }
  };
}

export function notFound(req, res) {
  res.status(404).json({ error: 'not_found', path: req.originalUrl });
}

export function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    const status = err.status && err.status < 500 ? err.status : 500;
    if (status >= 500) logger.error('unhandled', { id: req.id, err: err.message, stack: err.stack });
    res.status(status).json({ error: status >= 500 ? 'internal_error' : err.message, requestId: req.id });
  };
}
