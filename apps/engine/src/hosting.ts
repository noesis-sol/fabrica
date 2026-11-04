import {
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Result,
} from 'effect'
import { access, constants, readFile } from 'node:fs/promises'
import { getPriority } from 'node:os'
import * as NodePath from 'node:path'

import {
  ReleaseVersion,
  coresShare,
  machineWorkersOf,
} from '@fabrica/contracts'
import {
  Agent,
  type Battery,
  Checks,
  Daemon,
  Git,
  type KeepAwakeHost,
  Process,
  Proxy,
  Run,
  Secrets,
  type SleepCauses,
  Update,
  batteryFor,
  hostKeepAwake,
  layerWake,
  sleepCausesFor,
} from '@fabrica/engine'

import { DISTRIBUTION_LAYOUT } from './layout'

// The engine's run hosting (spec §7.3, §12, §13, §20.3): what `fabrica serve` gives the daemon for its
// runs. The agents are Pi in RPC mode on the distribution's Node, with the first-party extension, or a
// dev checkout's; they reach their models through the model proxy, which sends each provider's calls
// on with the credential in the engine's secret store. Processes run on the host, their time limits
// counted in time awake; the host is kept from idle sleep while a run goes, and its battery watched;
// the run's records are dated in the host's zone; each worker and check gets its share of the cores
// from the machine budget, which the daemon gives its runs, and the workers run at `worker_nice`. Both are read from the engine's
// settings as it starts. Where the agents' parts are missing, or the secret store
// or the model proxy can't open, the engine refuses every run, saying why. The secret store opens first,
// and the Secrets group's credentials are kept on it whatever else this host lacks.

/** Where an agent's parts are. */
export interface AgentPlaces {
  /** The Node that runs Pi and the reapers. */
  readonly node: string
  /** Pi's CLI script. */
  readonly cli: string
  /** The first-party extension. */
  readonly extension: string
}

/**
 * The agents' parts for the engine running from `self`: the distribution's, where `self` is its
 * bundle; else a dev checkout's, where `self` is in `apps/engine/src` or `apps/engine/dist`, with
 * node_modules' Pi, the built extension and the Node running the engine (`node`).
 */
export const agentPlaces = ({
  self,
  node,
}: {
  readonly self: string
  readonly node: string
}): AgentPlaces => {
  const root = NodePath.resolve(NodePath.dirname(self), '..', '..')
  if (NodePath.join(root, DISTRIBUTION_LAYOUT.bundle) === self)
    return {
      node: NodePath.join(root, DISTRIBUTION_LAYOUT.node),
      cli: NodePath.join(root, DISTRIBUTION_LAYOUT.piCli),
      extension: NodePath.join(root, DISTRIBUTION_LAYOUT.extension),
    }
  const app = NodePath.resolve(NodePath.dirname(self), '..')
  return {
    node,
    // Pi's CLI lies in `apps/engine`'s node_modules as in the distribution's Pi folder.
    cli: NodePath.join(
      app,
      NodePath.relative(
        DISTRIBUTION_LAYOUT.piFolder,
        DISTRIBUTION_LAYOUT.piCli,
      ),
    ),
    extension: NodePath.join(
      app,
      '..',
      '..',
      'packages',
      'pi-extension',
      'dist',
      'index.js',
    ),
  }
}

/**
 * The Linux distribution a project's containers mount (spec §12.7): the engine's own on Linux, or one
 * a macOS engine fetches once under its data folder. An engine run from a checkout has neither.
 */
export const linuxDistribution = ({
  self,
  data,
  release,
  platform,
  arch,
}: {
  /** The engine's own bundle. */
  readonly self: string
  readonly data: string
  readonly release: string
  readonly platform: string
  readonly arch: string
}): Effect.Effect<Agent.LinuxDistribution, string> =>
  Effect.gen(function* () {
    const root = NodePath.resolve(NodePath.dirname(self), '..', '..')
    if (NodePath.join(root, DISTRIBUTION_LAYOUT.bundle) !== self)
      return yield* Effect.fail(
        'this engine runs from a checkout, not a distribution',
      )
    const parts = {
      node: DISTRIBUTION_LAYOUT.node,
      cli: DISTRIBUTION_LAYOUT.piCli,
      extension: DISTRIBUTION_LAYOUT.extension,
    }
    if (platform === 'linux') return { root, ...parts }
    const target = Update.targetOf({ platform: 'linux', arch })
    const version = ReleaseVersion.makeOption(release)
    if (Option.isNone(target) || Option.isNone(version))
      return yield* Effect.fail(
        `there is no Linux distribution of ${release} for ${arch}`,
      )
    const fetched = yield* Update.fetchDistributionHost({
      target: target.value,
      version: version.value,
      folder: NodePath.join(data, 'distributions'),
    }).pipe(Effect.mapError(Update.describeFailure))
    return { root: fetched, ...parts }
  })

