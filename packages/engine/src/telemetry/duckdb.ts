import { Context, Data, Effect, Layer } from 'effect'
import { SqlClient } from 'effect/sql'

import type {
  DuckDBAppender,
  DuckDBConnection,
  DuckDBType,
  DuckDBValue,
} from '@duckdb/node-api'
import type { ProjectId, Ticket } from '@fabrica/contracts'

import { rowTables } from './rows'

// The telemetry query layer's database (spec §21, H65): DuckDB (`@duckdb/node-api`, pinned to 1.5.x,
// fab-mgi.15) at `<data>/telemetry.duckdb`, which only the engine opens. DuckDB never opens a SQLite
// file (fab-mgi.14: its own SQLite in the engine's process corrupts the engine's writes): the recorded
// rows are read through the telemetry store's client and appended to a copy of each table, and the
// work graph's tickets are copied the same way, so a join with tickets sees them as of the last
// refresh. A table's copy carries each row's SQLite `rowid` as `source_row`, so a refresh appends the
// rows written since the last one and drops those retention dropped; where the rowids no longer line
// up (the store was made anew), the table is copied whole. The file's storage version is pinned, so
// the engine's previous version can still read it, and nothing is installed or loaded at run time:
// `json` and `parquet` are linked into the library. The library is loaded when the database is first
// opened, so an engine whose host can't load it still runs, with the query layer refusing, its reason
// given.

/** The query layer couldn't do what it was asked: DuckDB isn't there, or a statement failed. */
export class QueryLayerFailed extends Data.TaggedError('QueryLayerFailed')<{
  readonly reason: string
}> {
  override get message() {
    return `the telemetry query layer failed: ${this.reason}`
  }
}

/**
 * DuckDB's settings: the storage version the file is written in, so an upgrade can't leave it
 * unreadable to the engine's previous version; no extension downloaded, none loaded on demand, none
 * unsigned.
 */
export const duckDbSettings: Readonly<Record<string, string>> = {
  storage_compatibility_version: 'v1.5.0',
  autoinstall_known_extensions: 'false',
  autoload_known_extensions: 'false',
  allow_unsigned_extensions: 'false',
}

/** A statement's parameter: text, a number, a list of text, or a text left out. */
export type Parameter = string | number | null | ReadonlyArray<string>

/** A cell of a statement's answer: a number, text, or nothing. */
export type Value = number | string | null

/** A row of a statement's answer, by column. */
export type ResultRow = Readonly<Record<string, Value>>

/** A project's tickets, as a refresh copies them for joins. */
export interface ProjectTickets {
  readonly project: ProjectId
  readonly tickets: ReadonlyArray<Ticket>
}

export interface TelemetryDbShape {
  /** Runs `sql` with its named parameters (`$name`) and answers its rows. */
  readonly rows: (
    sql: string,
    parameters?: Readonly<Record<string, Parameter>>,
  ) => Effect.Effect<ReadonlyArray<ResultRow>, QueryLayerFailed>
  /** Copies the rows recorded since the last refresh, and `tickets` in place of those projects' copies. */
  readonly refresh: (
    tickets: ReadonlyArray<ProjectTickets>,
  ) => Effect.Effect<void, QueryLayerFailed>
  /** Writes the recorded rows, metadata only, as one Parquet file per table in `folder`; answers the files. */
  readonly exportParquet: (
    folder: string,
  ) => Effect.Effect<ReadonlyArray<string>, QueryLayerFailed>
}

export class TelemetryDb extends Context.Service<
  TelemetryDb,
  TelemetryDbShape
>()('@fabrica/engine/TelemetryDb') {}

/** A column's DuckDB type. */
type ColumnType = 'BIGINT' | 'DOUBLE' | 'VARCHAR' | 'INTEGER'

interface Column {
  readonly name: string
  readonly type: ColumnType
}

/** The recorded rows' tables, the daily aggregates last. */
export const copiedTables: ReadonlyArray<string> = [
  ...Object.values(rowTables),
  'daily',
]

/** The tickets' copy: what joins and comparisons need of a ticket, never its text. */
const ticketColumns: ReadonlyArray<Column> = [
  { name: 'project', type: 'VARCHAR' },
  { name: 'id', type: 'VARCHAR' },
  { name: 'type', type: 'VARCHAR' },
  { name: 'priority', type: 'INTEGER' },
  { name: 'status', type: 'VARCHAR' },
]

/** The copy's column holding a row's SQLite rowid. */
const sourceRow = 'source_row'

/**
 * Fields that carry content, never metadata (§21): an export leaves out any column named so, should a
 * table ever gain one.
 */
export const contentFields: ReadonlySet<string> = new Set([
  'title',
  'description',
  'design',
  'acceptance',
  'text',
  'detail',
  'prompt',
  'message',
  'content',
  'output',
  'command',
  'path',
  'question',
  'notes',
])

/** The most rows a refresh reads from SQLite at a time. */
const readBatch = 10_000

