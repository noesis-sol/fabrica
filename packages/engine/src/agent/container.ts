import { Data, Duration, Effect, Option, Result, Schema } from 'effect'
import { createHash } from 'node:crypto'
import * as NodePath from 'node:path'

import type {
  Container,
  ContainerRuntime,
  ProjectId,
  TicketId,
} from '@fabrica/contracts'
import { ContainerSource } from '@fabrica/contracts'

import { ProcessRunner, commandSucceeded } from '../process'

// A worker's container (spec §12.7, H16, H36; the spike fab-mgi.2.8 and its answers fab-mgi.60, .61,
// .62): Docker or Podman through the Docker-compatible CLI, the one module that knows its arguments.
// A run's start finds the runtime, reads a devcontainer file, refuses a host that can't hold the
// limits, and pulls or builds the image (`prepareContainers`); each agent then gets a container of its
// own (`startContainer`), kept alive by the mounted Node, Pi started in it with `exec`, and removed
// with the agent's scope. Mounts keep their host paths wherever nothing asks otherwise, so the paths
// the engine and the agent tell each other (a session file, a check's log, the worktree's git folder)
// need no translating. Values reach a container by name (`-e NAME`), from the CLI's own environment,
// so a token is never on a process list.

/** Where the Linux engine distribution is mounted in a container. */
export const DISTRIBUTION_TARGET = '/opt/fabrica'

/** The address Podman Machine's gvproxy maps to the Mac's loopback (fab-mgi.61). */
export const PODMAN_MACHINE_HOST = '192.168.127.254'

/** The name Docker Desktop's vpnkit proxies to the Mac's loopback (fab-mgi.2.8). */
export const DOCKER_DESKTOP_HOST = 'host.docker.internal'

const CHECK_LIMIT = Duration.seconds(30)
const IMAGE_LIMIT = Duration.minutes(30)
const RUN_LIMIT = Duration.minutes(5)
const REMOVE_LIMIT = Duration.seconds(30)
const LIFECYCLE_LIMIT = Duration.minutes(30)

/** Where a runtime's containers run, which decides how they reach the host and whose files they write. */
export type RuntimePlacement = Data.TaggedEnum<{
  DockerDesktop: {}
  /** Rootless by default; `podman machine set --rootful` makes its containers root's. */
  PodmanMachine: { readonly rootless: boolean }
  RootlessLinux: { readonly runtime: ContainerRuntime }
  RootfulLinux: { readonly runtime: ContainerRuntime }
}>
export const RuntimePlacement = Data.taggedEnum<RuntimePlacement>()

/** The CLI a placement is driven through. */
export const runtimeOf: (placement: RuntimePlacement) => ContainerRuntime =
  RuntimePlacement.$match({
    DockerDesktop: () => 'docker' as const,
    PodmanMachine: () => 'podman' as const,
    RootlessLinux: ({ runtime }) => runtime,
    RootfulLinux: ({ runtime }) => runtime,
  })

/**
 * Where a container reaches the host's loopback listeners; none on Linux, where a runtime's bridge
 * never reaches the host's 127.0.0.1 and a mounted socket always connects (fab-mgi.60).
 */
export const hostAddressOf: (
  placement: RuntimePlacement,
) => Option.Option<string> = RuntimePlacement.$match({
  DockerDesktop: () => Option.some(DOCKER_DESKTOP_HOST),
  PodmanMachine: () => Option.some(PODMAN_MACHINE_HOST),
  RootlessLinux: () => Option.none(),
  RootfulLinux: () => Option.none(),
})

/** Where the control channel is reached over TCP: only where a mounted socket can't be connected (fab-mgi.61). */
export const controlAddressOf: (
  placement: RuntimePlacement,
) => Option.Option<string> = RuntimePlacement.$match({
  DockerDesktop: () => Option.none(),
  PodmanMachine: () => Option.some(PODMAN_MACHINE_HOST),
  RootlessLinux: () => Option.none(),
  RootfulLinux: () => Option.none(),
})

/** A base URL at the proxy's loopback address, as `host` reaches it. */
export const reachedAt = (baseUrl: string, host: string): string => {
  const url = new URL(baseUrl)
  url.hostname = host
  return url.toString().replace(/\/$/u, '')
}

/** The runtimes in the order they are tried where the settings name none. */
const RUNTIMES: ReadonlyArray<ContainerRuntime> = ['docker', 'podman']

/** `<cli> info --format json`, as far as it is read: Docker's fields and Podman's. */
const RuntimeInfo = Schema.fromJsonString(
  Schema.Struct({
    SecurityOptions: Schema.optional(Schema.Array(Schema.String)),
    host: Schema.optional(
      Schema.Struct({
        security: Schema.optional(
          Schema.Struct({ rootless: Schema.optional(Schema.Boolean) }),
        ),
      }),
    ),
  }),
)

