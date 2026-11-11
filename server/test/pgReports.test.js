/**
 * PostgreSQL integration test for the report builder + retention SQL.
 * Runs only when TEST_DATABASE_URL points at a database whose name contains
 * "test" (it truncates tables), e.g.
 *   TEST_DATABASE_URL=postgres://localhost:5432/tlxmon_test npm test
 */
import { test } from 'node:test';
import { connect, migrate } from '../src/db/pg.js';
import { PgRepo } from '../src/persistence/pgRepo.js';
import { reportScenario } from './helpers/reportScenario.js';

const url = process.env.TEST_DATABASE_URL;
const safe = !!url && /test/i.test(new URL(url).pathname);

test('postgres: incremental reports, finalization and 35-day retention', { skip: !safe && 'set TEST_DATABASE_URL to a *test* database' }, async () => {
  const pool = await connect({ connectionString: url, max: 3 }, { attempts: 1 });
  try {
    await migrate(pool);
    await migrate(pool); // schema stays idempotent with the new column
    await pool.query('TRUNCATE billing_records, balance_snapshots, rollup_months, kv RESTART IDENTITY');
    await reportScenario({
      repo: new PgRepo({ pool }),
      countOlder: async (table, cutoff) => (await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ts < $1`, [new Date(cutoff)])).rows[0].n,
    });
  } finally {
    await pool.end();
  }
});
