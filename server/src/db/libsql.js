import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';

const SCHEMA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sqlite.sql');

/** Current time in epoch ms, from the database clock (one clock for every process). */
export const NOW_MS = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";

const isFile = (url) => url.startsWith('file:');

/**
 * Open a libSQL client: a local SQLite file (`file:./data/tlxmon.db`) or a
 * remote Turso database (`libsql://…` + auth token). Retries while the
 * database is unreachable, like the PostgreSQL connect().
 */
export async function connect({ url, authToken }, { logger, attempts = 10 } = {}) {
  if (isFile(url)) {
    const file = url.slice('file:'.length).replace(/^\/\/(?=\/)/, '');
    if (file && !file.startsWith(':memory:')) fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const client = createClient({ url, authToken });
  for (let i = 1; ; i++) {
    try {
      if (isFile(url)) {
        // Local file shared by the api and worker processes: WAL lets readers
        // run during writes, busy_timeout waits for the other writer.
        await client.execute('PRAGMA journal_mode = WAL');
        await client.execute('PRAGMA busy_timeout = 5000');
      }
      await client.execute('SELECT 1');
      return client;
    } catch (err) {
      if (i >= attempts) { client.close(); throw err; }
      logger?.warn('libsql not reachable, retrying', { attempt: i, err: err.message });
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}

/** Apply schema.sqlite.sql. Every statement is IF NOT EXISTS, so concurrent starts are safe. */
export async function migrate(client) {
  await client.executeMultiple(fs.readFileSync(SCHEMA, 'utf8'));
}

/**
 * Worker lease: a row in kv replacing PostgreSQL's session advisory lock.
 *
 *   kv['lease:<name>'] = { holder, expiresAt }   (expiresAt on the database clock)
 *
 * - acquire: one atomic upsert that succeeds only if the row is absent, expired,
 *   or already ours, so two workers can never both hold it.
 * - renew:   extends it only while we still hold it and it has not expired.
 * - a crashed holder simply stops renewing; after `ttlMs` anyone can take over.
 *
 * Returns null when another live holder has it.
 */
export async function acquireLease(client, name, { ttlMs = 60_000, holder = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`, logger } = {}) {
  const key = `lease:${name}`;
  const t0 = Date.now();
  const rs = await client.execute({
    sql: `INSERT INTO kv (key, value, updated_at)
          VALUES (?, json_object('holder', ?, 'expiresAt', ${NOW_MS} + CAST(? AS INTEGER)), ${NOW_MS})
          ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
          WHERE json_extract(kv.value, '$.expiresAt') <= ${NOW_MS} OR json_extract(kv.value, '$.holder') = ?`,
    args: [key, holder, ttlMs, holder],
  });
  if (rs.rowsAffected !== 1) return null;

  // Local bound on validity, measured from before each request was sent.
  let validUntil = t0 + ttlMs;
  return {
    holder,
    ttlMs,
    renewEveryMs: Math.max(1_000, Math.floor(ttlMs / 3)),
    /** Local time (ms) until which the lease is certainly still ours. */
    validUntil: () => validUntil,
    /** true while we hold the lease; false once it is lost (stop working). */
    async renew() {
      const t = Date.now();
      try {
        const r = await client.execute({
          sql: `UPDATE kv SET value = json_object('holder', ?, 'expiresAt', ${NOW_MS} + CAST(? AS INTEGER)), updated_at = ${NOW_MS}
                 WHERE key = ? AND json_extract(value, '$.holder') = ? AND json_extract(value, '$.expiresAt') > ${NOW_MS}`,
          args: [holder, ttlMs, key, holder],
        });
        if (r.rowsAffected !== 1) return false;
        validUntil = t + ttlMs;
        return true;
      } catch (err) {
        // Database unreachable: the lease is still ours until it would have expired.
        logger?.warn('lease renewal failed', { err: err.message });
        return Date.now() < validUntil;
      }
    },
    async release() {
      await client.execute({ sql: "DELETE FROM kv WHERE key = ? AND json_extract(value, '$.holder') = ?", args: [key, holder] });
    },
  };
}
