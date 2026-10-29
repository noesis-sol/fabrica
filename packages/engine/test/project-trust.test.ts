import { Cause, Context, Duration, Effect, Exit, Layer, Option } from 'effect'
import { Reactivity } from 'effect/reactivity'
import { SqlClient } from 'effect/sql'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import { SqliteClient } from '@effect/sql-sqlite-node'
import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  ProjectId,
  ProjectNotFound,
  ProjectSource,
  ProjectTrustedVariable,
} from '@fabrica/contracts'

import { piEnvironment } from '../src/agent/launch'
import { engineDatabaseLayer, engineMigrations } from '../src/engine'
import { EngineFiles, pathsIn } from '../src/engine/paths'
import { type GitConfig, layer as gitLayer } from '../src/git'
import {
  type RunnerConfig,
  hostHolders,
  hostPriority,
  layerClock,
  listProcesses,
  layer as runnerLayer,
} from '../src/process'
import {
  Projects,
  type ProjectsShape,
  layer as projectsLayer,
} from '../src/projects'
import { migrate } from '../src/workgraph/migrations'

// A project's trust (spec §12.1, §20.2): kept in engine.db, a project added untrusted and trusted by
// the user, kept across the engine's restarts and over an engine.db from before trust was kept; and
// an agent's environment carrying `FABRICA_PROJECT_TRUSTED=1` only where its project is trusted.

let root = ''
let home = ''
let gitFolder = ''

beforeAll(() => {
  root = realpathSync(mkdtempSync(NodePath.join(tmpdir(), 'fabrica-trust-')))
  home = NodePath.join(root, 'home')
  mkdirSync(home)
  writeFileSync(
    NodePath.join(home, '.gitconfig'),
    '[user]\n\tname = Fabrica Test\n\temail = test@fabrica.invalid\n[init]\n\tdefaultBranch = main\n',
  )
  gitFolder = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
})

const gitEnvironment = () => ({
  PATH: `${gitFolder}:/usr/bin:/bin`,
  HOME: home,
  LANG: 'C',
})