/** Where the runtime that wrote `info` runs; none where it answered without its daemon. */
export const placementOf = ({
  runtime,
  platform,
  info,
}: {
  readonly runtime: ContainerRuntime
  readonly platform: string
  readonly info: string
}): Option.Option<RuntimePlacement> =>
  Option.flatMap(Schema.decodeUnknownOption(RuntimeInfo)(info), read => {
    const rootless =
      runtime === 'docker'
        ? Option.map(Option.fromUndefinedOr(read.SecurityOptions), options =>
            options.some(option => option.split(',').includes('name=rootless')),
          )
        : Option.map(
            Option.fromUndefinedOr(read.host?.security),
            security => security.rootless === true,
          )
    return Option.map(rootless, isRootless => {
      if (platform === 'darwin')
        return runtime === 'docker'
          ? RuntimePlacement.DockerDesktop()
          : RuntimePlacement.PodmanMachine({ rootless: isRootless })
      return isRootless
        ? RuntimePlacement.RootlessLinux({ runtime })
        : RuntimePlacement.RootfulLinux({ runtime })
    })
  })

/** A runtime chosen, and what is to be said of the choice; or why there is none. */
export type RuntimeChoice = Data.TaggedEnum<{
  Chosen: {
    readonly placement: RuntimePlacement
    readonly notices: ReadonlyArray<string>
  }
  Refused: { readonly problem: string }
}>
export const RuntimeChoice = Data.taggedEnum<RuntimeChoice>()

/**
 * The runtime `wanted` names, or whichever is present, a rootless one before a rootful one (H36); a
 * notice says when only a rootful daemon is found.
 */
export const chooseRuntime = Effect.fn('Container.chooseRuntime')(function* ({
  wanted,
  platform,
  cwd,
}: {
  readonly wanted: Option.Option<ContainerRuntime>
  readonly platform: string
  readonly cwd: string
}) {
  const runner = yield* ProcessRunner
  const names = Option.match(wanted, {
    onNone: () => RUNTIMES,
    onSome: name => [name],
  })
  const probes = yield* Effect.forEach(
    names,
    runtime =>
      Effect.map(
        runner.run({
          command: runtime,
          args: ['info', '--format', 'json'],
          cwd,
          containerRuntime: true,
          timeLimit: CHECK_LIMIT,
        }),
        (outcome): Result.Result<RuntimePlacement, string> =>
          Result.match(commandSucceeded(outcome), {
            onFailure: why => Result.fail(`${runtime}: ${why}`),
            onSuccess: info =>
              Option.match(placementOf({ runtime, platform, info }), {
                onNone: () =>
                  Result.fail(`${runtime}: its daemon didn't answer`),
                onSome: placement => Result.succeed(placement),
              }),
          }),
      ),
    { concurrency: 'unbounded' },
  )
  const placed = probes.flatMap(probe =>
    Result.isSuccess(probe) ? [probe.success] : [],
  )
  const preferred = placed.find(
    placement => !RuntimePlacement.$is('RootfulLinux')(placement),
  )
  if (preferred !== undefined)
    return RuntimeChoice.Chosen({ placement: preferred, notices: [] })
  const [rootful] = placed
  if (rootful !== undefined)
    return RuntimeChoice.Chosen({
      placement: rootful,
      notices: [
        `only a rootful ${runtimeOf(rootful)} daemon was found; a rootless runtime is preferred (§12.7)`,
      ],
    })
  const why = probes.flatMap(probe =>
    Result.isFailure(probe) ? [probe.failure] : [],
  )
  return RuntimeChoice.Refused({
    problem: `the project's container needs ${names.join(' or ')}, and none answered: ${why.join('; ')}`,
  })
})

/** The file rootless limits are read from: the controllers delegated to the user's slice. */
export const delegationFile = (uid: number): string =>
  `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`

/**
 * Whether a rootless host can hold a container's CPU limit (fab-mgi.62); a problem naming the one-time
 * root step where its user slice lacks the cpu controller, or where it has no cgroup v2 slice at all.
 */
export const delegationProblem = ({
  controllers,
}: {
  readonly controllers: Option.Option<string>
}): Option.Option<string> =>
  Option.match(controllers, {
    onSome: text =>
      text.split(/\s+/u).includes('cpu')
        ? Option.none()
        : Option.some(
            'this rootless host delegates no cpu controller to its user, so a container\'s CPU limit can\'t hold: as root, once, write "[Service]\\nDelegate=cpu cpuset io memory pids" to /etc/systemd/system/user@.service.d/delegate.conf and run `systemctl daemon-reload`',
          ),
    onNone: () =>
      Option.some(
        "this rootless host has no cgroup v2 user slice, so a container's limits can't hold: it needs cgroup v2 and systemd, with Delegate=cpu cpuset io memory pids in /etc/systemd/system/user@.service.d/delegate.conf (a one-time root step)",
      ),
  })

/** What a devcontainer file's lifecycle commands may be: run by /bin/sh, an argument list, or named. */
const LifecycleCommand = Schema.Union([
  Schema.String,
  Schema.Array(Schema.String),
  Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  ),
])
type LifecycleCommand = typeof LifecycleCommand.Type

