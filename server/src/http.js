import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { buildRouter } from './api/routes.js';
import { requestContext, rateLimit, notFound, errorHandler, securityHeaders, compressJson } from './api/middleware.js';

/** The Express app shared by the standalone (dev) and api (production) roles. */
export function createHttpApp({ config, log, auth, limiter, routerCtx }) {
  const app = express();
  app.disable('x-powered-by');
  // Behind Caddy, X-Forwarded-For carries the client IP (login rate limiting is per IP).
  app.set('trust proxy', config.trustProxy);
  app.use(securityHeaders({ hsts: config.auth.secureCookie }));
  app.use(requestContext(log.child('http')));
  app.use('/api', compressJson(), auth.sameOrigin, rateLimit(limiter), auth.router, auth.requireAuth, buildRouter(routerCtx));

  // Serve the built frontend when present (single-process production deploy).
  const dist = path.resolve(config.serverRoot, '..', 'client', 'dist');
  if (fs.existsSync(dist)) {
    // Hashed build files never change: cache for a year. Everything else
    // (index.html) is revalidated, so a deploy is picked up immediately.
    app.use(express.static(dist, {
      index: false,
      setHeaders: (res, file) => res.set('cache-control', file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache'),
    }));
    // Client routes get the SPA shell with 200; anything else still gets the
    // shell (it renders the 404 page) but with a real 404 status for crawlers,
    // monitors and logs.
    const CLIENT_ROUTE = /^\/(?:login|dashboard(?:\/(?:ai|calls|reports(?:\/\d{4}-\d{2})?))?)?\/?$/;
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
      res.status(CLIENT_ROUTE.test(req.path) ? 200 : 404).sendFile(path.join(dist, 'index.html'));
    });
  }
  app.use(notFound);
  app.use(errorHandler(log));
  return app;
}

export function listen(app, { config, log, onListening }) {
  const server = app.listen(config.port, onListening);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log.error('port already in use', {
        port: config.port,
        fix: 'the server is probably already running (root `npm run dev` starts it). Stop the other copy, or set PORT=<other port>.',
      });
      process.exit(1);
    }
    throw err;
  });
  return server;
}

/** Fail closed: never serve billing data without a configured login. */
export function requireLoginConfig(config, log) {
  if (!config.auth.emailDomain || !config.auth.passwordHash.startsWith('scrypt$')) {
    log.error('login not configured', { fix: 'run: npm --prefix server run set-password (or set SHARED_PASSWORD_HASH / SHARED_PASSWORD_HASH_FILE)' });
    process.exit(1);
  }
}

/** Fail closed: there is no demo mode; without a key there is nothing to sync. */
export function requireTelnyxKey(config, log) {
  if (!config.telnyx.apiKey) {
    log.error('TELNYX_API_KEY not set', { fix: 'set TELNYX_API_KEY or TELNYX_API_KEY_FILE (Mission Control → Auth → API Keys)' });
    process.exit(1);
  }
}

export function onShutdown(fn, log) {
  let done = false;
  const handler = (signal) => {
    if (done) return;
    done = true;
    log.info('shutting down', { signal });
    Promise.resolve(fn()).finally(() => process.exit(0));
    setTimeout(() => process.exit(1), 8_000).unref();
  };
  process.on('SIGINT', () => handler('SIGINT'));
  process.on('SIGTERM', () => handler('SIGTERM'));
}
