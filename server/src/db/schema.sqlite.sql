-- TLX/MON schema for libSQL / SQLite (local file or Turso). Same tables and
-- meaning as schema.sql (PostgreSQL); idempotent, safe to run on every start.
--   timestamps  INTEGER epoch milliseconds (UTC)
--   JSON        TEXT holding JSON
--   money       REAL (the application already works in JS floats)

-- Every billed record, exactly once. `seq` is the insertion order the API
-- and report builder follow. AUTOINCREMENT guarantees it never reuses a
-- value, even after retention deletes the newest rows' predecessors.
CREATE TABLE IF NOT EXISTS billing_records (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT    NOT NULL UNIQUE,                 -- product-namespaced upstream id
  ts          INTEGER NOT NULL,
  product     TEXT    NOT NULL,
  cost        REAL    NOT NULL DEFAULT 0,
  data        TEXT    NOT NULL,                        -- normalised BillingRecord (JSON)
  inserted_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX IF NOT EXISTS billing_records_ts_idx ON billing_records (ts);

CREATE TABLE IF NOT EXISTS balance_snapshots (
  ts   INTEGER PRIMARY KEY,
  data TEXT    NOT NULL
);

-- Small documents: sync checkpoints, sync status, billing groups, assistants,
-- thresholds, report cursor, and the worker lease.
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

-- Monthly statements, built by the report builder.
CREATE TABLE IF NOT EXISTS rollup_months (
  month        TEXT    PRIMARY KEY,   -- YYYY-MM (UTC)
  data         TEXT    NOT NULL,
  source_count INTEGER NOT NULL,
  built_at     INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  finalized_at INTEGER                -- set once a closed month is complete; never changed after
);

-- "Sync now" from the dashboard: the API enqueues, the worker consumes.
CREATE TABLE IF NOT EXISTS sync_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  requested_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  requested_by TEXT,
  handled_at   INTEGER
);

-- Login sessions. Only a SHA-256 of the cookie value is stored.
CREATE TABLE IF NOT EXISTS sessions (
  id_hash    TEXT    PRIMARY KEY,
  email      TEXT    NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

-- Recent sync failures / notable events (pruned to the newest 500).
CREATE TABLE IF NOT EXISTS sync_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  level   TEXT    NOT NULL,
  lane    TEXT,
  message TEXT    NOT NULL
);

-- Call History: slim copy of CourseRev's conversations (no transcripts or recordings),
-- synced read-only from production by the worker. synced_at drives the API's tail.
CREATE TABLE IF NOT EXISTS calls (
  call_id   TEXT    PRIMARY KEY,
  ts        INTEGER NOT NULL,
  data      TEXT    NOT NULL,
  synced_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX IF NOT EXISTS calls_ts_idx ON calls (ts);
CREATE INDEX IF NOT EXISTS calls_synced_at_idx ON calls (synced_at);