/** The devcontainer properties the engine honours (fab-mgi.2.8). */
const DevcontainerFile = Schema.Struct({
  image: Schema.optional(Schema.String),
  build: Schema.optional(
    Schema.Struct({
      dockerfile: Schema.optional(Schema.String),
      context: Schema.optional(Schema.String),
      args: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      target: Schema.optional(Schema.String),
    }),
  ),
  containerEnv: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  remoteEnv: Schema.optional(
    Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
  ),
  containerUser: Schema.optional(Schema.String),
  remoteUser: Schema.optional(Schema.String),
  workspaceFolder: Schema.optional(Schema.String),
  init: Schema.optional(Schema.Boolean),
  onCreateCommand: Schema.optional(LifecycleCommand),
  updateContentCommand: Schema.optional(LifecycleCommand),
  postCreateCommand: Schema.optional(LifecycleCommand),
  postStartCommand: Schema.optional(LifecycleCommand),
})

/** What isn't honoured, with why, for a notice (fab-mgi.2.8). */
const NOT_HONOURED: ReadonlyArray<readonly [ReadonlyArray<string>, string]> = [
  [
    ['initializeCommand'],
    'it would run on the host, outside the container and the gate',
  ],
  [
    ['features', 'overrideFeatureInstallOrder'],
    'build an image with them instead',
  ],
  [['dockerComposeFile', 'service', 'runServices'], "Compose isn't driven"],
  [
    [
      'runArgs',
      'mounts',
      'workspaceMount',
      'privileged',
      'capAdd',
      'securityOpt',
      'appPort',
    ],
    'the engine owns the run arguments',
  ],
  [['overrideCommand'], 'the engine keeps the container alive itself'],
  [['waitFor'], 'the engine waits for all its commands'],
  [['postAttachCommand'], 'nothing attaches'],
  [['updateRemoteUserUID'], 'the engine maps user IDs'],
  [
    [
      'forwardPorts',
      'portsAttributes',
      'otherPortsAttributes',
      'shutdownAction',
      'userEnvProbe',
      'customizations',
      'name',
    ],
    'a worker has no use for it',
  ],
]

/** JSON with comments and trailing commas, as a devcontainer file is written, made plain JSON. */
export const plainJson = (text: string): string => {
  let out = ''
  let inString = false
  for (let at = 0; at < text.length; at++) {
    const char = text[at]
    if (inString) {
      out += char
      if (char === '\\') out += text[++at] ?? ''
      else if (char === '"') inString = false
    } else if (char === '"') {
      inString = true
      out += char
    } else if (char === '/' && text[at + 1] === '/') {
      while (at < text.length && text[at] !== '\n') at++
      out += '\n'
    } else if (char === '/' && text[at + 1] === '*') {
      const end = text.indexOf('*/', at + 2)
      at = end === -1 ? text.length : end + 1
    } else if (char === ',') {
      const rest = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/u.exec(
        text.slice(at + 1),
      )
      const next = text[at + 1 + (rest?.[0].length ?? 0)]
      if (next !== '}' && next !== ']') out += char
    } else out += char
  }
  return out
}

/** One lifecycle step's commands, each an argument list, which run side by side. */
export type LifecycleStep = ReadonlyArray<ReadonlyArray<string>>

const argumentsOf = (command: string | ReadonlyArray<string>) =>
  typeof command === 'string' ? ['/bin/sh', '-c', command] : command

const isOneCommand = Schema.is(
  Schema.Union([Schema.String, Schema.Array(Schema.String)]),
)

const stepOf = (command: LifecycleCommand): LifecycleStep =>
  isOneCommand(command)
    ? [argumentsOf(command)]
    : Object.values(command).map(argumentsOf)

/** What a devcontainer file asks of each container; nothing, for an image. */
export interface ContainerSetup {
  /** Stands for `${devcontainerId}`. */
  readonly id: string
  readonly containerEnv: Readonly<Record<string, string>>
  readonly remoteEnv: Readonly<Record<string, string>>
  readonly containerUser: Option.Option<string>
  readonly remoteUser: Option.Option<string>
  readonly workspaceFolder: Option.Option<string>
  readonly init: boolean
  /** In the spec's order; a failure skips the rest and is a setup failure. */
  readonly lifecycle: ReadonlyArray<LifecycleStep>
}

const NO_SETUP: ContainerSetup = {
  id: '',
  containerEnv: {},
  remoteEnv: {},
  containerUser: Option.none(),
  remoteUser: Option.none(),
  workspaceFolder: Option.none(),
  init: false,
  lifecycle: [],
}

/** Where an image comes from: a name to pull, or a Dockerfile to build. */
export type ImageSource = Data.TaggedEnum<{
  Pull: { readonly image: string }
  Build: {
    readonly tag: string
    readonly dockerfile: string
    readonly context: string
    readonly args: Readonly<Record<string, string>>
    readonly target: Option.Option<string>
  }
}>
export const ImageSource = Data.taggedEnum<ImageSource>()

/** A devcontainer file read, or what is wrong with it. */
export const readDevcontainer = ({
  text,
  file,
  project,
}: {
  readonly text: string
  /** Its absolute path, which build paths are relative to. */
  readonly file: string
  readonly project: ProjectId
}): Result.Result<
  {
    readonly source: ImageSource
    readonly setup: ContainerSetup
    readonly notices: ReadonlyArray<string>
  },
  string
