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
