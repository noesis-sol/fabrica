import {
  Cause,
  Context,
  DateTime,
  Effect,
  Exit,
  Layer,
  Option,
  Runtime,
} from 'effect'
import { mkdtemp } from 'node:fs/promises'
import * as NodePath from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import { EngineHost, decodeEngineSettings } from '@fabrica/contracts'
import {
  Daemon,
  Process,
  Projects,
  Run,
  Secrets,
  noSleepCauses,
} from '@fabrica/engine'
import { layerHost } from '@fabrica/testkit'

import {
  type ScriptedPlaces,
  engineGit,
  makeCheckout,
  makeScriptedPlaces,
  routesAt,
  runnerConfig,
  takingProvider,
  testSecrets,
} from '../../../packages/engine/test/scripted-run'
import { type HostingConfig, agentPlaces, runHosting } from '../src/hosting'
import { DISTRIBUTION_LAYOUT } from '../src/layout'
import { fabrica } from './tickets-engine'

// `fabrica serve`'s run hosting (spec §7.3, §12, §13): the agents' parts found in the distribution or a
// dev checkout; a run through it to its merge, its Pi the scripted stub and its provider a loopback
// server; runs refused, saying why, where an agent's part is missing or the secret store can't open;
// and each worker's share of the cores and its nice value from the engine's settings.

let places: ScriptedPlaces

beforeAll(() => {
  places = makeScriptedPlaces()
})

const host = new EngineHost({
  platform: 'linux',
  arch: 'x64',
  hostname: 'test',
  cores: 8,
})

/** The hosting of an engine whose data is in `paths`, over the scripted boundaries, with `changes`. */
const scriptedConfig = (
  paths: Daemon.EnginePaths,
  changes: Partial<HostingConfig> = {},
) =>
  Effect.map(takingProvider, (provider): HostingConfig => ({
    paths,
    cores: host.cores,
    agents: {
      node: process.execPath,
      cli: places.stub,
      extension: places.extension,
    },
    environment: {},
    runner: Process.layer(runnerConfig(places)),
    sleepCauses: noSleepCauses,
    secrets: Layer.succeed(Secrets.Secrets)(testSecrets),
    routes: routesAt(provider.url),
    zone: DateTime.layerCurrentZoneOffset(0),
    ...changes,
  }))

/** An engine's data folder and files, short so its control sockets' paths are. */
const newPaths = Effect.map(
  Effect.promise(() => mkdtemp(NodePath.join(places.root, 'e'))),
  data => Daemon.pathsIn({ data, socketFolder: data }),
)

/** A test engine on `config`'s hosting, with one project, `work`: `fabrica <args> --project work`. */
const runEngine = (changes: Partial<HostingConfig> = {}) =>
  Effect.gen(function* () {
    const paths = yield* newPaths
    yield* Daemon.startEngine({
      paths,
      host,
      release: '1.2.3',
      git: engineGit(places),
      runs: runHosting(yield* scriptedConfig(paths, changes)),
    })
    const added = yield* fabrica(
      paths.socket,
      'project',
      'add',
      makeCheckout(places),
      '--name',
      'work',
    )
    expect(added.exit).toStrictEqual(Exit.void)
    const command = (...args: ReadonlyArray<string>) =>
      fabrica(paths.socket, ...args, '--project', 'work')
    return { command }
  })

/** The exit code a command's exit gives: 0 for a success, else its error's (1 unless it says). */
const exitCodeOf = (exit: Exit.Exit<unknown, unknown>): number =>
  Exit.isSuccess(exit)
    ? 0
    : Option.match(Cause.findErrorOption(exit.cause), {
        onNone: () => 1,
        onSome: Runtime.getErrorExitCode,
      })

/** An engine's projects and git on its database in `paths`, with the engine's settings `settings`. */
const hostingNeeds = (paths: Daemon.EnginePaths, settings: object) =>
  Effect.gen(function* () {
    const starting = yield* Effect.orDie(decodeEngineSettings(settings))
    return Projects.layer.pipe(
      Layer.provideMerge(engineGit(places)),
      Layer.provide(layerHost()),
      Layer.provide(Daemon.engineDatabaseLayer(paths.database)),
      Layer.provide(Layer.succeed(Daemon.EngineFiles)(paths)),
      Layer.merge(Layer.succeed(Daemon.StartingSettings)(starting)),
    )
  })