> => {
  const parsed = Result.try({
    try: (): unknown => JSON.parse(plainJson(text)),
    catch: error => (error instanceof Error ? error.message : String(error)),
  })
  if (Result.isFailure(parsed))
    return Result.fail(`${file} isn't JSON: ${parsed.failure}`)
  const decoded = Schema.decodeUnknownOption(DevcontainerFile)(parsed.success)
  if (Option.isNone(decoded))
    return Result.fail(`${file} has a property of the wrong kind`)
  const read = decoded.value
  const folder = NodePath.dirname(file)
  const id = createHash('sha256')
    .update(`${project}\0${file}`)
    .digest('hex')
    .slice(0, 12)
  const source: Option.Option<ImageSource> =
    read.image !== undefined
      ? Option.some(ImageSource.Pull({ image: read.image }))
      : read.build?.dockerfile !== undefined
        ? Option.some(
            ImageSource.Build({
              tag: `fabrica-devcontainer-${id}`,
              dockerfile: NodePath.resolve(folder, read.build.dockerfile),
              context: NodePath.resolve(folder, read.build.context ?? '.'),
              args: read.build.args ?? {},
              target: Option.fromUndefinedOr(read.build.target),
            }),
          )
        : Option.none()
  if (Option.isNone(source))
    return Result.fail(
      `${file} names neither an image nor a build's dockerfile`,
    )
  const given =
    typeof parsed.success === 'object' && parsed.success !== null
      ? Object.keys(parsed.success)
      : []
  return Result.succeed({
    source: source.value,
    setup: {
      id,
      containerEnv: read.containerEnv ?? {},
      remoteEnv: Object.fromEntries(
        Object.entries(read.remoteEnv ?? {}).flatMap(([name, value]) =>
          value === null ? [] : [[name, value]],
        ),
      ),
      containerUser: Option.fromUndefinedOr(read.containerUser),
      remoteUser: Option.fromUndefinedOr(read.remoteUser),
      workspaceFolder: Option.fromUndefinedOr(read.workspaceFolder),
      init: read.init === true,
      lifecycle: [
        read.onCreateCommand,
        read.updateContentCommand,
        read.postCreateCommand,
        read.postStartCommand,
      ].flatMap(command => (command === undefined ? [] : [stepOf(command)])),
    },
    notices: NOT_HONOURED.flatMap(([names, why]) => {
      const found = names.filter(name => given.includes(name))
      return found.length === 0
        ? []
        : [`the devcontainer file's ${found.join(', ')} isn't honoured: ${why}`]
    }),
  })
}

/** A devcontainer file's variables, given what stands for them (fab-mgi.2.8). */
export const substituted = (
  text: string,
  {
    local,
    container,
    id,
    environment,
    containerEnv,
  }: {
    readonly local: string
    readonly container: string
    readonly id: string
    /** The engine's allowlisted environment, never its own (§20.2). */
    readonly environment: Readonly<Record<string, string | undefined>>
    readonly containerEnv: Readonly<Record<string, string>>
  },
): string =>
  text.replace(/\$\{([^}]+)\}/gu, (whole, name: string) => {
    const [kind, variable, fallback] = name.split(':')
    if (kind === 'localEnv' && variable !== undefined)
      return environment[variable] ?? fallback ?? ''
    if (kind === 'containerEnv' && variable !== undefined)
      return containerEnv[variable] ?? fallback ?? ''
    switch (name) {
      case 'localWorkspaceFolder':
        return local
      case 'localWorkspaceFolderBasename':
        return NodePath.basename(local)
      case 'containerWorkspaceFolder':
        return container
      case 'containerWorkspaceFolderBasename':
        return NodePath.posix.basename(container)
      case 'devcontainerId':
        return id
      default:
        return whole
    }
  })

/** The Linux engine distribution: its folder and its parts' paths relative to it. */
export interface LinuxDistribution {
  readonly root: string
  readonly node: string
  readonly cli: string
  readonly extension: string
}

/** The facts about its host the containers work from, read once where the engine starts. */
export interface ContainerHost {
  /** As Node names it: `darwin`, `linux`. */
  readonly platform: string
  readonly uid: number
  readonly gid: number
  /** A worker's share of the machine's memory, in bytes (§7.3). */
  readonly memory: number
  /** The engine's allowlisted environment (§20.2), which `${localEnv:…}` reads. */
  readonly environment: Readonly<Record<string, string | undefined>>
  /** The Linux distribution, a macOS engine fetching it once; or why there is none. */
  readonly distribution: Effect.Effect<LinuxDistribution, string>
  /** A file's text; none where it can't be read. */
  readonly readFile: (path: string) => Effect.Effect<Option.Option<string>>
}

/** What each of a run's containers is made from, found by its start. */
export interface PreparedContainers {
  readonly placement: RuntimePlacement
  readonly image: string
  readonly setup: ContainerSetup
  /** In bytes. */
  readonly memory: number
  readonly cpus: number
  readonly network: Option.Option<string>
  readonly distribution: LinuxDistribution
  readonly uid: number
  readonly gid: number
  readonly environment: Readonly<Record<string, string | undefined>>
  /** What the start says of them. */
  readonly notices: ReadonlyArray<string>
}