/** A SQLite column's type as DuckDB copies it. */
const columnTypeOf = (sqliteType: string): ColumnType => {
  const type = sqliteType.toUpperCase()
  if (type.includes('INT')) return 'BIGINT'
  if (type.includes('REAL') || type.includes('FLOA') || type.includes('DOUB'))
    return 'DOUBLE'
  return 'VARCHAR'
}

const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`

/** `text` as a SQL string literal. */
export const literal = (text: string): string =>
  `'${text.replaceAll("'", "''")}'`

const reasonOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/** A DuckDB value as a cell: numbers as numbers, text as text, anything else as its text. */
const valueOf = (value: unknown): Value => {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' || typeof value === 'string') return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'boolean') return value ? 1 : 0
  return JSON.stringify(value)
}

/** Appends `value` to the appender's row as a `type` column. */
const appendValue = (
  appender: DuckDBAppender,
  type: ColumnType,
  value: unknown,
): void => {
  if (value === null || value === undefined) {
    appender.appendNull()
    return
  }
  switch (type) {
    case 'BIGINT':
      appender.appendBigInt(
        typeof value === 'bigint' ? value : BigInt(Math.round(Number(value))),
      )
      return
    case 'INTEGER':
      appender.appendInteger(Number(value))
      return
    case 'DOUBLE':
      appender.appendDouble(Number(value))
      return
    case 'VARCHAR':
      appender.appendVarchar(String(value))
      return
  }
}