/** The first of the agents' parts that isn't there, said as why the engine can't run a project. */
const missingPart = (
  places: AgentPlaces,
): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    const parts = [
      { path: places.node, what: 'the Node that runs its agents' },
      { path: places.cli, what: "Pi's CLI" },
      {
        path: places.extension,
        what: 'the first-party extension (in a checkout, `pnpm build` builds it)',
      },
    ]
    for (const { path, what } of parts) {
      const there = yield* Effect.tryPromise(() =>
        access(path, constants.R_OK),
      ).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      )
      if (!there) return Option.some(`${what} isn't at ${path}`)
    }
    return Option.none()
  })

/** What the run hosting is built from: the engine's places and the host's boundaries. */
export interface HostingConfig {
  /** The engine's files: its data folder, and the folder its socket is in. */
  readonly paths: Daemon.EnginePaths
  /** The host's cores. */
  readonly cores: number
  readonly agents: AgentPlaces
  /** The process runner, on the deadlines the hosting gives it. */
  readonly runner: Layer.Layer<Process.ProcessRunner, never, Process.Deadlines>
  /** What the host logs of its sleeps, for time awake. */
  readonly sleepCauses: Layer.Layer<SleepCauses>
  /** The host's battery, read by the process runner, which runs watch (§7.7). */
  readonly battery: Layer.Layer<Battery, never, Process.ProcessRunner>
  /** The engine's host, which its runs keep from idle sleep (§7.7). */
  readonly keepAwakeHost: KeepAwakeHost
  /** The engine's secret store, its keyring CLIs and key commands run by the process runner. */
  readonly secrets: Layer.Layer<
    Secrets.Secrets,
    | Secrets.PassphraseNeeded
    | Secrets.PassphraseRefused
    | Secrets.SecretStoreFailed,
    Process.ProcessRunner
  >
  /** Where the model proxy sends each provider's calls. */
  readonly routes: ReadonlyArray<Proxy.ProviderRoute>
  /** The providers subscriptions are signed in to; `pi-ai`'s where none are given. */
  readonly signIns?: Run.EngineCredentials['providers']
  /** The zone the runs' records are dated in. */
  readonly zone: Layer.Layer<DateTime.CurrentTimeZone>
  /** The host's facts for a project's containers, with the machine's memory for a worker's share of it. */
  readonly containers?: Omit<Agent.ContainerHost, 'memory'> & {
    readonly totalMemory: number
  }
}

/**
 * The run hosting on this host: its processes, its sleep causes, its battery, keeping it awake, its
 * keyring, its zone and the known providers.
 */
export const onHost = ({
  passphrase,
  ...options
}: {
  readonly paths: Daemon.EnginePaths
  readonly cores: number
  readonly agents: AgentPlaces
  /** The encrypted file's passphrase, where no keyring answers: none has a host with no keyring refuse its runs. */
  readonly passphrase: Option.Option<Secrets.PassphraseSource>
  /** The engine's own bundle and release, and the machine's memory, for a project's containers (§12.7). */
  readonly self: string
  readonly release: string
  readonly totalMemory: number
}): HostingConfig => ({
  paths: options.paths,
  cores: options.cores,
  agents: options.agents,
  runner: Process.layerHost,
  sleepCauses: sleepCausesFor(process.platform),
  battery: batteryFor(process.platform),
  keepAwakeHost: hostKeepAwake(),
  secrets: Secrets.layerHost({
    platform: process.platform,
    data: options.paths.data,
    passphrase,
  }),
  routes: Proxy.knownRoutes,
  zone: DateTime.layerCurrentZoneLocal,
  containers: {
    platform: process.platform,
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    enginePriority: getPriority(),
    totalMemory: options.totalMemory,
    environment: Process.commandEnvironment({ host: process.env, extra: {} }),
    distribution: linuxDistribution({
      self: options.self,
      data: options.paths.data,
      release: options.release,
      platform: process.platform,
      arch: process.arch,
    }),
    readFile: path =>
      Effect.tryPromise(() => readFile(path, 'utf8')).pipe(Effect.option),
  },
})

