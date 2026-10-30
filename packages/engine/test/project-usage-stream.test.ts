import {
  Cause,
  Context,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  PubSub,
  Ref,
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
  RunId,
  UsageWindow,
  type UsageWindowItem,
  decodeProjectSettings,
} from '@fabrica/contracts'

import { engineDatabaseLayer } from '../src/engine'
import { EngineFiles, pathsIn } from '../src/engine/paths'
import { type GitConfig, layer as gitLayer } from '../src/git'
import { layerHostFrom } from '../src/host'
import {
  type RunnerConfig,
  hostHolders,
  hostPriority,
  layerClock,
  listProcesses,
  layer as runnerLayer,
} from '../src/process'
import { Projects, layer as projectsLayer } from '../src/projects'
import {
  type ModelProxyShape,
  ProxyEvent,
  type UsageWindowFigure,
  usageProvider,
  watchUsageWindows,
} from '../src/proxy'
import { projectsHandlers } from '../src/rpc/projects'
import { refusingRuns } from '../src/run/hosting'
import { SecretName } from '../src/secrets'

// `projects.watchUsage` (spec §12.9, §18.3, H90): the usage windows of a project's provider account,
// the one its workers' model is called on (every account's where its settings name no model), as the
// model proxy keeps them: a snapshot of their latest figures, then each window of that account as it
// moves, numbered from the snapshot's. An engine whose runs are refused has no proxy, and no windows;
// an unknown project is refused.

let root = ''
let home = ''
let gitFolder = ''