/** The query layer's database at `filename` (`:memory:` for one in memory), opened in the current scope. */
export const makeTelemetryDb = Effect.fn('TelemetryDb.make')(function* (
  filename: string,
) {
  const sql = yield* SqlClient.SqlClient
  const attempt = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: cause => new QueryLayerFailed({ reason: reasonOf(cause) }),
    })
  const duckdb = yield* Effect.tryPromise({
    try: () => import('@duckdb/node-api'),
    catch: cause =>
      new QueryLayerFailed({
        reason: `DuckDB can't be loaded on this host: ${reasonOf(cause)}`,
      }),
  })
  const instance = yield* Effect.acquireRelease(
    attempt(() => duckdb.DuckDBInstance.create(filename, duckDbSettings)),
    opened => Effect.sync(() => opened.closeSync()),
  )
  const connection: DuckDBConnection = yield* Effect.acquireRelease(
    attempt(() => instance.connect()),
    opened => Effect.sync(() => opened.closeSync()),
  )

  const run = (statement: string) =>
    attempt(() => connection.run(statement)).pipe(Effect.asVoid)

  const rows = Effect.fn('TelemetryDb.rows')(function* (
    statement: string,
    parameters: Readonly<Record<string, Parameter>> = {},
  ) {
    const values: Record<string, DuckDBValue> = {}
    const types: Record<string, DuckDBType> = {}
    for (const [name, parameter] of Object.entries(parameters)) {
      if (parameter === null || typeof parameter === 'string') {
        values[name] = parameter
        types[name] = duckdb.VARCHAR
      } else if (typeof parameter === 'number') {
        values[name] = parameter
        types[name] = duckdb.DOUBLE
      } else {
        values[name] = duckdb.listValue([...parameter])
        types[name] = duckdb.LIST(duckdb.VARCHAR)
      }
    }
    const reader = yield* attempt(() =>
      connection.runAndReadAll(statement, values, types),
    )
    return reader
      .getRowObjectsJS()
      .map(row =>
        Object.fromEntries(
          Object.entries(row).map(([name, value]) => [name, valueOf(value)]),
        ),
      )
  })

  /** The columns `table` has in DuckDB, in order; none where it has no such table. */
  const duckColumns = (table: string) =>
    rows(
      `SELECT column_name AS name FROM duckdb_columns() WHERE table_name = $table ORDER BY column_index`,
      { table },
    ).pipe(Effect.map(found => found.map(({ name }) => String(name))))

  /** Makes `table` with `columns`, in place of one with other columns. */
  const ensureTable = Effect.fn('TelemetryDb.ensureTable')(function* (
    table: string,
    columns: ReadonlyArray<Column>,
  ) {
    const found = yield* duckColumns(table)
    const wanted = columns.map(({ name }) => name)
    if (
      found.length === wanted.length &&
      found.every((name, index) => name === wanted[index])
    )
      return
    if (found.length > 0) yield* run(`DROP TABLE ${quoted(table)}`)
    yield* run(
      `CREATE TABLE ${quoted(table)} (${columns.map(({ name, type }) => `${quoted(name)} ${type}`).join(', ')})`,
    )
  })

  /** Appends `values`, each a row of `columns`, to `table`. */
  const append = (
    table: string,
    columns: ReadonlyArray<Column>,
    values: ReadonlyArray<Readonly<Record<string, unknown>>>,
  ) =>
    Effect.gen(function* () {
      if (values.length === 0) return
      const appender = yield* attempt(() => connection.createAppender(table))
      yield* Effect.try({
        try: () => {
          for (const value of values) {
            for (const { name, type } of columns)
              appendValue(appender, type, value[name])
            appender.endRow()
          }
          appender.flushSync()
        },
        catch: cause => new QueryLayerFailed({ reason: reasonOf(cause) }),
      }).pipe(Effect.ensuring(Effect.sync(() => appender.closeSync())))
    })

  const fromSqlite = <A extends object>(
    statement: string,
    parameters: ReadonlyArray<string | number> = [],
  ) =>
    sql
      .unsafe<A>(statement, parameters)
      .pipe(
        Effect.mapError(
          error => new QueryLayerFailed({ reason: error.message }),
        ),
      )

  /** A recorded table's columns as SQLite has them, its copy's `source_row` first. */
  const sourceColumns = (table: string) =>
    fromSqlite<{ readonly name: string; readonly type: string }>(
      `SELECT name, type FROM pragma_table_info(?)`,
      [table],
    ).pipe(
      Effect.map((found): ReadonlyArray<Column> => [
        { name: sourceRow, type: 'BIGINT' },
        ...found.map(({ name, type }) => ({ name, type: columnTypeOf(type) })),
      ]),
    )

  const columnsByTable = new Map<string, ReadonlyArray<Column>>()
  for (const table of copiedTables) {
    const columns = yield* sourceColumns(table)
    columnsByTable.set(table, columns)
    yield* ensureTable(table, columns)
  }
  yield* ensureTable('tickets', ticketColumns)

  /** The column a table's rows are ordered and pruned by. */
  const timeOf = (table: string): string => (table === 'daily' ? 'day' : 'at')

  /** The row of the copy and of the store at the copy's last rowid agree: rows past it are new. */
  const lastAgrees = (table: string, last: number) =>
    Effect.gen(function* () {
      const kept = yield* fromSqlite<{ readonly moment: number | string }>(
        `SELECT ${quoted(timeOf(table))} AS moment FROM ${quoted(table)} WHERE rowid = ?`,
        [last],
      )
      const copied = yield* rows(
        `SELECT ${quoted(timeOf(table))} AS moment FROM ${quoted(table)} WHERE ${sourceRow} = $last`,
        { last },
      )
      return (
        kept.length === 1 &&
        copied.length === 1 &&
        String(kept[0]?.moment) === String(copied[0]?.moment)
      )
    })

  /** Brings `table`'s copy up to the store's rows. */
  const refreshTable = Effect.fn('TelemetryDb.refreshTable')(function* (
    table: string,
  ) {
    const columns = columnsByTable.get(table) ?? []
    const [copied] = yield* rows(
      `SELECT max(${sourceRow}) AS newest FROM ${quoted(table)}`,
    )
    const last = copied?.newest ?? null
    let from = 0
    if (typeof last === 'number' && (yield* lastAgrees(table, last))) {
      // Retention drops every row older than a cutoff: the copies older than the oldest row kept go.
      const [oldest] = yield* fromSqlite<{ readonly moment: number | string }>(
        `SELECT min(${quoted(timeOf(table))}) AS moment FROM ${quoted(table)}`,
      )
      if (oldest !== undefined)
        yield* rows(
          `DELETE FROM ${quoted(table)} WHERE ${quoted(timeOf(table))} < $oldest`,
          { oldest: oldest.moment },
        )
      from = last
    } else if (last !== null) {
      yield* run(`DELETE FROM ${quoted(table)}`)
    }
    for (;;) {
      const batch = yield* fromSqlite<Readonly<Record<string, unknown>>>(
        `SELECT rowid AS ${sourceRow}, * FROM ${quoted(table)} WHERE rowid > ? ORDER BY rowid LIMIT ${readBatch}`,
        [from],
      )
      yield* append(table, columns, batch)
      const next = batch.at(-1)?.[sourceRow]
      if (batch.length < readBatch || typeof next !== 'number') return
      from = next
    }
  })

  const refresh = Effect.fn('TelemetryDb.refresh')(function* (
    tickets: ReadonlyArray<ProjectTickets>,
  ) {
    for (const table of copiedTables) yield* refreshTable(table)
    for (const { project, tickets: copied } of tickets) {
      yield* rows(`DELETE FROM tickets WHERE project = $project`, { project })
      yield* append(
        'tickets',
        ticketColumns,
        copied.map(ticket => ({
          project,
          id: ticket.id,
          type: ticket.type,
          priority: ticket.priority,
          status: ticket.status,
        })),
      )
    }
  })

  const exportParquet = Effect.fn('TelemetryDb.exportParquet')(function* (
    folder: string,
  ) {
    const files: Array<string> = []
    for (const table of copiedTables) {
      const columns = (columnsByTable.get(table) ?? []).filter(
        ({ name }) => name !== sourceRow && !contentFields.has(name),
      )
      const file = `${folder}/${table}.parquet`
      yield* run(
        `COPY (SELECT ${columns.map(({ name }) => quoted(name)).join(', ')} FROM ${quoted(table)}) TO ${literal(file)} (FORMAT parquet)`,
      )
      files.push(file)
    }
    return files
  })

  return TelemetryDb.of({ rows, refresh, exportParquet })
})

/** The query layer's database at `filename`, on the telemetry store in context. */
export const telemetryDbLayer = (filename: string) =>
  Layer.effect(TelemetryDb, makeTelemetryDb(filename))
