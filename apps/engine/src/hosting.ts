import { DateTime, Duration, Effect, Layer, Option } from 'effect'
import { access, constants } from 'node:fs/promises'
import * as NodePath from 'node:path'

import {
  PermissionDecision,
  type Permissions,
  coresShare,
} from '@fabrica/contracts'
import {
  Agent,
  Checks,
  Control,
  Daemon,
  Git,
  Merge,
  Process,
  Projects,
  Proxy,
  Run,
  Secrets,
  type SleepCauses,
  layerWake,
  sleepCausesFor,
} from '@fabrica/engine'

import { DISTRIBUTION_LAYOUT } from './layout'

// The engine's run hosting (spec §7.3, §12, §13, §20.3): what `fabrica serve` gives the daemon for its
// runs. The agents are Pi in RPC mode on the distribution's Node, with the first-party extension, or a
// dev checkout's; they reach their models through the model proxy, which sends each provider's calls
// on with the credential in the engine's secret store. Processes run on the host, their time limits
// counted in time awake; the run's records are dated in the host's zone; each worker and check gets
// its share of the cores under the machine budget, and the workers run at `worker_nice`. Both are read
// from the engine's settings as it starts. Where the agents' parts are missing, or the secret store
// or the model proxy can't open, the engine refuses every run, saying why.

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
  /** The engine's environment, for the FABRICA_ variables of settings (§13.13). */
  readonly environment: Readonly<Record<string, string | undefined>>
  /** The process runner, on the deadlines the hosting gives it. */
  readonly runner: Layer.Layer<Process.ProcessRunner, never, Process.Deadlines>
  /** What the host logs of its sleeps, for time awake. */
  readonly sleepCauses: Layer.Layer<SleepCauses>
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
  /** The zone the runs' records are dated in. */
  readonly zone: Layer.Layer<DateTime.CurrentTimeZone>
}

/** The run hosting on this host: its processes, its sleep causes, its keyring, its zone and the known providers. */
export const onHost = (options: {
  readonly paths: Daemon.EnginePaths
  readonly cores: number
  readonly agents: AgentPlaces
  readonly environment: Readonly<Record<string, string | undefined>>
}): HostingConfig => ({
  ...options,
  runner: Process.layerHost,
  sleepCauses: sleepCausesFor(process.platform),
  // No passphrase is given yet: a host with no keyring has its runs refused, saying so.
  secrets: Secrets.layerHost({
    platform: process.platform,
    data: options.paths.data,
    passphrase: Option.none(),
  }),
  routes: Proxy.knownRoutes,
  zone: DateTime.layerCurrentZoneLocal,
})

/** The level a permission request is answered by, and how. */
const decisionAt = (level: Permissions, tool: string): PermissionDecision =>
  level === 'full'
    ? PermissionDecision.cases.allow_once.make({})
    : PermissionDecision.cases.refuse.make({
        note: Option.some(
          `permissions: ${level} asks the maintainer about this ${tool} call, and this engine can't ask yet: it refuses what it would ask about`,
        ),
      })

/**
 * The gate's permission requests, until the maintainer answers them (fab-mgi.4.16): each answered as
 * its project's `permissions` says. `full` allows the call; `workspace` and `ask`, which would ask the
 * maintainer, refuse it, as they do where the project's settings can't be read.
 */
export const permissionsAttention: Layer.Layer<
  Control.Attention,
  never,
  Projects.Projects
> = Layer.effect(
  Control.Attention,
  Effect.map(Projects.Projects, projects =>
    Control.Attention.of({
      permission: request =>
        projects.settings(request.project).pipe(
          Effect.map(settings =>
            decisionAt(settings.permissions, request.tool),
          ),
          Effect.catch(error =>
            Effect.succeed(
              PermissionDecision.cases.refuse.make({
                note: Option.some(
                  `the project's permissions couldn't be read, so this engine refuses what it would ask the maintainer about: ${error._tag === 'ProjectNotFound' ? 'the project is gone' : error.message}`,
                ),
              }),
            ),
          ),
        ),
    }),
  ),
)

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
      const refused = (why: string) =>
        Run.RunHostingShape.Refused({
          reason: `this engine can't run a project: ${why}`,
        })
      const missing = yield* missingPart(config.agents)
      if (Option.isSome(missing)) return refused(missing.value)
      const timing = Layer.provideMerge(
        Process.layerAwake,
        Layer.provide(layerWake, config.sleepCauses),
      )
      const runner = Layer.provideMerge(config.runner, timing)
      const proxy = Proxy.layer({ routes: config.routes }).pipe(
        Layer.provide(Layer.merge(config.secrets, Proxy.layerOpen)),
      )
      return yield* Layer.build(
        Layer.mergeAll(
          Checks.layer,
          Git.worktreesLayer,
          permissionsAttention,
          // The project's setup in a merge's worktree is fab-mgi.4.5's: until then nothing runs.
          Merge.noSetup,
          Agent.layer({
            ...config.agents,
            data: config.paths.data,
            configRoot: NodePath.join(config.paths.data, 'agents'),
            limits: Agent.DEFAULT_LIMITS,
            reaperPoll: REAPER_POLL,
            reaperGrace: REAPER_GRACE,
          }),
          proxy,
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
            environment: config.environment,
          }),
        ),
        Effect.catch(error => Effect.succeed(refused(error.message))),
      )
    }).pipe(
      Effect.tap(hosting =>
        Run.RunHostingShape.$is('Refused')(hosting)
          ? Effect.logWarning(hosting.reason)
          : Effect.void,
      ),
    ),
  )