/** What keeps a run with a `container` from starting; every problem listed. */
export class ContainerProblems extends Data.TaggedError('ContainerProblems')<{
  readonly problems: ReadonlyArray<string>
}> {
  override get message() {
    return this.problems.join('; ')
  }
}

const NO_NOTICES: ReadonlyArray<string> = []

const refuse = (...problems: ReadonlyArray<string>) =>
  new ContainerProblems({ problems })

/** An image pulled, one the host already holds serving where the pull fails; or built. */
const fetchImage = Effect.fn('Container.fetchImage')(function* ({
  runtime,
  source,
  cwd,
}: {
  readonly runtime: ContainerRuntime
  readonly source: ImageSource
  readonly cwd: string
}) {
  const runner = yield* ProcessRunner
  const run = (args: ReadonlyArray<string>, timeLimit: Duration.Duration) =>
    Effect.map(
      runner.run({
        command: runtime,
        args,
        cwd,
        containerRuntime: true,
        timeLimit,
      }),
      commandSucceeded,
    )
  return yield* ImageSource.$match(source, {
    Pull: ({ image }) =>
      Effect.gen(function* () {
        const pulled = yield* run(['pull', image], IMAGE_LIMIT)
        if (Result.isSuccess(pulled)) return { image, notices: NO_NOTICES }
        const held = yield* run(['image', 'inspect', image], CHECK_LIMIT)
        if (Result.isFailure(held))
          return yield* refuse(
            `the image ${image} couldn't be pulled: ${pulled.failure}`,
          )
        return {
          image,
          notices: [
            `the image ${image} couldn't be pulled, so the one this host holds is used: ${pulled.failure}`,
          ],
        }
      }),
    Build: ({ tag, dockerfile, context, args, target }) =>
      Effect.gen(function* () {
        const built = yield* run(
          [
            'build',
            '--tag',
            tag,
            '--file',
            dockerfile,
            ...Object.entries(args).flatMap(([name, value]) => [
              '--build-arg',
              `${name}=${value}`,
            ]),
            ...Option.match(target, {
              onNone: () => [],
              onSome: stage => ['--target', stage],
            }),
            context,
          ],
          IMAGE_LIMIT,
        )
        if (Result.isFailure(built))
          return yield* refuse(
            `the image of ${dockerfile} couldn't be built: ${built.failure}`,
          )
        return { image: tag, notices: NO_NOTICES }
      }),
  })
})

/**
 * What a run's containers are made from: the runtime chosen, a rootless host's limits checked, a
 * devcontainer file read, the Linux distribution at hand and the image pulled or built, all before the
 * run's first dispatch (§12.7).
 */
export const prepareContainers = Effect.fn('Container.prepare')(function* ({
  container,
  host,
  project,
  checkout,
  cores,
}: {
  readonly container: Container
  readonly host: ContainerHost
  readonly project: ProjectId
  readonly checkout: string
  /** A worker's share of the machine's cores. */
  readonly cores: number
}) {
  const choice = yield* chooseRuntime({
    wanted: container.runtime,
    platform: host.platform,
    cwd: checkout,
  })
  if (RuntimeChoice.$is('Refused')(choice)) return yield* refuse(choice.problem)
  const { placement } = choice
  const controllers = RuntimePlacement.$is('RootlessLinux')(placement)
    ? yield* host.readFile(delegationFile(host.uid))
    : Option.some('cpu')
  const read = yield* ContainerSource.match(container.source, {
    Image: ({ image }) =>
      Effect.succeed(
        Result.succeed({
          source: ImageSource.Pull({ image }),
          setup: NO_SETUP,
          notices: NO_NOTICES,
        }),
      ),
    Devcontainer: ({ file }) =>
      Effect.gen(function* () {
        const path = NodePath.resolve(checkout, file)
        const text = yield* host.readFile(path)
        return Option.match(text, {
          onNone: () =>
            Result.fail(`the devcontainer file ${file} can't be read`),
          onSome: text => readDevcontainer({ text, file: path, project }),
        })
      }),
  })
  const offline = Option.contains(container.network, 'none')
  const problems = [
    ...Option.toArray(delegationProblem({ controllers })),
    ...(Result.isFailure(read) ? [read.failure] : []),
    ...(offline && Option.isSome(hostAddressOf(placement))
      ? [
          "the container's network is none, and on this host a container reaches the model proxy only over its network",
        ]
      : []),
  ]
  if (problems.length > 0 || Result.isFailure(read))
    return yield* refuse(...problems)
  const source = ImageSource.$match(read.success.source, {
    Pull: pull => ImageSource.Pull(pull),
    Build: build =>
      ImageSource.Build({
        ...build,
        args: Object.fromEntries(
          Object.entries(build.args).map(([arg, value]) => [
            arg,
            substituted(value, {
              local: checkout,
              container: workspaceOf({
                worktree: checkout,
                prepared: {
                  setup: read.success.setup,
                  environment: host.environment,
                },
              }),
              id: read.success.setup.id,
              environment: host.environment,
              containerEnv: {},
            }),
          ]),
        ),
      }),
  })
  const [distribution, fetched] = yield* Effect.all(
    [
      Effect.mapError(host.distribution, why =>
        refuse(`the Linux engine distribution isn't at hand: ${why}`),
      ),
      fetchImage({
        runtime: runtimeOf(placement),
        source,
        cwd: checkout,
      }),
    ],
    { concurrency: 'unbounded' },
  )
  const prepared: PreparedContainers = {
    placement,
    image: fetched.image,
    setup: read.success.setup,
    memory: Option.getOrElse(container.memory, () => host.memory),
    cpus: Option.getOrElse(container.cpus, () => cores),
    network: container.network,
    distribution,
    uid: host.uid,
    gid: host.gid,
    environment: host.environment,
    notices: [...choice.notices, ...read.success.notices, ...fetched.notices],
  }
  return prepared
})

