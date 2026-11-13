/**
 * The single place that picks the database backend (DATABASE_BACKEND).
 * Each backend is imported lazily, so a PostgreSQL deployment never loads
 * libSQL and vice versa. Both return the same shape:
 *
 *   repo            PgRepo | LibsqlRepo (same methods)
 *   automation      PgAutomationRepo | LibsqlAutomationRepo (Call Automation; same methods)
 *   sessionStore()  PgSessionStore | LibsqlSessionStore
 *   workerLock()    null if another worker holds it, else { release(), renew(), renewEveryMs }
 *                   (renewEveryMs is null for PostgreSQL: its advisory lock needs no renewal)
 *   close()
 */
const WORKER_LOCK = 727_002;          // PostgreSQL advisory-lock key (unchanged)
const WORKER_LEASE_TTL_MS = 60_000;   // libSQL lease: expires a minute after the holder dies

export async function openDatabase(config, { logger } = {}) {
  const database = config.database;
  if (!database) {
    throw new Error('no database configured: set DATABASE_URL / PG* for PostgreSQL, or DATABASE_BACKEND=libsql with LIBSQL_URL or TURSO_DATABASE_URL');
  }

  if (database.backend === 'libsql') {
    const { connect, migrate, acquireLease } = await import('./libsql.js');
    const { LibsqlRepo } = await import('../persistence/libsqlRepo.js');
    const { LibsqlAutomationRepo } = await import('../persistence/libsqlAutomationRepo.js');
    const { LibsqlSessionStore, CachedSessionStore } = await import('../auth/auth.js');
    const client = await connect(database, { logger });
    await migrate(client);
    return {
      backend: 'libsql',
      repo: new LibsqlRepo({ client, logger: logger?.child?.('db') }),
      automation: new LibsqlAutomationRepo({ client, logger: logger?.child?.('automation') }),
      sessionStore: (ttlMs) => new CachedSessionStore(new LibsqlSessionStore({ client, ttlMs })),
      workerLock: () => acquireLease(client, 'worker', { ttlMs: WORKER_LEASE_TTL_MS, logger }),
      close: async () => client.close(),
    };
  }

  const { connect, migrate, acquireSingleton } = await import('./pg.js');
  const { PgRepo } = await import('../persistence/pgRepo.js');
  const { PgAutomationRepo } = await import('../persistence/pgAutomationRepo.js');
  const { PgSessionStore, CachedSessionStore } = await import('../auth/auth.js');
  const pool = await connect(config.db, { logger });
  await migrate(pool);
  return {
    backend: 'postgres',
    repo: new PgRepo({ pool, logger: logger?.child?.('db') }),
    automation: new PgAutomationRepo({ pool, logger: logger?.child?.('automation') }),
    sessionStore: (ttlMs) => new CachedSessionStore(new PgSessionStore({ pool, ttlMs })),
    workerLock: async () => {
      const client = await acquireSingleton(pool, WORKER_LOCK);
      return client ? { release: () => client.release(), renew: async () => true, renewEveryMs: null } : null;
    },
    close: async () => pool.end(),
  };
}
