import { config } from './config.js';
import { createLogger } from './core/logger.js';

/*
 * Entry point. APP_ROLE picks what this process does:
 *
 *   (unset) / all, no database   local development: API + sync in one
 *                                process, data in memory (npm run dev)
 *   api                          dashboard API; reads the database only and
 *                                never contacts Telnyx (no API key needed)
 *   worker                       Telnyx sync; writes the database, no HTTP
 *   all, with a database         api + worker in one process
 */
const log = createLogger('tlxmon');

if (config.role === 'worker') {
  await (await import('./roles/worker.js')).start(config);
} else if (config.database) {
  await (await import('./roles/api.js')).start(config);
  if (config.role === 'all') await (await import('./roles/worker.js')).start(config);
} else if (config.role === 'api') {
  log.error('APP_ROLE=api needs a database', { fix: 'PostgreSQL: set DATABASE_URL (or PGHOST/PGUSER/PGDATABASE/PGPASSWORD_FILE); libSQL: set DATABASE_BACKEND=libsql and LIBSQL_URL or TURSO_DATABASE_URL' });
  process.exit(1);
} else {
  await (await import('./roles/standalone.js')).start(config);
}
