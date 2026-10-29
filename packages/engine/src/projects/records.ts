import { Clock, Effect, Option } from 'effect'
import { SqlClient } from 'effect/sql'

import { ProjectId } from '@fabrica/contracts'

// The projects engine.db holds (spec §7.2): what the engine keeps of each, read and written only by
// the Projects service. Its SQL errors are the engine's own faults, defects to the request that met them.

/** A project as engine.db keeps it. */
export interface ProjectRecord {
  readonly id: ProjectId
  readonly name: string
  /** Its checkout, on the engine's host. */
  readonly path: string
  readonly origin: 'registered' | 'cloned'
  /** The remote it was cloned from. */
  readonly url: Option.Option<string>
  /** Base: the branch finished tickets land on. */
  readonly base: string
}

interface Row {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly origin: string
  readonly url: string | null
  readonly base: string
}

const fromRow = (row: Row): ProjectRecord => ({
  id: ProjectId.make(row.id),
  name: row.name,
  path: row.path,
  // The table's check holds origin to the two.
  origin: row.origin === 'cloned' ? 'cloned' : 'registered',
  url: Option.fromNullOr(row.url),
  base: row.base,
})

/** Every project, oldest first. */
export const listRecords = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows =
    yield* sql<Row>`SELECT id, name, path, origin, url, base FROM projects ORDER BY added_at, id`
  return rows.map(fromRow)
}).pipe(Effect.orDie, Effect.withSpan('Projects.listRecords'))

/** The project `id`; none where engine.db has no such project. */
export const findRecord = Effect.fn('Projects.findRecord')(function* (
  id: ProjectId,
) {
  const sql = yield* SqlClient.SqlClient
  const rows =
    yield* sql<Row>`SELECT id, name, path, origin, url, base FROM projects WHERE id = ${id}`.pipe(
      Effect.orDie,
    )
  return Option.map(Option.fromUndefinedOr(rows[0]), fromRow)
})

/** Keeps `record`, added now. */
export const insertRecord = Effect.fn('Projects.insertRecord')(function* (
  record: ProjectRecord,
) {
  const sql = yield* SqlClient.SqlClient
  const now = yield* Clock.currentTimeMillis
  yield* sql`INSERT INTO projects (id, name, path, origin, url, base, added_at)
    VALUES (${record.id}, ${record.name}, ${record.path}, ${record.origin},
      ${Option.getOrNull(record.url)}, ${record.base}, ${now})`.pipe(
    Effect.orDie,
  )
})

/** Forgets the project `id`. */
export const deleteRecord = Effect.fn('Projects.deleteRecord')(function* (
  id: ProjectId,
) {
  const sql = yield* SqlClient.SqlClient
  yield* sql`DELETE FROM projects WHERE id = ${id}`.pipe(Effect.orDie)
})
