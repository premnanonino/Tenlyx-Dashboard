/**
 * Docker HEALTHCHECK. Exit 0 = healthy.
 *   api / all   GET /api/health on this container
 *   worker      its heartbeat in the database (PostgreSQL or libSQL) is recent (it serves no HTTP)
 */
import { config } from './config.js';

const fail = (msg) => { console.error(`unhealthy: ${msg}`); process.exit(1); };

try {
  if (config.role === 'worker' && config.database?.backend === 'libsql') {
    const { createClient } = await import('@libsql/client');
    const client = createClient({ url: config.database.url, authToken: config.database.authToken });
    const rs = await client.execute("SELECT json_extract(value, '$.heartbeatAt') AS hb FROM kv WHERE key = 'sync_status'");
    client.close();
    const age = Date.now() - Number(rs.rows[0]?.hb || 0);
    if (!rs.rows[0] || age > config.worker.staleAfterMs) fail(`no worker heartbeat for ${Math.round(age / 1000)}s`);
  } else if (config.role === 'worker') {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ ...config.db, connectionTimeoutMillis: 5_000 });
    await client.connect();
    const { rows } = await client.query("SELECT (value->>'heartbeatAt')::bigint AS hb FROM kv WHERE key = 'sync_status'");
    await client.end();
    const age = Date.now() - Number(rows[0]?.hb || 0);
    if (!rows[0] || age > config.worker.staleAfterMs) fail(`no worker heartbeat for ${Math.round(age / 1000)}s`);
  } else {
    const res = await fetch(`http://127.0.0.1:${config.port}/api/health`, { signal: AbortSignal.timeout(4_000) });
    if (!res.ok) fail(`/api/health returned ${res.status}`);
  }
  process.exit(0);
} catch (err) {
  fail(err.message);
}
