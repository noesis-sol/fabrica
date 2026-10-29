import { Effect, Option } from 'effect'
import { SqlClient } from 'effect/sql'

import { SqliteClient, SqliteMigrator } from '@effect/sql-sqlite-node'

import { DatabaseTooNew, MigrationFailed } from './errors'

// The work graph's schema and how a database reaches it (spec §11.2): forward-only migrations bundled
// as a record (never read from the file system, whose paths break inside a bundle), a backup before a
// database is migrated, and a database a newer engine migrated refused.

/** A migration: its key `<number>_<name>`, and the statements it runs, one each. */
export type Migrations = Readonly<
  Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>>
>

/** The table the migrator records the migrations applied in. */
const migrationsTable = 'effect_sql_migrations'

const statements = (...sqls: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    for (const text of sqls) yield* sql.unsafe(text)
  })

/**
 * The tickets and what hangs off them, as §11.2 has them. Beyond §11.2: a question's `consequential`
 * and `maintainer_only` (the contracts' `Question`), and `tombstones`, the tickets deleted, which the
 * tickets ref exports (§11.7) and whose IDs are never drawn again.
 */
const workGraph = statements(
  `CREATE TABLE tickets (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('task','bug','feature','chore','epic','question','manual')),
    title TEXT NOT NULL,
    description TEXT, design TEXT, acceptance TEXT,
    status TEXT NOT NULL CHECK (status IN ('open','in_progress','deferred','closed')),
    resolution TEXT CHECK (resolution IN ('done','no_change','cancelled','superseded','answered')),
    priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 4),
    defer_until INTEGER,
    assignee TEXT,
    model TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    result TEXT,
    options TEXT, recommended INTEGER,
    consequential INTEGER CHECK (consequential IN (0, 1)),
    maintainer_only INTEGER CHECK (maintainer_only IN (0, 1)),
    answer TEXT,
    merged_commit TEXT,
    close_reason TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    clocks TEXT NOT NULL
  )`,
  `CREATE TABLE labels (ticket_id TEXT NOT NULL REFERENCES tickets(id), label TEXT NOT NULL,
    PRIMARY KEY (ticket_id, label))`,
  `CREATE TABLE edges (
    from_id TEXT NOT NULL REFERENCES tickets(id), to_id TEXT NOT NULL REFERENCES tickets(id),
    kind TEXT NOT NULL CHECK (kind IN ('blocks','parent','discovered_from','related')),
    PRIMARY KEY (from_id, to_id, kind))`,
  `CREATE TABLE notes (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id),
    author TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE TABLE events (seq INTEGER PRIMARY KEY, ticket_id TEXT, type TEXT NOT NULL,
    actor TEXT, payload TEXT, at INTEGER NOT NULL)`,
  `CREATE TABLE leases (
    ticket_id TEXT PRIMARY KEY REFERENCES tickets(id), engine_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL)`,
  `CREATE TABLE tombstones (id TEXT PRIMARY KEY, actor TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE INDEX edges_to ON edges (to_id)`,
  `CREATE INDEX tickets_status ON tickets (status, priority, created_at)`,
  `CREATE INDEX labels_label ON labels (label)`,
  `CREATE INDEX events_ticket ON events (ticket_id)`,
  `CREATE INDEX notes_ticket ON notes (ticket_id)`,
)

/** The engine's migrations, in order. */
export const migrations: Migrations = {
  '0001_work_graph': workGraph,
}

/** The schema version a set of migrations brings a database to: its highest number. */
const versionOf = (record: Migrations): number =>
  Math.max(
    0,
    ...Object.keys(record).map(key => Number(/^(\d+)_/u.exec(key)?.[1] ?? 0)),
  )

/** A thrown value in words, with what caused it: `Migration "2_name" failed: no such table: x`. */
const describe = (defect: unknown): string =>
  defect instanceof Error
    ? defect.cause === undefined
      ? defect.message
      : `${defect.message}: ${describe(defect.cause)}`
    : String(defect)

/** Where a database's backup before migrating from `version` goes; none for a database in memory. */
export const backupPath = (
  filename: string,
  version: number,
): Option.Option<string> =>
  filename === ':memory:' || filename === ''
    ? Option.none()
    : Option.some(`${filename}.v${version}.backup`)

/**
 * Brings the database to the schema `record` describes (the engine's by default): refuses it when a
 * newer engine migrated it, backs it up when it holds a schema and a migration is due, then runs the
 * migrations due, in one transaction. Returns the version it was at.
 */
export const migrate = Effect.fn('WorkGraph.migrate')(function* (
  record: Migrations = migrations,
) {
  const sql = yield* SqliteClient.SqliteClient
  const filename = sql.config.filename
  const failed = (reason: string) => new MigrationFailed({ filename, reason })
  const known = versionOf(record)

  const found = yield* Effect.gen(function* () {
    const tables = yield* sql<{
      readonly name: string
    }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${migrationsTable}`
    if (tables.length === 0) return 0
    const rows = yield* sql<{
      readonly version: number | null
    }>`SELECT max(migration_id) AS version FROM ${sql(migrationsTable)}`
    return rows[0]?.version ?? 0
  }).pipe(Effect.mapError(error => failed(error.message)))

  if (found > known) {
    return yield* new DatabaseTooNew({ filename, found, known })
  }
  if (found === known) return found

  if (found > 0) {
    yield* Option.match(backupPath(filename, found), {
      onNone: () => Effect.void,
      onSome: path =>
        sql
          .backup(path)
          .pipe(
            Effect.mapError(error =>
              failed(`backing up to ${path}: ${error.message}`),
            ),
          ),
    })
  }

  yield* SqliteMigrator.run({
    loader: SqliteMigrator.fromRecord(record),
    table: migrationsTable,
  }).pipe(
    Effect.mapError(error => failed(error.message)),
    // The migrator dies when a migration's statement fails; its transaction has rolled back.
    Effect.catchDefect(defect => Effect.fail(failed(describe(defect)))),
  )
  return found
})
