import { type Migrations, statements } from '../workgraph/migrations'
import { rowTables } from './rows'

// The telemetry store's schema (spec §21): one table per kind of row, each with its time and what it
// is tied to, and `daily`, the aggregates raw rows are rolled up into before retention drops them.
// Migrated as the work graph's database is (`migrate`), with its own record.

/** The columns every tied row starts with. */
const tied = `at INTEGER NOT NULL, project TEXT NOT NULL, run TEXT, ticket TEXT`

const rows = statements(
  `CREATE TABLE model_calls (${tied},
    provider TEXT NOT NULL, model TEXT NOT NULL,
    input INTEGER NOT NULL, output INTEGER NOT NULL,
    cache_write INTEGER NOT NULL, cache_read INTEGER NOT NULL,
    cost_usd REAL, latency_ms INTEGER NOT NULL, first_token_ms INTEGER,
    outcome TEXT NOT NULL CHECK (outcome IN ('answered','refused','failed')),
    error TEXT)`,
  `CREATE TABLE tool_calls (${tied},
    tool TEXT NOT NULL, duration_ms INTEGER NOT NULL,
    allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
    asked INTEGER NOT NULL CHECK (asked IN (0, 1)))`,
  `CREATE TABLE checks (${tied},
    suite TEXT NOT NULL, duration_ms INTEGER NOT NULL, result TEXT NOT NULL)`,
  `CREATE TABLE merges (${tied}, duration_ms INTEGER NOT NULL, outcome TEXT NOT NULL)`,
  `CREATE TABLE hand_backs (${tied}, kind TEXT NOT NULL CHECK (kind IN ('resolve','fix')))`,
  `CREATE TABLE holds (${tied}, hold TEXT NOT NULL, duration_ms INTEGER NOT NULL)`,
  `CREATE TABLE worker_sessions (${tied},
    model TEXT NOT NULL, duration_ms INTEGER NOT NULL, outcome TEXT NOT NULL)`,
  `CREATE TABLE organ_calls (${tied},
    organ TEXT NOT NULL, model TEXT, duration_ms INTEGER NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('answered','no_result')), cost_usd REAL)`,
  `CREATE TABLE host_samples (at INTEGER NOT NULL,
    load REAL NOT NULL, cores INTEGER NOT NULL, memory_pressure REAL, swap_used_bytes INTEGER)`,
  `CREATE TABLE process_samples (${tied},
    process TEXT NOT NULL CHECK (process IN ('worker','check')), rss_bytes INTEGER NOT NULL)`,
  // A day's aggregates of one kind of row, by project, key and outcome; several rows of one day and
  // group add up, so a day rolled up in two prunes is still counted once.
  `CREATE TABLE daily (
    day TEXT NOT NULL,
    kind TEXT NOT NULL,
    project TEXT,
    key TEXT,
    outcome TEXT,
    count INTEGER NOT NULL,
    duration_ms INTEGER,
    input INTEGER, output INTEGER, cache_write INTEGER, cache_read INTEGER,
    cost_usd REAL,
    value_sum REAL, value_max REAL)`,
  ...Object.values(rowTables).map(
    table => `CREATE INDEX ${table}_at ON ${table} (at)`,
  ),
  `CREATE INDEX daily_day ON daily (day, kind)`,
)

// A subscription's model calls are priced apart from money, as their API-price equivalent (§14.4).
const equivalents = statements(
  `ALTER TABLE model_calls ADD COLUMN equivalent_usd REAL`,
  `ALTER TABLE daily ADD COLUMN equivalent_usd REAL`,
)

/** The telemetry store's migrations, in order. */
export const telemetryMigrations: Migrations = {
  '0001_telemetry': rows,
  '0002_model_call_equivalents': equivalents,
}
