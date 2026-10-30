import { Clock, Context, Data, Effect, Layer, Option } from 'effect'
import { Reactivity } from 'effect/reactivity'
import { SqlClient } from 'effect/sql'

import { SqliteClient } from '@effect/sql-sqlite-node'
import {
  EngineId,
  type ProjectId,
  decodeEngineSettings,
} from '@fabrica/contracts'

import { drawBase36 } from '../workgraph/ids'
import { type Migrations, migrate, statements } from '../workgraph/migrations'

// The engine's own database (spec §7.2): `<data>/engine.db`, the engine's state across its projects:
// its identity, its settings, the projects it holds (and whether the user trusts each) and its pairing
// tokens (hashed, §9.3). Its migrations are bundled as a record and run as the work graph's are
// (`migrate`), with its own record.
// The groups' handlers that own a table read and write it themselves (`rpc/<group>.ts`).

const engine = statements(
  // The engine's ID, drawn at its first start (§11.5's leases name it).
  `CREATE TABLE engine (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    id TEXT NOT NULL,
    created_at INTEGER NOT NULL)`,
  // The engine's settings (§13.13), one JSON document as `EngineSettings` encodes it.
  `CREATE TABLE settings (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    document TEXT NOT NULL)`,
  `CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    origin TEXT NOT NULL CHECK (origin IN ('registered','cloned')),
    url TEXT,
    base TEXT NOT NULL,
    added_at INTEGER NOT NULL)`,
  // Pairing tokens (§9.3): only each token's hash is kept.
  `CREATE TABLE tokens (
    name TEXT PRIMARY KEY,
    hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER)`,
)

// Whether the user trusts each project (§12.1, §20.2), so its agents may load its own Pi settings
// and packages. Kept by the engine, never in the project's files, which a project's own commits change.
const projectTrust = statements(
  `ALTER TABLE projects ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0 CHECK (trusted IN (0, 1))`,
)

/** The engine database's migrations, in order. */
export const engineMigrations: Migrations = {
  '0001_engine': engine,
  '0002_project_trust': projectTrust,
}

/** The engine's database at `filename` (`:memory:` for one in memory), migrated. */
export const engineDatabaseLayer = (filename: string) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const sql = yield* SqliteClient.make({ filename })
      const context = Context.make(SqliteClient.SqliteClient, sql).pipe(
        Context.add(SqlClient.SqlClient, sql),
      )
      yield* migrate(engineMigrations).pipe(Effect.provide(context))
      return context
    }),
  ).pipe(Layer.provide(Reactivity.layer))

/** The engine's stored settings don't decode: written by hand, or by a newer engine. */
export class StoredSettingsInvalid extends Data.TaggedError(
  'StoredSettingsInvalid',
)<{ readonly reason: string }> {
  override get message() {
    return `the engine's stored settings are invalid: ${this.reason}`
  }
}

/** A new engine ID: `engine-` and 16 random base36 characters. */
export const drawEngineId = Effect.map(drawBase36(16), random =>
  EngineId.make(`engine-${random}`),
)

/** The engine's ID: the one it drew at its first start, drawn and kept now where it has none. */
export const engineIdentity = Effect.fn('EngineDatabase.identity')(
  function* () {
    const sql = yield* SqlClient.SqlClient
    const read = sql<{ readonly id: string }>`SELECT id FROM engine`.pipe(
      Effect.map(rows =>
        Option.fromUndefinedOr(rows[0]).pipe(
          Option.map(({ id }) => EngineId.make(id)),
        ),
      ),
    )
    const found = yield* read
    if (Option.isSome(found)) return found.value
    const drawn = yield* drawEngineId
    const now = yield* Clock.currentTimeMillis
    yield* sql`INSERT INTO engine (singleton, id, created_at) VALUES (1, ${drawn}, ${now})`
    return drawn
  },
)

/** The engine's settings as stored, undecoded: `{}` where it has none, as a run's settings resolve them. */
export const storedSettingsDocument = Effect.fn(
  'EngineDatabase.settingsDocument',
)(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    readonly document: string
  }>`SELECT document FROM settings`
  return yield* Option.match(Option.fromUndefinedOr(rows[0]), {
    onNone: () => Effect.succeed<unknown>({}),
    onSome: ({ document }) =>
      Effect.try({
        try: (): unknown => JSON.parse(document),
        catch: error =>
          new StoredSettingsInvalid({
            reason: error instanceof Error ? error.message : String(error),
          }),
      }),
  })
})

/** The engine's settings as stored, decoded, every key not stored at its default. */
export const storedEngineSettings = Effect.fn('EngineDatabase.settings')(
  function* () {
    const document = yield* storedSettingsDocument()
    return yield* decodeEngineSettings(document).pipe(
      Effect.mapError(
        error => new StoredSettingsInvalid({ reason: error.message }),
      ),
    )
  },
)

/** How many projects the engine holds. */
export const projectCount = Effect.fn('EngineDatabase.projectCount')(
  function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{
      readonly count: number
    }>`SELECT count(*) AS count FROM projects`
    return rows[0]?.count ?? 0
  },
)

/** What the engine keeps of a project for the groups that act in its checkout. */
export interface ProjectRecord {
  /** Its checkout. */
  readonly path: string
  /** Base: the branch finished tickets land on. */
  readonly base: string
}

/** The project `id` names; none when the engine holds no such project. */
export const findProject = Effect.fn('EngineDatabase.findProject')(function* (
  id: ProjectId,
) {
  const sql = yield* SqlClient.SqlClient
  const rows =
    yield* sql<ProjectRecord>`SELECT path, base FROM projects WHERE id = ${id}`
  return Option.fromUndefinedOr(rows[0]).pipe(
    Option.map(({ path, base }): ProjectRecord => ({ path, base })),
  )
})