/** A folder or a socket mounted in a container. */
export interface Mount {
  readonly source: string
  readonly target: string
  readonly readOnly?: boolean
}

/** The same path inside as on the host. */
export const samePath = (source: string, readOnly = false): Mount => ({
  source,
  target: source,
  readOnly,
})

/** The short form: Docker Desktop shares a socket only through it (4.40's release notes). */
const mountArguments = ({ source, target, readOnly }: Mount) => [
  '--volume',
  `${source}:${target}${readOnly === true ? ':ro' : ''}`,
]

/** Each variable by name, its value from the CLI's own environment. */
const environmentArguments = (names: ReadonlyArray<string>) =>
  names.flatMap(name => ['--env', name])

/** The name a ticket's container goes by: one at a time, so a crash's leftover is found and removed. */
export const containerName = ({
  project,
  ticket,
}: {
  readonly project: ProjectId
  readonly ticket: TicketId
}): string => `fabrica-${project}-${ticket}`.replace(/[^a-zA-Z0-9_.-]/gu, '-')

/**
 * The folder a worktree is mounted at: the devcontainer file's `workspaceFolder`, else
 * `/workspaces/<its basename>`, as the Dev Container spec defaults it.
 */
export const workspaceOf = ({
  worktree,
  prepared: { setup, environment },
}: {
  readonly worktree: string
  readonly prepared: Pick<PreparedContainers, 'setup' | 'environment'>
}): string => {
  const standard = `/workspaces/${NodePath.basename(worktree)}`
  return Option.match(setup.workspaceFolder, {
    onNone: () => standard,
    onSome: folder =>
      substituted(folder, {
        local: worktree,
        container: standard,
        id: setup.id,
        environment,
        containerEnv: {},
      }),
  })
}

/** A part of the distribution, where it is mounted. */
const insideDistribution = (part: string) =>
  NodePath.posix.join(DISTRIBUTION_TARGET, part)

/** The agent's Node, Pi's CLI and the extension, as a container sees them. */
export const insideParts = (distribution: LinuxDistribution) => ({
  node: insideDistribution(distribution.node),
  cli: insideDistribution(distribution.cli),
  extension: insideDistribution(distribution.extension),
})

/**
 * What a container's first process runs on the mounted Node: nothing but staying alive, unless it is
 * given a port and a socket, where it serves the model proxy's mounted socket at its own 127.0.0.1
 * (fab-mgi.60). A port in use means the container shares the proxy's own loopback (`--network host`),
 * where nothing needs relaying.
 */
const KEEP_ALIVE = `'use strict'
const net = require('node:net')
const [port, socket] = process.argv.slice(1)
setInterval(() => {}, 1 << 30)
process.on('SIGTERM', () => process.exit(0))
if (socket !== undefined) {
  net
    .createServer(here => {
      const there = net.connect(socket)
      here.pipe(there)
      there.pipe(here)
      here.on('error', () => there.destroy())
      there.on('error', () => here.destroy())
    })
    .on('error', error => {
      if (error.code !== 'EADDRINUSE') console.error(error.message)
    })
    .listen(Number(port), '127.0.0.1')
}
`

/** The model proxy as the container's relay serves it: at its own 127.0.0.1, on the proxy's own port. */
export interface ProxyRelay {
  readonly port: string
  readonly socket: string
}

/** The user a container's first process runs as, which writes the worktree's files and connects its sockets. */
const userArguments = ({
  placement,
  containerUser,
  uid,
  gid,
}: {
  readonly placement: RuntimePlacement
  readonly containerUser: Option.Option<string>
  readonly uid: number
  readonly gid: number
}): ReadonlyArray<string> => {
  const keepId = ['--userns=keep-id']
  const named = Option.match(containerUser, {
    onNone: () => [],
    onSome: user => ['--user', user],
  })
  return RuntimePlacement.$match(placement, {
    // virtiofs maps a file's owner to the Mac's user.
    DockerDesktop: () => named,
    // keep-id is a rootless user namespace's: a rootful machine refuses it.
    PodmanMachine: ({ rootless }) => (rootless ? [...keepId, ...named] : named),
    RootlessLinux: ({ runtime }) =>
      runtime === 'podman'
        ? [...keepId, ...named]
        : // Rootless Docker's container root is the host's user.
          named,
    RootfulLinux: () =>
      Option.isSome(containerUser) ? named : ['--user', `${uid}:${gid}`],
  })
}

