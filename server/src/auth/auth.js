import crypto from 'node:crypto';
import express from 'express';
import { TokenBucketLimiter } from '../dsa/TokenBucket.js';

/**
 * Team authentication.
 *
 * - Any email address on the configured domain (default @courserev.ai)
 *   plus one shared password, stored as a scrypt hash in the environment.
 *   There is no signup or user-creation endpoint.
 * - Each session is tied to the email that signed in, for audit logs.
 * - Server-side sessions: the cookie carries only a random 256-bit id;
 *   session state lives in memory with a sliding expiry.
 * - Cookie is HttpOnly + SameSite=Strict (+ Secure behind HTTPS), and
 *   state-changing requests must come from our own origin (CSRF).
 * - Login is rate limited per IP; the email and password comparisons are
 *   constant-time, and a wrong email still pays for a full scrypt, so
 *   response timing doesn't reveal whether the email exists.
 */
const COOKIE = 'tlx_session';
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password, salt = crypto.randomBytes(16)) {
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [alg, n, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: SCRYPT.r, p: SCRYPT.p });
  return crypto.timingSafeEqual(key, expected);
}

/** Exactly `local@domain`: no sub-domains, no look-alikes such as courserev.ai.evil.com. */
export function isAllowedEmail(email, domain) {
  const e = String(email ?? '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  return at > 0 && e.indexOf('@') === at && e.slice(at + 1) === domain && /^[a-z0-9._%+-]+$/.test(e.slice(0, at));
}

export class SessionStore {
  constructor({ ttlMs, max = 200 }) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.sessions = new Map();
  }

  create(email) {
    if (this.sessions.size >= this.max) this.sweep(true);
    const id = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.sessions.set(id, { email, createdAt: now, expiresAt: now + this.ttlMs });
    return id;
  }

  get(id) {
    const s = id && this.sessions.get(id);
    if (!s) return null;
    if (s.expiresAt <= Date.now()) { this.sessions.delete(id); return null; }
    s.expiresAt = Date.now() + this.ttlMs; // sliding expiry
    return s;
  }

  destroy(id) { this.sessions.delete(id); }

  sweep(evictOldest = false) {
    const now = Date.now();
    for (const [id, s] of this.sessions) if (s.expiresAt <= now) this.sessions.delete(id);
    if (evictOldest && this.sessions.size >= this.max) this.sessions.delete(this.sessions.keys().next().value);
  }
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function createAuth({ config, logger }) {
  const { emailDomain, passwordHash, sessionTtlMs, secureCookie, allowedOrigins } = config.auth;
  const trusted = new Set(allowedOrigins.map((o) => o.replace(/\/$/, '').toLowerCase()));
  const sessions = new SessionStore({ ttlMs: sessionTtlMs });
  const attempts = new TokenBucketLimiter({ capacity: 5, refillPerSec: 1 / 12 }); // 5 tries, then 1 per 12s

  const cookie = (value, maxAgeS) => [
    `${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeS}`, secureCookie ? 'Secure' : null,
  ].filter(Boolean).join('; ');

  /** Reject cross-site state-changing requests (defence in depth on top of SameSite). */
  function sameOrigin(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const origin = req.get('origin');
    if (!origin) return next(); // same-origin form posts / non-browser clients
    let host = null;
    try { host = new URL(origin).host; } catch { /* malformed origin */ }
    // Same origin if the browser's Origin matches the Host it sent us, or
    // the Host a trusted local proxy forwarded, or an explicitly allowed origin.
    const forwarded = req.ip && /^(::1|127\.|::ffff:127\.)/.test(req.ip) ? req.get('x-forwarded-host') : null;
    if (host && (host === req.get('host') || host === forwarded || trusted.has(origin.toLowerCase()))) return next();
    logger.warn('cross-origin request blocked', { origin, host: req.get('host'), path: req.originalUrl });
    return res.status(403).json({ error: 'cross-origin request blocked', origin });
  }

  const PUBLIC = new Set(['/health', '/ready', '/auth/login', '/auth/me', '/auth/logout']);

  function requireAuth(req, res, next) {
    if (PUBLIC.has(req.path)) return next();
    const session = sessions.get(readCookie(req, COOKIE));
    if (!session) return res.status(401).json({ error: 'unauthorized' });
    req.user = { email: session.email };
    return next();
  }

  const router = express.Router();

  router.post('/auth/login', express.json({ limit: '2kb' }), async (req, res) => {
    const ip = req.ip || 'unknown';
    const gate = attempts.take(ip);
    if (!gate.ok) {
      res.set('retry-after', String(Math.ceil(gate.retryAfterMs / 1000)));
      return res.status(429).json({ error: 'Too many attempts. Try again shortly.', retryAfterMs: gate.retryAfterMs });
    }
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string' || email.length > 254 || password.length > 256) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    const who = email.trim().toLowerCase();
    // The domain is public, so saying it's wrong leaks nothing.
    if (!isAllowedEmail(who, emailDomain)) {
      logger.warn('login rejected: email domain', { ip });
      return res.status(400).json({ error: `Use your @${emailDomain} email address.`, reason: 'domain' });
    }
    if (!verifyPassword(password, passwordHash)) {
      logger.warn('login failed', { ip, email: who });
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 200));
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    const id = sessions.create(who);
    res.set('set-cookie', cookie(id, Math.floor(sessionTtlMs / 1000)));
    res.set('cache-control', 'no-store');
    logger.info('login ok', { ip, email: who });
    return res.json({ email: who });
  });

  router.get('/auth/me', (req, res) => {
    const s = sessions.get(readCookie(req, COOKIE));
    res.set('cache-control', 'no-store');
    // "Not signed in" is a normal answer here, not an error: 200 either way.
    if (!s) return res.json({ authenticated: false, emailDomain });
    return res.json({ authenticated: true, email: s.email, expiresAt: s.expiresAt });
  });

  router.post('/auth/logout', (req, res) => {
    sessions.destroy(readCookie(req, COOKIE));
    res.set('set-cookie', cookie('', 0));
    res.json({ ok: true });
  });

  return { router, requireAuth, sameOrigin, sessions, attempts };
}
