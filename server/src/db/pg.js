import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const SCHEMA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');
const MIGRATE_LOCK = 727_001;

// bigint (seq, counts) as JS numbers: safe far beyond any realistic row count.
pg.types.setTypeParser(20, (v) => Number(v));

/** Connect, retrying while PostgreSQL is still starting (e.g. first `compose up`). */
export async function connect(dbConfig, { logger, attempts = 30 } = {}) {
  const pool = new pg.Pool({ ...dbConfig, application_name: `tlxmon-${process.env.APP_ROLE || 'all'}` });
  pool.on('error', (err) => logger?.error('postgres pool error', { err: err.message }));
  for (let i = 1; ; i++) {
    try {
      await pool.query('SELECT 1');
      return pool;
    } catch (err) {
      if (i >= attempts) throw err;
      logger?.warn('postgres not ready, retrying', { attempt: i, err: err.message });
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}

/** Apply schema.sql under an advisory lock so api and worker can start together. */
export async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATE_LOCK]);
    await client.query(fs.readFileSync(SCHEMA, 'utf8'));
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATE_LOCK]).catch(() => {});
    client.release();
  }
}

/**
 * Hold a session-level advisory lock for the life of the process, so only
 * one sync worker can ever run against a database (two would double the
 * Telnyx request rate). Returns false if another worker holds it.
 */
export async function acquireSingleton(pool, key) {
  const client = await pool.connect();
  const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [key]);
  if (!rows[0].ok) { client.release(); return null; }
  return client; // keep checked out: releasing it would drop the lock
}