/**
 * `docker run`'s arguments for a worker's container: its limits, its network, its mounts, its
 * variables by name, and the mounted Node kept alive as its first process.
 */
export const runArguments = ({
  prepared,
  name,
  workspace,
  mounts,
  relay,
}: {
  readonly prepared: PreparedContainers
  readonly name: string
  readonly workspace: string
  readonly mounts: ReadonlyArray<Mount>
  readonly relay: Option.Option<ProxyRelay>
}): ReadonlyArray<string> => [
  'run',
  '--detach',
  '--name',
  name,
  '--label',
  'fabrica.agent=1',
  '--memory',
  String(prepared.memory),
  '--cpus',
  String(prepared.cpus),
  ...Option.match(prepared.network, {
    onNone: () => [],
    onSome: network => ['--network', network],
  }),
  ...(prepared.setup.init ? ['--init'] : []),
  ...userArguments({
    placement: prepared.placement,
    containerUser: prepared.setup.containerUser,
    uid: prepared.uid,
    gid: prepared.gid,
  }),
  // SELinux would refuse a mounted file its label doesn't let in; relabelling would change the host's files.
  ...(Option.isNone(hostAddressOf(prepared.placement))
    ? ['--security-opt', 'label=disable']
    : []),
  // A devcontainer's `workspaceFolder` may be the worktree's own path: a runtime refuses a target twice.
  ...[...new Map(mounts.map(mount => [mount.target, mount])).values()].flatMap(
    mountArguments,
  ),
  ...environmentArguments(Object.keys(prepared.setup.containerEnv)),
  '--workdir',
  workspace,
  '--entrypoint',
  insideParts(prepared.distribution).node,
  prepared.image,
  '-e',
  KEEP_ALIVE,
  ...Option.match(relay, {
    onNone: () => [],
    onSome: ({ port, socket }) => [port, socket],
  }),
]

/** `docker exec`'s arguments for a command in the container, its variables by name. */
export const execArguments = ({
  name,
  workspace,
  remoteUser,
  environment,
  interactive,
  command,
}: {
  readonly name: string
  readonly workspace: string
  readonly remoteUser: Option.Option<string>
  readonly environment: ReadonlyArray<string>
  readonly interactive: boolean
  readonly command: ReadonlyArray<string>
}): ReadonlyArray<string> => [
  'exec',
  ...(interactive ? ['--interactive'] : []),
  '--workdir',
  workspace,
  ...Option.match(remoteUser, {
    onNone: () => [],
    onSome: user => ['--user', user],
  }),
  ...environmentArguments(environment),
  name,
  ...command,
]

/** `docker rm`'s arguments. */
export const removeArguments = (name: string): ReadonlyArray<string> => [
  'rm',
  '--force',
  name,
]

/**
 * A container's reaper (spec §12.1): the agent's own ends Pi's client and group, but no signal reaches
 * into the container, and an engine that is killed runs no finalizer. Its stdin is a pipe only the
 * engine holds: at its end, it removes the container. On a normal release the engine removes it, and
 * ends the reaper first.
 */
const CONTAINER_REAPER = `'use strict'
const { spawn } = require('node:child_process')
const [runtime, ...remove] = process.argv.slice(1)
process.stdin.on('data', () => {})
process.stdin.once('end', () => {
  spawn(runtime, remove, { detached: true, stdio: 'ignore' }).unref()
  process.exit(0)
})
`

/** The container reaper's arguments to Node. */
export const containerReaperArguments = ({
  runtime,
  name,
}: {
  readonly runtime: ContainerRuntime
  readonly name: string
}): ReadonlyArray<string> => [
  '-e',
  CONTAINER_REAPER,
  runtime,
  ...removeArguments(name),
]

/** A container couldn't be made, or its setup failed. */
export class ContainerFailed extends Data.TaggedError('ContainerFailed')<{
  readonly reason: string
}> {
  override get message() {
    return this.reason
  }
}

/** A setup command of the container's failed: the rest are skipped. */
export class ContainerSetupFailed extends Data.TaggedError(
  'ContainerSetupFailed',
)<{
  readonly reason: string
}> {
  override get message() {
    return this.reason
  }
}

/**
 * The git configuration a container's agent reads in place of the user's, whose file stays on the host:
 * who commits, so a commit's author is the same as on the host; and every folder trusted, since a
 * mounted repository's owner may read as another user's in the container.
 */