/** How often a worker's reaper lists its tree, and how long a terminated tree has before it is killed. */
const REAPER_POLL = Duration.seconds(1)
const REAPER_GRACE = Duration.seconds(5)

/**
 * The run hosting `config` gives, on the daemon's projects and its Git and the engine's settings as it
 * starts; refused, saying why, where the agents' parts are missing or the secret store or the model
 * proxy can't open.
 */
export const runHosting = (
  config: HostingConfig,
): Layer.Layer<Run.RunHosting, never, Daemon.RunHostingNeeds> =>
  Layer.effect(
    Run.RunHosting,
    Effect.gen(function* () {
      const [settings, git] = yield* Effect.all([
        Daemon.StartingSettings,
        Git.Git,
      ])
      const refused = (why: string, credentials?: Run.EngineCredentials) =>
        Run.RunHostingShape.Refused({
          reason: `this engine can't run a project: ${why}`,
          ...(credentials === undefined ? {} : { credentials }),
        })
      const missing = yield* missingPart(config.agents)
      const timing = Layer.provideMerge(
        Process.layerAwake,
        Layer.provide(layerWake, config.sleepCauses),
      )
      const runner = Layer.succeedContext(
        yield* Layer.build(Layer.provideMerge(config.runner, timing)),
      )
      // The store opens whatever else this host lacks: the Secrets group works on it either way.
      const opened = yield* Layer.build(
        Layer.provide(config.secrets, runner),
      ).pipe(Effect.result)
      const signIns = config.signIns ?? Proxy.subscriptionProviders()
      const credentials = Result.isSuccess(opened)
        ? {
            secrets: Context.get(opened.success, Secrets.Secrets),
            providers: signIns,
          }
        : undefined
      if (Option.isSome(missing)) return refused(missing.value, credentials)
      if (Result.isFailure(opened)) return refused(opened.failure.message)
      const proxy = Proxy.layer({
        routes: config.routes,
        providers: signIns,
      }).pipe(
        Layer.provide(Layer.succeedContext(opened.success)),
        Layer.provideMerge(Proxy.layerHeld),
      )
      return yield* Layer.build(
        Layer.mergeAll(
          Checks.layer,
          Git.worktreesLayer,
          Agent.layer({
            ...config.agents,
            data: config.paths.data,
            configRoot: NodePath.join(config.paths.data, 'agents'),
            limits: Agent.DEFAULT_LIMITS,
            reaperPoll: REAPER_POLL,
            reaperGrace: REAPER_GRACE,
          }),
          proxy,
          config.battery,
          config.zone,
        ).pipe(
          Layer.provideMerge(runner),
          Layer.provideMerge(Layer.succeed(Git.Git)(git)),
        ),
      ).pipe(
        Effect.map(services =>
          Run.RunHostingShape.Ready({
            services,
            // Short, so a control socket's path stays under the 103 bytes every platform takes.
            sockets: NodePath.join(config.paths.socketFolder, 'c'),
            cores: coresShare(settings, config.cores),
            nice: Option.some(settings.worker_nice),
            keepAwakeHost: config.keepAwakeHost,
            ...(credentials === undefined ? {} : { credentials }),
            ...(config.containers === undefined
              ? {}
              : {
                  containers: {
                    ...config.containers,
                    memory: Math.floor(
                      config.containers.totalMemory /
                        machineWorkersOf(settings, config.cores),
                    ),
                  },
                }),
          }),
        ),
        Effect.catch(error =>
          Effect.succeed(refused(error.message, credentials)),
        ),
      )
    }).pipe(
      Effect.tap(hosting =>
        Run.RunHostingShape.$is('Refused')(hosting)
          ? Effect.logWarning(hosting.reason)
          : Effect.void,
      ),
    ),
  )
