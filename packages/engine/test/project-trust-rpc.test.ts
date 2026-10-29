import {
  Cause,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Queue,
  Stream,
} from 'effect'
import { RpcTest } from 'effect/rpc'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  ProjectId,
  ProjectNotFound,
  ProjectRpcs,
  ProjectSource,
  type ProjectStatusItem,
} from '@fabrica/contracts'

import { engineDatabaseLayer } from '../src/engine'
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
import { Projects, layer as projectsLayer } from '../src/projects'
import { projectsHandlers } from '../src/rpc/projects'

// `projects.trust` (spec §8.1, §12.1, §20.2): the user gives and takes back their trust in a
// project over the protocol; `projects.list` and its record say it, and the project's status row is
// sent again with it. An unknown project is refused.

let root = ''
let home = ''
let gitFolder = ''

beforeAll(() => {
  root = realpathSync(
    mkdtempSync(NodePath.join(tmpdir(), 'fabrica-trust-rpc-')),
  )
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

/** A new engine's projects, its engine.db in memory: the RPC client and the service. */
const newEngine = Effect.gen(function* () {
  const data = mkdtempSync(NodePath.join(root, 'data-'))
  const services = yield* Layer.build(
    projectsHandlers.pipe(
      Layer.provideMerge(projectsLayer),
      Layer.provide(
        gitLayer(gitConfig).pipe(
          Layer.provide(runnerLayer(runnerConfig())),
          Layer.provide(layerClock),
        ),
      ),
      Layer.provide(engineDatabaseLayer(':memory:')),
      Layer.provide(
        Layer.succeed(EngineFiles)(pathsIn({ data, socketFolder: data })),
      ),
    ),
  )
  const client = yield* RpcTest.makeClient(ProjectRpcs).pipe(
    Effect.provide(services),
  )
  return { client, projects: Context.get(services, Projects) }
})

describe('projects.trust', () => {
  it.live(
    'trusts a project and takes it back: the list, its status row and its record say so',
    () =>
      Effect.gen(function* () {
        const checkout = yield* newCheckout
        const { client, projects } = yield* newEngine
        const added = yield* client['projects.add']({
          source: ProjectSource.cases.path.make({ path: checkout }),
          name: Option.none(),
        })
        expect(added.trusted).toBe(false)

        const items = yield* Queue.unbounded<ProjectStatusItem>()
        yield* client['projects.watchStatus']({ resume: Option.none() }).pipe(
          Stream.runForEach(item => Queue.offer(items, item)),
          Effect.forkScoped,
        )
        const snapshot = yield* Queue.take(items)
        if (snapshot._tag !== 'snapshot') return expect.fail('no snapshot')
        expect(snapshot.value.map(row => row.trusted)).toStrictEqual([false])

        yield* client['projects.trust']({ project: added.id, trusted: true })
        expect(
          (yield* client['projects.list']()).map(({ id, trusted }) => [
            id,
            trusted,
          ]),
        ).toStrictEqual([[added.id, true]])
        expect((yield* projects.find(added.id)).trusted).toBe(true)
        const trusted = yield* Queue.take(items)
        if (trusted._tag !== 'patch') return expect.fail('no patch')
        expect(
          trusted.value.upsert.map(row => [row.project, row.trusted]),
        ).toStrictEqual([[added.id, true]])

        yield* client['projects.trust']({ project: added.id, trusted: false })
        expect(
          (yield* client['projects.list']()).map(({ trusted }) => trusted),
        ).toStrictEqual([false])
        expect((yield* projects.find(added.id)).trusted).toBe(false)
        const untrusted = yield* Queue.take(items)
        if (untrusted._tag !== 'patch') return expect.fail('no patch')
        expect(
          untrusted.value.upsert.map(row => [row.project, row.trusted]),
        ).toStrictEqual([[added.id, false]])
      }).pipe(Effect.scoped),
  )

  it.live('refuses a project the engine doesn’t hold', () =>
    Effect.gen(function* () {
      const { client } = yield* newEngine
      const missing = ProjectId.make('missing')
      const exit = yield* client['projects.trust']({
        project: missing,
        trusted: true,
      }).pipe(Effect.exit)
      if (Exit.isSuccess(exit)) return expect.fail('it succeeded')
      expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toEqual(
        new ProjectNotFound({ project: missing }),
      )
    }).pipe(Effect.scoped),
  )
})