beforeAll(() => {
  root = realpathSync(
    mkdtempSync(NodePath.join(tmpdir(), 'fabrica-usage-rpc-')),
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

/** The host's facts, its home the test's. */
const testHost = Layer.suspend(() =>
  layerHostFrom({
    availableParallelism: () => 2,
    totalmem: () => 8 * 1024 ** 3,
    loadavg: () => [0],
    homedir: () => home,
  }),
)

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
      Layer.provide(testHost),
      Layer.provide(refusingRuns('this test runs nothing')),
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

/** A window's figure on `provider`'s account. */
const figure = (options: {
  readonly provider: string
  readonly window: string
  readonly utilization: number
}): UsageWindowFigure => ({
  ...options,
  account: Option.some(SecretName.make(options.provider)),
  resetsAt: Option.some(DateTime.makeUnsafe('2026-10-30T18:00:00Z')),
})

/** `figure` as the console is sent it. */
const shown = (each: UsageWindowFigure): UsageWindow =>
  new UsageWindow({
    provider: each.provider,
    window: each.window,
    utilization: each.utilization,
    resetsAt: each.resetsAt,
  })

const caller = {
  run: RunId.make('r-1'),
  ticket: Option.none(),
  session: Option.none(),
  model: 'anthropic/claude-opus-5-5',
}

/**
 * A model proxy holding `figures`, whose `publish` sends its subscribers an event, and `subscribed`
 * says when one has subscribed.
 */
const fakeProxy = (figures: ReadonlyArray<UsageWindowFigure>) =>
  Effect.gen(function* () {
    const kept = yield* Ref.make(figures)
    const published = yield* PubSub.unbounded<ProxyEvent>()
    const subscribed = yield* Deferred.make<void>()
    const proxy: ModelProxyShape = {
      address: 'http://127.0.0.1:1',
      grant: () => Effect.die('no agents here'),
      events: Effect.map(
        PubSub.subscribe(published),
        Stream.fromSubscription,
      ).pipe(Effect.tap(() => Deferred.succeed(subscribed, undefined))),
      windows: Ref.get(kept),
      probe: () => Effect.die('no probes here'),
    }
    const publish = (event: ProxyEvent) => PubSub.publish(published, event)
    return { proxy, publish, subscribed: Deferred.await(subscribed) }
  })

const anthropicFive = figure({
  provider: 'anthropic',
  window: 'five_hour',
  utilization: 0.41,
})
const anthropicSeven = figure({
  provider: 'anthropic',
  window: 'seven_day',
  utilization: 0.12,
})
const openaiFive = figure({
  provider: 'openai',
  window: 'five_hour',
  utilization: 0.23,
})

describe('the provider whose windows a project sees', () => {
  it.effect(
    'is its workers’ model’s provider; none where it names no model',
    () =>
      Effect.gen(function* () {
        const named = yield* decodeProjectSettings({
          model: 'openai/gpt-5.5-codex',
        })
        expect(usageProvider(Option.some(named))).toEqual(Option.some('openai'))
        const unnamed = yield* decodeProjectSettings({})
        expect(usageProvider(Option.some(unnamed))).toEqual(Option.none())
        expect(usageProvider(Option.none())).toEqual(Option.none())
      }),
  )
})

describe('a project’s usage windows', () => {
  it.effect(
    'sends its account’s latest figures, then each of its windows as it moves, others left out',
    () =>
      Effect.gen(function* () {
        const { proxy, publish, subscribed } = yield* fakeProxy([
          anthropicFive,
          openaiFive,
          anthropicSeven,
        ])
        const items = yield* watchUsageWindows({
          proxy: Option.some(proxy),
          provider: Option.some('anthropic'),
        }).pipe(Stream.take(3), Stream.runCollect, Effect.forkChild)
        yield* subscribed
        const moved = { ...anthropicFive, utilization: 0.5 }
        const seven = { ...anthropicSeven, utilization: 0.2 }
        yield* publish(
          ProxyEvent.Windowed({
            caller,
            figure: { ...openaiFive, utilization: 0.3 },
          }),
        )
        yield* publish(ProxyEvent.Windowed({ caller, figure: moved }))
        yield* publish(
          ProxyEvent.Used({
            provider: 'anthropic',
            caller,
            tokens: { input: 10, output: 5, cache_read: 0, cache_write: 0 },
            latency: Duration.seconds(1),
            firstToken: Option.none(),
          }),
        )
        yield* publish(ProxyEvent.Windowed({ caller, figure: seven }))
        const [snapshot, first, second] = yield* Fiber.join(items)
        if (snapshot?._tag !== 'snapshot') return expect.fail('no snapshot')
        expect(snapshot.seq).toBe(0)
        expect(snapshot.value).toEqual([
          shown(anthropicFive),
          shown(anthropicSeven),
        ])
        expect([first, second]).toEqual([
          { _tag: 'patch', seq: 1, value: shown(moved) },
          { _tag: 'patch', seq: 2, value: shown(seven) },
        ])
      }),
  )

  it.effect('sends every account’s where the project names no provider', () =>
    Effect.gen(function* () {
      const { proxy } = yield* fakeProxy([anthropicFive, openaiFive])
      const [snapshot] = yield* watchUsageWindows({
        proxy: Option.some(proxy),
        provider: Option.none(),
      }).pipe(Stream.take(1), Stream.runCollect)
      if (snapshot?._tag !== 'snapshot') return expect.fail('no snapshot')
      expect(snapshot.value).toEqual([shown(anthropicFive), shown(openaiFive)])
    }),
  )

  it.effect(
    'names each subscription’s numbering apart, so a resumed one starts afresh',
    () =>
      Effect.gen(function* () {
        const { proxy } = yield* fakeProxy([anthropicFive])
        const watch = watchUsageWindows({
          proxy: Option.some(proxy),
          provider: Option.none(),
        }).pipe(Stream.take(1), Stream.runCollect)
        const [first] = yield* watch
        const [second] = yield* watch
        if (first?._tag !== 'snapshot' || second?._tag !== 'snapshot')
          return expect.fail('no snapshots')
        expect(first.epoch).not.toBe(second.epoch)
      }),
  )

  it.effect('sends none where the engine has no model proxy', () =>
    Effect.gen(function* () {
      const [snapshot] = yield* watchUsageWindows({
        proxy: Option.none(),
        provider: Option.some('anthropic'),
      }).pipe(Stream.take(1), Stream.runCollect)
      if (snapshot?._tag !== 'snapshot') return expect.fail('no snapshot')
      expect(snapshot.value).toEqual([])
    }),
  )
})

describe('projects.watchUsage', () => {
  it.live('sends a project none on an engine whose runs are refused', () =>
    Effect.gen(function* () {
      const checkout = yield* newCheckout
      const { client } = yield* newEngine
      const added = yield* client['projects.add']({
        source: ProjectSource.cases.path.make({ path: checkout }),
        name: Option.none(),
      })
      const [snapshot] = yield* client['projects.watchUsage']({
        project: added.id,
        resume: Option.none(),
      }).pipe(Stream.take(1), Stream.runCollect)
      expect(snapshot).toMatchObject<Partial<UsageWindowItem>>({
        _tag: 'snapshot',
        seq: 0,
      })
      if (snapshot?._tag !== 'snapshot') return expect.fail('no snapshot')
      expect(snapshot.value).toEqual([])
    }).pipe(Effect.scoped),
  )

  it.live('refuses a project the engine doesn’t hold', () =>
    Effect.gen(function* () {
      const { client } = yield* newEngine
      const missing = ProjectId.make('missing')
      const exit = yield* client['projects.watchUsage']({
        project: missing,
        resume: Option.none(),
      }).pipe(Stream.runDrain, Effect.exit)
      if (Exit.isSuccess(exit)) return expect.fail('it succeeded')
      expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toEqual(
        new ProjectNotFound({ project: missing }),
      )
    }).pipe(Effect.scoped),
  )
})