describe('agentPlaces', () => {
  it('finds the agents’ parts in the distribution the engine runs from', () => {
    const root = '/opt/fabrica/fabrica-1.2.3-linux-x64'
    expect(
      agentPlaces({
        self: NodePath.join(root, DISTRIBUTION_LAYOUT.bundle),
        node: '/usr/bin/node',
      }),
    ).toStrictEqual({
      node: NodePath.join(root, DISTRIBUTION_LAYOUT.node),
      cli: NodePath.join(root, DISTRIBUTION_LAYOUT.piCli),
      extension: NodePath.join(root, DISTRIBUTION_LAYOUT.extension),
    })
  })

  it('finds node_modules’ Pi and the built extension in a dev checkout', () => {
    const app = fileURLToPath(new URL('..', import.meta.url))
    for (const self of [
      NodePath.join(app, 'src', 'serve.ts'),
      NodePath.join(app, 'dist', 'main.js'),
    ])
      expect(agentPlaces({ self, node: '/usr/bin/node' })).toStrictEqual({
        node: '/usr/bin/node',
        cli: NodePath.join(
          app,
          'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
        ),
        extension: NodePath.join(
          app,
          '../../packages/pi-extension/dist/index.js',
        ),
      })
  })
})

describe('the run hosting', () => {
  it.live(
    'runs a ticket to its merge on the agents, the model proxy and the checks',
    () =>
      Effect.gen(function* () {
        const { command } = yield* runEngine()
        const filed = yield* command(
          'tickets',
          'create',
          'Add the page',
          '--description',
          'stub: finish',
        )
        expect(filed.exit).toStrictEqual(Exit.void)
        const { exit, out } = yield* command('run', '--wait')
        expect(exitCodeOf(exit)).toBe(0)
        expect(out.join('\n')).toContain('merged')
        expect(out.at(-1)).toMatch(/READY_EMPTY after 1 ticket$/u)
      }).pipe(Effect.scoped),
  )

  it.live(
    'refuses every run, saying why, where an agent’s part is missing',
    () =>
      Effect.gen(function* () {
        const extension = NodePath.join(places.root, 'no-extension.js')
        const { command } = yield* runEngine({
          agents: {
            node: process.execPath,
            cli: places.stub,
            extension,
          },
        })
        const { exit, err } = yield* command('run')
        expect(exitCodeOf(exit)).toBe(2)
        expect(err.join('\n')).toContain(
          `this engine can't run a project: the first-party extension (in a checkout, \`pnpm build\` builds it) isn't at ${extension}`,
        )
      }).pipe(Effect.scoped),
  )

  it.live(
    'refuses every run, saying why, where the secret store can’t open',
    () =>
      Effect.gen(function* () {
        const failed = new Secrets.PassphraseNeeded({
          path: NodePath.join(places.root, 'credentials.enc'),
        })
        const { command } = yield* runEngine({
          secrets: Layer.effect(Secrets.Secrets, Effect.fail(failed)),
        })
        const { exit, err } = yield* command('run')
        expect(exitCodeOf(exit)).toBe(2)
        expect(err.join('\n')).toContain(
          `this engine can't run a project: ${failed.message}`,
        )
      }).pipe(Effect.scoped),
  )

  it.live(
    'gives each worker its share of the cores under the machine budget, at worker_nice',
    () =>
      Effect.gen(function* () {
        const shares = [
          { settings: {}, cores: 2, nice: 10 },
          {
            settings: { machine_workers: 3, worker_nice: 5 },
            cores: 2,
            nice: 5,
          },
          { settings: { machine_workers: 16 }, cores: 1, nice: 10 },
        ]
        for (const { settings, cores, nice } of shares) {
          const paths = yield* newPaths
          const config = yield* scriptedConfig(paths)
          const services = yield* Layer.build(
            runHosting(config).pipe(
              Layer.provide(yield* hostingNeeds(paths, settings)),
            ),
          )
          const hosting = Context.get(services, Run.RunHosting)
          if (!Run.RunHostingShape.$is('Ready')(hosting))
            return yield* Effect.die(hosting.reason)
          expect(hosting.cores).toBe(cores)
          expect(hosting.nice).toStrictEqual(Option.some(nice))
          expect(hosting.sockets).toBe(NodePath.join(paths.socketFolder, 'c'))
        }
      }).pipe(Effect.scoped),
  )
})