export const gitConfigText = ({ name, email }: GitIdentity): string => {
  const quoted = (value: string) =>
    `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
  const user = [
    ...Option.toArray(Option.map(name, value => `\tname = ${quoted(value)}\n`)),
    ...Option.toArray(
      Option.map(email, value => `\temail = ${quoted(value)}\n`),
    ),
  ]
  return `${user.length === 0 ? '' : `[user]\n${user.join('')}`}[safe]\n\tdirectory = *\n`
}

/** The variable naming the git configuration a container's commands read. */
export const GIT_CONFIG_VARIABLE = 'GIT_CONFIG_GLOBAL'

/** Who commits on the host, as its git says. */
export interface GitIdentity {
  readonly name: Option.Option<string>
  readonly email: Option.Option<string>
}

/** A container that is running, and how a command is started in it. */
export interface StartedContainer {
  readonly runtime: ContainerRuntime
  /** Its lifecycle commands, which run before anything else in it (fab-mgi.2.8). */
  readonly setUp: Effect.Effect<void, ContainerSetupFailed>
  /** The CLI's arguments for the agent's Pi, given Pi's own arguments and its variables' names. */
  readonly agentArguments: (
    pi: ReadonlyArray<string>,
    environment: ReadonlyArray<string>,
  ) => ReadonlyArray<string>
  /** The variables the CLI gets for it: the devcontainer file's `remoteEnv`, substituted. */
  readonly remoteEnv: Readonly<Record<string, string>>
  readonly workspace: string
}

/**
 * Starts a container for an agent, in the scope: a leftover of its name removed first, the reaper
 * beside it, and removed when the scope closes (§12.7).
 */
export const startContainer = Effect.fn('Container.start')(function* ({
  prepared,
  name,
  worktree,
  mounts,
  relay,
  node,
  variables,
}: {
  readonly prepared: PreparedContainers
  readonly name: string
  readonly worktree: string
  readonly mounts: ReadonlyArray<Mount>
  readonly relay: Option.Option<ProxyRelay>
  /** Variables every command in it gets, over the devcontainer file's. */
  readonly variables: Readonly<Record<string, string>>
  /** The host's Node, which runs the reaper. */
  readonly node: string
}) {
  const runner = yield* ProcessRunner
  const runtime = runtimeOf(prepared.placement)
  const { setup } = prepared
  const workspace = workspaceOf({ worktree, prepared })
  const withVariables = (
    text: string,
    containerEnv: Readonly<Record<string, string>>,
  ) =>
    substituted(text, {
      local: worktree,
      container: workspace,
      id: setup.id,
      environment: prepared.environment,
      containerEnv,
    })
  const containerEnv = Object.fromEntries(
    Object.entries(setup.containerEnv).map(([variable, value]) => [
      variable,
      withVariables(value, {}),
    ]),
  )
  const remoteEnv = {
    ...Object.fromEntries(
      Object.entries(setup.remoteEnv).map(([variable, value]) => [
        variable,
        withVariables(value, containerEnv),
      ]),
    ),
    ...variables,
  }
  const failed = (doing: string, why: string) =>
    new ContainerFailed({ reason: `${doing}: ${why}` })
  const remove = runner.run({
    command: runtime,
    args: removeArguments(name),
    cwd: worktree,
    containerRuntime: true,
    timeLimit: REMOVE_LIMIT,
  })
  yield* remove
  yield* Effect.acquireRelease(
    Effect.gen(function* () {
      const started = yield* runner.run({
        command: runtime,
        args: runArguments({
          prepared,
          name,
          workspace,
          mounts,
          relay,
        }),
        cwd: worktree,
        env: containerEnv,
        containerRuntime: true,
        timeLimit: RUN_LIMIT,
      })
      const result = commandSucceeded(started)
      if (Result.isFailure(result))
        return yield* failed(
          `the container ${name} didn't start`,
          result.failure,
        )
    }),
    () => Effect.asVoid(remove),
  )
  yield* runner
    .start({
      command: node,
      args: containerReaperArguments({ runtime, name }),
      cwd: worktree,
      containerRuntime: true,
      stdin: 'pipe',
    })
    .pipe(
      Effect.mapError(error =>
        failed(
          `the reaper of the container ${name} didn't start`,
          error.reason._tag,
        ),
      ),
    )
  const environment = Object.keys(remoteEnv)
  const setUp = Effect.forEach(
    setup.lifecycle,
    step =>
      Effect.forEach(
        step,
        command =>
          Effect.gen(function* () {
            const ran = yield* runner.run({
              command: runtime,
              args: execArguments({
                name,
                workspace,
                remoteUser: setup.remoteUser,
                environment,
                interactive: false,
                command: command.map(word => withVariables(word, containerEnv)),
              }),
              cwd: worktree,
              env: remoteEnv,
              containerRuntime: true,
              timeLimit: LIFECYCLE_LIMIT,
            })
            const result = commandSucceeded(ran)
            if (Result.isFailure(result))
              return yield* new ContainerSetupFailed({
                reason: `the container's setup command ${command.join(' ')} failed: ${result.failure}`,
              })
          }),
        { concurrency: 'unbounded', discard: true },
      ),
    { discard: true },
  )
  const started: StartedContainer = {
    runtime,
    setUp,
    workspace,
    remoteEnv,
    agentArguments: (pi, names) =>
      execArguments({
        name,
        workspace,
        remoteUser: setup.remoteUser,
        environment: [...new Set([...environment, ...names])],
        interactive: true,
        command: [insideParts(prepared.distribution).node, ...pi],
      }),
  }
  return started
})
