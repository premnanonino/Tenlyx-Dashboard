-- TLX/MON schema. Idempotent: safe to run on every start (guarded by an advisory lock).

-- Every billed record, exactly once. The primary key is the product-namespaced
-- upstream id, so re-reading a page can never insert a duplicate.
CREATE TABLE IF NOT EXISTS billing_records (
  id          text        PRIMARY KEY,
  seq         bigint      GENERATED ALWAYS AS IDENTITY UNIQUE, -- insertion order, tailed by the API
  ts          timestamptz NOT NULL,
  product     text        NOT NULL,
  cost        numeric(18, 6) NOT NULL DEFAULT 0,
  data        jsonb       NOT NULL,                             -- normalised BillingRecord
  inserted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS billing_records_ts_idx ON billing_records (ts);

CREATE TABLE IF NOT EXISTS balance_snapshots (
  ts   timestamptz PRIMARY KEY,
  data jsonb       NOT NULL
);

-- Small documents: sync checkpoints, sync status, billing groups, assistants, thresholds.
CREATE TABLE IF NOT EXISTS kv (
  key        text        PRIMARY KEY,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Monthly statements, rebuilt from billing_records by the report job.
CREATE TABLE IF NOT EXISTS rollup_months (
  month        text        PRIMARY KEY,   -- YYYY-MM (UTC)
  data         jsonb       NOT NULL,
  source_count bigint      NOT NULL,
  built_at     timestamptz NOT NULL DEFAULT now()
);
-- Set once a closed month is complete: it is never rebuilt or changed again,
-- so its raw records can be pruned without touching the summary.
ALTER TABLE rollup_months ADD COLUMN IF NOT EXISTS finalized_at timestamptz;

-- "Sync now" from the dashboard: the API enqueues, the worker consumes.
CREATE TABLE IF NOT EXISTS sync_requests (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  requested_at timestamptz NOT NULL DEFAULT now(),
  requested_by text,
  handled_at   timestamptz
);

-- Login sessions. Only a SHA-256 of the cookie value is stored.
CREATE TABLE IF NOT EXISTS sessions (
  id_hash    text        PRIMARY KEY,
  email      text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

-- Recent sync failures / notable events, for the dashboard (pruned to the newest 500).
CREATE TABLE IF NOT EXISTS sync_events (
  id      bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at      timestamptz NOT NULL DEFAULT now(),
  level   text        NOT NULL,
  lane    text,
  message text        NOT NULL
);

-- Call History: slim copy of CourseRev's conversations (no transcripts or recordings),
-- synced read-only from production by the worker. synced_at drives the API's tail.
CREATE TABLE IF NOT EXISTS calls (
  call_id   text        PRIMARY KEY,
  ts        timestamptz NOT NULL,
  data      jsonb       NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS calls_ts_idx ON calls (ts);
CREATE INDEX IF NOT EXISTS calls_synced_at_idx ON calls (synced_at);