/** A checkout on `main` with one commit, in a folder of its own. */
const newCheckout = Effect.sync(() => {
  const work = mkdtempSync(NodePath.join(root, 'work-'))
  const git = (...args: ReadonlyArray<string>) =>
    execFileSync('git', args, {
      cwd: work,
      env: { ...gitEnvironment(), GIT_CONFIG_NOSYSTEM: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  git('init', '--quiet')
  writeFileSync(NodePath.join(work, 'README.md'), '# Test\n')
  git('add', 'README.md')
  git('commit', '--quiet', '--message', 'First commit')
  return work
})

const runnerConfig = (): RunnerConfig => ({
  hostEnvironment: gitEnvironment(),
  enginePriority: 0,
  priority: hostPriority,
  listProcesses,
  pipeHolders: hostHolders({ platform: process.platform, self: process.pid }),
  self: process.pid,
  killGrace: Duration.seconds(2),
  outputGrace: Duration.millis(200),
})

const gitConfig: GitConfig = {
  timeLimit: Duration.minutes(1),
  readRetries: { times: 0, spacing: Duration.zero },
}

/** The Projects service of an engine on engine.db at `database`, its data folder `data`. */
const projectsAt = (options: {
  readonly data: string
  readonly database: string
}) =>
  Effect.map(
    Layer.build(
      projectsLayer.pipe(
        Layer.provide(
          gitLayer(gitConfig).pipe(
            Layer.provide(runnerLayer(runnerConfig())),
            Layer.provide(layerClock),
          ),
        ),
        Layer.provide(engineDatabaseLayer(options.database)),
        Layer.provide(
          Layer.succeed(EngineFiles)(
            pathsIn({ data: options.data, socketFolder: options.data }),
          ),
        ),
      ),
    ),
    services => Context.get(services, Projects),
  )

/** A new engine's data folder and engine.db file. */
const newPlaces = Effect.sync(() => {
  const data = mkdtempSync(NodePath.join(root, 'data-'))
  return { data, database: NodePath.join(data, 'engine.db') }
})

/** Adds the checkout `path` as a project. */
const addAt = (projects: ProjectsShape, path: string) =>
  projects.add({
    source: ProjectSource.cases.path.make({ path }),
    name: Option.none(),
  })

describe('a project’s trust', () => {
  it.live(
    'is kept in engine.db: a project is added untrusted, trusted and untrusted by the user',
    () =>
      Effect.gen(function* () {
        const places = yield* newPlaces
        const checkout = yield* newCheckout
        const project = yield* Effect.scoped(
          Effect.gen(function* () {
            const projects = yield* projectsAt(places)
            const added = yield* addAt(projects, checkout)
            expect((yield* projects.find(added.id)).trusted).toBe(false)
            yield* projects.setTrusted({ project: added.id, trusted: true })
            expect((yield* projects.find(added.id)).trusted).toBe(true)
            return added.id
          }),
        )

        // The engine starts again on the same engine.db: the project is still trusted.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const projects = yield* projectsAt(places)
            expect((yield* projects.find(project)).trusted).toBe(true)
            yield* projects.setTrusted({ project, trusted: false })
            expect((yield* projects.find(project)).trusted).toBe(false)
          }),
        )
      }),
  )

  it.live('is refused for a project the engine doesn’t hold', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projects = yield* projectsAt(yield* newPlaces)
        const missing = ProjectId.make('missing')
        const exit = yield* Effect.exit(
          projects.setTrusted({ project: missing, trusted: true }),
        )
        expect(
          Exit.isFailure(exit)
            ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
            : 'it succeeded',
        ).toStrictEqual(new ProjectNotFound({ project: missing }))
      }),
    ),
  )

  it.live(
    'leaves every project of an engine.db from before trust was kept untrusted',
    () =>
      Effect.gen(function* () {
        const places = yield* newPlaces
        const checkout = yield* newCheckout
        // engine.db as the engine before trust made it, holding one project, its `.fabrica/` made.
        mkdirSync(NodePath.join(checkout, '.fabrica'))
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqliteClient.make({ filename: places.database })
            const context = Context.make(SqliteClient.SqliteClient, sql).pipe(
              Context.add(SqlClient.SqlClient, sql),
            )
            yield* migrate({
              '0001_engine': engineMigrations['0001_engine'] ?? Effect.void,
            }).pipe(Effect.provide(context))
            yield* sql`INSERT INTO projects (id, name, path, origin, url, base, added_at)
              VALUES ('old', 'old', ${checkout}, 'registered', NULL, 'main', 0)`
          }).pipe(Effect.provide(Reactivity.layer)),
        )

        yield* Effect.scoped(
          Effect.gen(function* () {
            const projects = yield* projectsAt(places)
            const old = ProjectId.make('old')
            expect((yield* projects.find(old)).trusted).toBe(false)
            yield* projects.setTrusted({ project: old, trusted: true })
            expect((yield* projects.find(old)).trusted).toBe(true)
          }),
        )
      }),
  )
})

describe('an agent’s environment', () => {
  const control = {
    FABRICA_CONTROL_SOCKET: '/run/agent.sock',
    FABRICA_CONTROL_TOKEN: 'token',
  }

  it('says the project is trusted where the user trusts it', () => {
    const environment = piEnvironment({
      config: '/config',
      projectTrusted: true,
      extra: control,
    })
    expect(environment[ProjectTrustedVariable]).toBe('1')
    expect(environment).toMatchObject(control)
  })

  it('says nothing of trust where the user doesn’t trust the project', () => {
    const environment = piEnvironment({
      config: '/config',
      projectTrusted: false,
      extra: control,
    })
    expect(Object.keys(environment)).not.toContain(ProjectTrustedVariable)
    expect(environment).toMatchObject(control)
  })

  it('takes trust from the project alone, never from the caller’s variables', () => {
    const environment = piEnvironment({
      config: '/config',
      projectTrusted: false,
      extra: { ...control, [ProjectTrustedVariable]: '1' },
    })
    expect(Object.keys(environment)).not.toContain(ProjectTrustedVariable)
  })
})
