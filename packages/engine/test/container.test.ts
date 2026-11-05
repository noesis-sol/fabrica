import { Duration, Effect, Exit, Layer, Option, Result } from 'effect'
import { execFileSync, spawn } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  type Container,
  ContainerSource,
  ProjectId,
  TicketId,
} from '@fabrica/contracts'

import {
  AgentStartFailed,
  AgentStartFailure,
  type ContainerHost,
  PiAgent,
  type PiAgentConfig,
  type PreparedContainers,
  RuntimeChoice,
  RuntimePlacement,
  layer as agentLayer,
  chooseRuntime,
  containerReaperArguments,
  controlAddressOf,
  delegationFile,
  delegationProblem,
  environmentOf,
  gitConfigText,
  hostAddressOf,
  placementOf,
  plainJson,
  prepareContainers,
  reachedAt,
  readDevcontainer,
  runArguments,
  samePath,
  substituted,
  workspaceOf,
} from '../src/agent'
import {
  type RunnerConfig,
  hostHolders,
  hostPriority,
  layerClock,
  listProcesses,
  layer as runnerLayer,
} from '../src/process'
import {
  dockerRootful,
  dockerRootless,
  installStub,
  podmanRootful,
  podmanRootless,
  stubDistribution,
  writeStubScript,
} from './container-stub'

// A worker's container (spec §12.7, H16, H36) against a stub docker and podman at the process boundary:
// which runtime is chosen and what is said of it, what a host that can't hold the limits is told, the image
// pulled or built before anything runs, the run's arguments (mounts, limits, network), and a real PiAgent
// over a stub Pi that the stub CLI's `exec` starts, its container removed with it.

const PI = `import { appendFileSync } from 'node:fs'
const out = record => process.stdout.write(JSON.stringify(record) + '\\n')
if (process.env.PI_STUB_NOTE) appendFileSync(process.env.PI_STUB_NOTE, 'pi\\n')
let text = ''
process.stdin.on('data', chunk => {
  text += chunk
  for (;;) {
    const end = text.indexOf('\\n')
    if (end === -1) return
    const command = JSON.parse(text.slice(0, end))
    text = text.slice(end + 1)
    const data = command.type === 'get_state'
      ? { sessionId: 's-1', sessionFile: '/tmp/s-1.jsonl', isStreaming: false, messageCount: 0 }
      : undefined
    if (process.env.PI_STUB_SILENT) return
    out({ id: command.id, type: 'response', command: command.type, success: true, ...(data ? { data } : {}) })
  }
})
process.stdin.on('end', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
`

let root = ''
let script = ''
let piCli = ''
let counter = 0

beforeAll(() => {
  // Short, for the socket paths; real, as a working folder reads it.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fab-ctr-')))
  script = join(root, 'stub-cli')
  writeStubScript(script)
  piCli = join(root, 'pi.mjs')
  writeFileSync(piCli, PI)
})

const fixture = (clis: ReadonlyArray<string> = ['docker', 'podman']) => {
  counter += 1
  const base = join(root, `t${counter}`)
  const worktree = join(base, 'worktree')
  mkdirSync(worktree, { recursive: true })
  const distribution = stubDistribution({
    base,
    node: process.execPath,
    cli: piCli,
  })
  const cli = installStub({
    script,
    base,
    clis,
    distribution: distribution.root,
  })
  const runnerConfig: RunnerConfig = {
    hostEnvironment: {
      PATH: cli.bin,
      HOME: base,
      LANG: 'C',
      DOCKER_HOST: 'unix:///run/user/1000/docker.sock',
    },
    enginePriority: 0,
    priority: hostPriority,
    listProcesses,
    pipeHolders: hostHolders({ platform: process.platform, self: process.pid }),
    self: process.pid,
    killGrace: Duration.millis(500),
    outputGrace: Duration.millis(200),
  }
  const runner = runnerLayer(runnerConfig).pipe(Layer.provide(layerClock))
  return { base, worktree, distribution, cli, runner }
}

const delegated =
  (text: string): ContainerHost['readFile'] =>
  () =>
    Effect.succeed(Option.some(text))

const hostOf = (
  distribution: ReturnType<typeof fixture>['distribution'],
  overrides: Partial<ContainerHost> = {},
): ContainerHost => ({
  platform: 'linux',
  uid: 1000,
  gid: 1001,
  enginePriority: 0,
  memory: 2 * 1024 ** 3,
  environment: { FROM_ENGINE: 'allowed' },
  distribution: Effect.succeed(distribution),
  readFile: delegated('cpu memory pids'),
  ...overrides,
})

const imageContainer = (overrides: Partial<Container> = {}): Container => ({
  source: ContainerSource.cases.Image.make({ image: 'node:26' }),
  runtime: Option.none(),
  memory: Option.none(),
  cpus: Option.none(),
  network: Option.none(),
  ...overrides,
})

const project = ProjectId.make('p1')
const ticket = TicketId.make('fa-1')

describe('choosing a runtime', () => {
  const choose = (
    state: ReturnType<typeof fixture>,
    wanted: Option.Option<'docker' | 'podman'>,
    platform = 'linux',
  ) =>
    chooseRuntime({ wanted, platform, cwd: state.worktree }).pipe(
      Effect.provide(state.runner),
    )

  it.live('takes the runtime the settings name, where both are present', () =>
    Effect.gen(function* () {
      const state = fixture()
      state.cli.answerInfo('docker', dockerRootless)
      state.cli.answerInfo('podman', podmanRootless)
      const chosen = yield* choose(state, Option.some('podman'))
      expect(chosen).toEqual(
        RuntimeChoice.Chosen({
          placement: RuntimePlacement.RootlessLinux({ runtime: 'podman' }),
          notices: [],
        }),
      )
      expect(state.cli.calls().map(([cli]) => cli)).toEqual(['podman'])
    }),
  )

  it.live('takes whichever is present', () =>
    Effect.gen(function* () {
      const state = fixture(['podman'])
      state.cli.answerInfo('podman', podmanRootless)
      const chosen = yield* choose(state, Option.none())
      expect(chosen).toEqual(
        RuntimeChoice.Chosen({
          placement: RuntimePlacement.RootlessLinux({ runtime: 'podman' }),
          notices: [],
        }),
      )
    }),
  )

  it.live('prefers a rootless runtime to a rootful daemon', () =>
    Effect.gen(function* () {
      const state = fixture()
      state.cli.answerInfo('docker', dockerRootful)
      state.cli.answerInfo('podman', podmanRootless)
      const chosen = yield* choose(state, Option.none())
      expect(chosen).toEqual(
        RuntimeChoice.Chosen({
          placement: RuntimePlacement.RootlessLinux({ runtime: 'podman' }),
          notices: [],
        }),
      )
    }),
  )

  it.live('says so when only a rootful daemon is found', () =>
    Effect.gen(function* () {
      const state = fixture()
      state.cli.answerInfo('docker', dockerRootful)
      state.cli.answerInfo('podman', podmanRootful)
      const chosen = yield* choose(state, Option.none())
      expect(chosen).toEqual(
        RuntimeChoice.Chosen({
          placement: RuntimePlacement.RootfulLinux({ runtime: 'docker' }),
          notices: [
            'only a rootful docker daemon was found; a rootless runtime is preferred (§12.7)',
          ],
        }),
      )
    }),
  )

  it.live('refuses, saying why, where none answers', () =>
    Effect.gen(function* () {
      const state = fixture(['docker'])
      state.cli.refuse('info')
      const chosen = yield* choose(state, Option.none())
      if (!RuntimeChoice.$is('Refused')(chosen))
        return expect.unreachable('it chose one')
      expect(chosen.problem).toContain('needs docker or podman')
      expect(chosen.problem).toContain('docker: it exited 1: refused info')
      expect(chosen.problem).toContain('podman: it didn')
    }),
  )

  it.live('a Mac is Docker Desktop or Podman Machine', () =>
    Effect.gen(function* () {
      const state = fixture()
      state.cli.answerInfo('docker', dockerRootful)
      state.cli.answerInfo('podman', podmanRootless)
      expect(yield* choose(state, Option.some('docker'), 'darwin')).toEqual(
        RuntimeChoice.Chosen({
          placement: RuntimePlacement.DockerDesktop(),
          notices: [],
        }),
      )
      expect(yield* choose(state, Option.some('podman'), 'darwin')).toEqual(
        RuntimeChoice.Chosen({
          placement: RuntimePlacement.PodmanMachine({ rootless: true }),
          notices: [],
        }),
      )
    }),
  )

  it('reads whether a Podman Machine is rootless', () => {
    expect(
      placementOf({
        runtime: 'podman',
        platform: 'darwin',
        info: JSON.stringify(podmanRootful),
      }),
    ).toEqual(Option.some(RuntimePlacement.PodmanMachine({ rootless: false })))
  })

  it('reads a daemon that answered without its server as no answer', () => {
    expect(
      placementOf({
        runtime: 'docker',
        platform: 'linux',
        info: JSON.stringify({ ServerErrors: ['Cannot connect'] }),
      }),
    ).toEqual(Option.none())
    expect(
      placementOf({ runtime: 'podman', platform: 'linux', info: 'not json' }),
    ).toEqual(Option.none())
  })
})

describe('how a container reaches the host', () => {
  it('reaches the proxy by each runtime host address, on Linux by a mounted socket', () => {
    expect(hostAddressOf(RuntimePlacement.DockerDesktop())).toEqual(
      Option.some('host.docker.internal'),
    )
    expect(
      hostAddressOf(RuntimePlacement.PodmanMachine({ rootless: true })),
    ).toEqual(Option.some('192.168.127.254'))
    expect(
      hostAddressOf(RuntimePlacement.RootlessLinux({ runtime: 'docker' })),
    ).toEqual(Option.none())
    expect(
      hostAddressOf(RuntimePlacement.RootfulLinux({ runtime: 'docker' })),
    ).toEqual(Option.none())
  })

  it('reaches the control channel over TCP on Podman Machine alone', () => {
    expect(
      controlAddressOf(RuntimePlacement.PodmanMachine({ rootless: true })),
    ).toEqual(Option.some('192.168.127.254'))
    expect(controlAddressOf(RuntimePlacement.DockerDesktop())).toEqual(
      Option.none(),
    )
    expect(
      controlAddressOf(RuntimePlacement.RootlessLinux({ runtime: 'podman' })),
    ).toEqual(Option.none())
  })

  it('points a base URL at the host, its port and path kept', () => {
    expect(
      reachedAt('http://127.0.0.1:4242/anthropic', 'host.docker.internal'),
    ).toBe('http://host.docker.internal:4242/anthropic')
  })
})

describe('a rootless host without cpu delegation', () => {
  it('refuses, naming the one-time root step', () => {
    const problem = delegationProblem({
      controllers: Option.some('memory pids'),
    })
    expect(Option.getOrThrow(problem)).toContain(
      '/etc/systemd/system/user@.service.d/delegate.conf',
    )
    expect(Option.getOrThrow(problem)).toContain(
      'Delegate=cpu cpuset io memory pids',
    )
    expect(
      Option.getOrThrow(delegationProblem({ controllers: Option.none() })),
    ).toContain('cgroup v2')
  })

  it('holds where the cpu controller is delegated', () => {
    expect(
      delegationProblem({ controllers: Option.some('cpuset cpu io memory') }),
    ).toEqual(Option.none())
    expect(delegationFile(1000)).toBe(
      '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/cgroup.controllers',
    )
  })

  it.live('stops the start before any image is pulled', () =>
    Effect.gen(function* () {
      const state = fixture(['docker'])
      state.cli.answerInfo('docker', dockerRootless)
      const failure = yield* prepareContainers({
        container: imageContainer(),
        host: hostOf(state.distribution, {
          readFile: delegated('memory pids'),
        }),
        project,
        checkout: state.worktree,
        cores: 2,
      }).pipe(Effect.provide(state.runner), Effect.flip)
      expect(failure.problems[0]).toContain('delegate.conf')
      expect(
        state.cli.calls().some(([, subcommand]) => subcommand === 'pull'),
      ).toBe(false)
    }),
  )

  it.live('a rootful daemon needs no delegation', () =>
    Effect.gen(function* () {
      const state = fixture(['docker'])
      state.cli.answerInfo('docker', dockerRootful)
      const prepared = yield* prepareContainers({
        container: imageContainer(),
        host: hostOf(state.distribution, {
          readFile: () => Effect.succeed(Option.none()),
        }),
        project,
        checkout: state.worktree,
        cores: 2,
      }).pipe(Effect.provide(state.runner))
      expect(prepared.notices[0]).toContain('only a rootful docker daemon')
    }),
  )
})

describe('the image, before a first dispatch', () => {
  const prepare = (
    state: ReturnType<typeof fixture>,
    container: Container,
    host: Partial<ContainerHost> = {},
  ) =>
    prepareContainers({
      container,
      host: hostOf(state.distribution, host),
      project,
      checkout: state.worktree,
      cores: 3,
    }).pipe(Effect.provide(state.runner))

  it.live('is pulled, with the limits defaulting to the worker share', () =>
    Effect.gen(function* () {
      const state = fixture(['docker'])
      state.cli.answerInfo('docker', dockerRootless)
      const prepared = yield* prepare(state, imageContainer())
      expect(state.cli.calls().map(call => call.slice(0, 3))).toEqual(
        expect.arrayContaining([['docker', 'pull', 'node:26']]),
      )
      expect(prepared.image).toBe('node:26')
      expect(prepared.memory).toBe(2 * 1024 ** 3)
      expect(prepared.cpus).toBe(3)
    }),
  )

  it.live('takes the limits and the network the settings give', () =>
    Effect.gen(function* () {
      const state = fixture(['docker'])
      state.cli.answerInfo('docker', dockerRootless)
      const prepared = yield* prepare(
        state,
        imageContainer({
          memory: Option.some(1024 ** 3),
          cpus: Option.some(1.5),
          network: Option.some('none'),
        }),
      )
      expect(prepared.memory).toBe(1024 ** 3)
      expect(prepared.cpus).toBe(1.5)
      expect(prepared.network).toEqual(Option.some('none'))
    }),
  )

  it.live(
    'a pull that fails is a problem, unless the host holds the image',
    () =>
      Effect.gen(function* () {
        const state = fixture(['docker'])
        state.cli.answerInfo('docker', dockerRootless)
        state.cli.refuse('pull')
        const failure = yield* prepare(state, imageContainer()).pipe(
          Effect.flip,
        )
        expect(failure.problems).toEqual([
          "the image node:26 couldn't be pulled: it exited 1: refused pull",
        ])
        state.cli.holdImages()
        const prepared = yield* prepare(state, imageContainer())
        expect(prepared.notices[0]).toContain('the one this host holds is used')
      }),
  )

  it.live(
    'a network of none is refused where the proxy is reached over it',
    () =>
      Effect.gen(function* () {
        const state = fixture(['docker'])
        state.cli.answerInfo('docker', dockerRootful)
        const failure = yield* prepare(
          state,
          imageContainer({ network: Option.some('none') }),
          { platform: 'darwin' },
        ).pipe(Effect.flip)
        expect(failure.problems[0]).toContain('reaches the model proxy')
      }),
  )

  it.live('a devcontainer build is built, its paths beside its file', () =>
    Effect.gen(function* () {
      const state = fixture(['docker'])
      state.cli.answerInfo('docker', dockerRootless)
      const folder = join(state.worktree, '.devcontainer')
      mkdirSync(folder)
      const file = join(folder, 'devcontainer.json')
      writeFileSync(
        file,
        `{
          // Comments, as the spec allows.
          "build": { "dockerfile": "Dockerfile", "context": "..", "args": { "V": "1" }, "target": "dev" },
          "features": {},
        }`,
      )
      const prepared = yield* prepare(
        state,
        imageContainer({
          source: ContainerSource.cases.Devcontainer.make({
            file: '.devcontainer/devcontainer.json',
          }),
        }),
        {
          readFile: path =>
            Effect.sync(() =>
              path === file
                ? Option.some(readFileSync(file, 'utf8'))
                : Option.some('cpu'),
            ),
        },
      )
      const build = state.cli
        .calls()
        .find(([, subcommand]) => subcommand === 'build')
      expect(build).toEqual([
        'docker',
        'build',
        '--tag',
        prepared.image,
        '--file',
        join(folder, 'Dockerfile'),
        '--build-arg',
        'V=1',
        '--target',
        'dev',
        state.worktree,
      ])
      expect(prepared.notices).toEqual([
        "the devcontainer file's features isn't honoured: build an image with them instead",
      ])
    }),
  )

  it.live('the Linux distribution missing is a problem', () =>
    Effect.gen(function* () {
      const state = fixture(['docker'])
      state.cli.answerInfo('docker', dockerRootless)
      const failure = yield* prepare(state, imageContainer(), {
        distribution: Effect.fail('this engine runs from a checkout'),
      }).pipe(Effect.flip)
      expect(failure.problems).toEqual([
        "the Linux engine distribution isn't at hand: this engine runs from a checkout",
      ])
    }),
  )
})

describe('the variables of a devcontainer file', () => {
  it.live(
    'stand in a build argument, as the engine allowlisted its environment',
    () =>
      Effect.gen(function* () {
        const state = fixture(['docker'])
        state.cli.answerInfo('docker', dockerRootless)
        const file = join(state.worktree, 'devcontainer.json')
        const text = JSON.stringify({
          build: {
            dockerfile: 'Dockerfile',
            args: {
              FROM: '${localEnv:FROM_ENGINE}',
              UNSET: '${localEnv:SECRET:none}',
            },
          },
        })
        yield* prepareContainers({
          container: imageContainer({
            source: ContainerSource.cases.Devcontainer.make({
              file: 'devcontainer.json',
            }),
          }),
          host: hostOf(state.distribution, {
            readFile: path =>
              Effect.succeed(Option.some(path === file ? text : 'cpu')),
          }),
          project,
          checkout: state.worktree,
          cores: 1,
        }).pipe(Effect.provide(state.runner))
        const build =
          state.cli.calls().find(([, subcommand]) => subcommand === 'build') ??
          []
        expect(build).toContain('FROM=allowed')
        expect(build).toContain('UNSET=none')
      }),
  )

  it('stand in the workspace folder', () => {
    expect(
      workspaceOf({
        worktree: '/host/fa-1',
        prepared: {
          setup: {
            ...preparedOf().setup,
            workspaceFolder: Option.some(
              '/work/${localWorkspaceFolderBasename}-${localEnv:WHO}',
            ),
          },
          environment: { WHO: 'me' },
        },
      }),
    ).toBe('/work/fa-1-me')
  })
})

describe('what inspecting a container says', () => {
  it('reads its environment by variable, a value keeping its equals signs', () => {
    expect(environmentOf('["A=1","B=x=y","NOPE"]\n')).toEqual({
      A: '1',
      B: 'x=y',
    })
    expect(environmentOf('null')).toEqual({})
    expect(environmentOf('not json')).toEqual({})
  })
})

describe('a devcontainer file', () => {
  const read = (body: object | string) =>
    readDevcontainer({
      text: typeof body === 'string' ? body : JSON.stringify(body),
      file: '/repo/.devcontainer/devcontainer.json',
      project,
    })

  it('reads JSON with comments and trailing commas, strings left alone', () => {
    expect(
      JSON.parse(
        plainJson(`{
          // a comment
          "a": "http://x/*y*/,}", /* another */
          "b": [1, 2,],
        }`),
      ),
    ).toEqual({ a: 'http://x/*y*/,}', b: [1, 2] })
  })

  it('honours its image, its users, its environment and its workspace', () => {
    const { source, setup } = Result.getOrThrow(
      read({
        image: 'mcr/base',
        containerEnv: { A: '1' },
        remoteEnv: { B: '${containerEnv:A}', GONE: null },
        containerUser: 'root',
        remoteUser: 'vscode',
        workspaceFolder: '/work',
        init: true,
      }),
    )
    expect(source).toMatchObject({ _tag: 'Pull', image: 'mcr/base' })
    expect(setup.containerEnv).toEqual({ A: '1' })
    expect(setup.remoteEnv).toEqual({ B: '${containerEnv:A}' })
    expect(setup.containerUser).toEqual(Option.some('root'))
    expect(setup.remoteUser).toEqual(Option.some('vscode'))
    expect(setup.workspaceFolder).toEqual(Option.some('/work'))
    expect(setup.init).toBe(true)
  })

  it('keeps its lifecycle commands in the spec order, each as an argument list', () => {
    const { setup } = Result.getOrThrow(
      read({
        image: 'i',
        postStartCommand: 'four',
        postCreateCommand: { x: 'three-x', y: ['three', 'y'] },
        updateContentCommand: ['two', 'words'],
        onCreateCommand: 'one',
      }),
    )
    expect(setup.lifecycle).toEqual([
      [['/bin/sh', '-c', 'one']],
      [['two', 'words']],
      [
        ['/bin/sh', '-c', 'three-x'],
        ['three', 'y'],
      ],
      [['/bin/sh', '-c', 'four']],
    ])
  })

  it('gives a notice for what it does not honour', () => {
    const { notices } = Result.getOrThrow(
      read({
        image: 'i',
        initializeCommand: 'x',
        runArgs: [],
        mounts: [],
        postAttachCommand: 'y',
      }),
    )
    expect(notices).toEqual([
      "the devcontainer file's initializeCommand isn't honoured: it would run on the host, outside the container and the gate",
      "the devcontainer file's runArgs, mounts isn't honoured: the engine owns the run arguments",
      "the devcontainer file's postAttachCommand isn't honoured: nothing attaches",
    ])
  })

  it('refuses a file naming no image or build, or not JSON', () => {
    expect(Result.isFailure(read({ dockerComposeFile: 'x' }))).toBe(true)
    expect(Result.isFailure(read('{ nope'))).toBe(true)
    expect(Result.isFailure(read({ image: 3 }))).toBe(true)
  })

  it('stands in its variables, the local environment the allowlisted one alone', () => {
    const text =
      '${localWorkspaceFolder} ${localWorkspaceFolderBasename} ${containerWorkspaceFolder} ${containerWorkspaceFolderBasename} ${devcontainerId} ${localEnv:FROM_ENGINE} ${localEnv:SECRET:none} ${containerEnv:A} ${unknown}'
    expect(
      substituted(text, {
        local: '/host/fa-1',
        container: '/workspaces/fa-1',
        id: 'abc',
        environment: { FROM_ENGINE: 'allowed' },
        containerEnv: { A: '1' },
      }),
    ).toBe(
      '/host/fa-1 fa-1 /workspaces/fa-1 fa-1 abc allowed none 1 ${unknown}',
    )
  })
})

const preparedOf = (
  overrides: Partial<PreparedContainers> = {},
): PreparedContainers => ({
  placement: RuntimePlacement.RootlessLinux({ runtime: 'docker' }),
  image: 'node:26',
  setup: {
    id: 'abc',
    containerEnv: {},
    remoteEnv: {},
    containerUser: Option.none(),
    remoteUser: Option.none(),
    workspaceFolder: Option.none(),
    init: false,
    lifecycle: [],
  },
  memory: 1024,
  cpus: 2,
  network: Option.none(),
  distribution: {
    root: '/dist',
    node: 'node/bin/node',
    cli: 'cli.js',
    extension: 'ext.js',
  },
  uid: 1000,
  gid: 1001,
  enginePriority: 0,
  environment: {},
  notices: [],
  ...overrides,
})

describe('the run arguments', () => {
  const args = (
    overrides: Partial<PreparedContainers> = {},
    relay: Option.Option<{ port: string; socket: string }> = Option.none(),
  ) =>
    runArguments({
      prepared: preparedOf(overrides),
      name: 'fabrica-p1-fa-1',
      workspace: '/workspaces/fa-1',
      mounts: [
        { source: '/wt', target: '/workspaces/fa-1' },
        samePath('/run/c/fa-1.sock'),
        { source: '/dist', target: '/opt/fabrica', readOnly: true },
      ],
      relay,
      containerEnv: {},
    })
  const after = (words: ReadonlyArray<string>, flag: string) =>
    words.flatMap((word, at) => (word === flag ? [words[at + 1]] : []))

  it('sets the memory and CPU limits', () => {
    expect(after(args(), '--memory')).toEqual(['1024'])
    expect(after(args(), '--cpus')).toEqual(['2'])
  })

  it('mounts in the short form, the distribution read-only', () => {
    expect(after(args(), '--volume')).toEqual([
      '/wt:/workspaces/fa-1',
      '/run/c/fa-1.sock:/run/c/fa-1.sock',
      '/dist:/opt/fabrica:ro',
    ])
  })

  it('mounts each target once, should the workspace be the worktree own path', () => {
    const words = runArguments({
      prepared: preparedOf(),
      name: 'n',
      workspace: '/wt',
      mounts: [{ source: '/wt', target: '/wt' }, samePath('/wt')],
      relay: Option.none(),
      containerEnv: {},
    })
    expect(after(words, '--volume')).toEqual(['/wt:/wt'])
  })

  it('leaves the network to the runtime unless the settings name one', () => {
    expect(after(args(), '--network')).toEqual([])
    expect(
      after(args({ network: Option.some('fab-net') }), '--network'),
    ).toEqual(['fab-net'])
  })

  it('keeps itself alive on the mounted Node, as the worktree the working folder', () => {
    const words = args()
    expect(after(words, '--entrypoint')).toEqual(['/opt/fabrica/node/bin/node'])
    expect(after(words, '--workdir')).toEqual(['/workspaces/fa-1'])
    expect(words).toContain('node:26')
    expect(words.indexOf('node:26')).toBeGreaterThan(
      words.indexOf('--entrypoint'),
    )
    expect(words[words.indexOf('node:26') + 1]).toBe('-e')
  })

  it('maps the user as each runtime needs', () => {
    expect(args()).not.toContain('--user')
    expect(args()).not.toContain('--userns=keep-id')
    expect(
      args({
        placement: RuntimePlacement.RootlessLinux({ runtime: 'podman' }),
      }),
    ).toContain('--userns=keep-id')
    expect(
      args({ placement: RuntimePlacement.PodmanMachine({ rootless: true }) }),
    ).toContain('--userns=keep-id')
    expect(
      after(
        args({
          placement: RuntimePlacement.RootfulLinux({ runtime: 'docker' }),
        }),
        '--user',
      ),
    ).toEqual(['1000:1001'])
    expect(args({ placement: RuntimePlacement.DockerDesktop() })).not.toContain(
      '--user',
    )
  })

  it('leaves keep-id out on a rootful Podman Machine, which refuses it', () => {
    expect(
      args({ placement: RuntimePlacement.PodmanMachine({ rootless: false }) }),
    ).not.toContain('--userns=keep-id')
  })

  it('takes the devcontainer file user and init', () => {
    const setup = {
      ...preparedOf().setup,
      containerUser: Option.some('root'),
      init: true,
    }
    const rootful = args({
      setup,
      placement: RuntimePlacement.RootfulLinux({ runtime: 'docker' }),
    })
    expect(after(rootful, '--user')).toEqual(['root'])
    expect(rootful).toContain('--init')
  })

  it('leaves SELinux out on Linux alone', () => {
    expect(after(args(), '--security-opt')).toEqual(['label=disable'])
    expect(
      after(
        args({ placement: RuntimePlacement.DockerDesktop() }),
        '--security-opt',
      ),
    ).toEqual([])
  })

  it('gives the file variables by value, the host CLI environment untouched', () => {
    const words = runArguments({
      prepared: preparedOf(),
      name: 'n',
      workspace: '/w',
      mounts: [],
      relay: Option.none(),
      containerEnv: { PATH: '/image/bin' },
    })
    expect(after(words, '--env')).toEqual(['PATH=/image/bin'])
  })

  it('serves the mounted proxy socket at its own loopback, on the proxy port', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const socket = join(root, 'relay.sock')
        const upstream = createServer(connection =>
          connection.on('data', data => connection.write(`seen ${data}`)),
        )
        yield* Effect.acquireRelease(
          Effect.callback<void>(resume => {
            upstream.listen(socket, () => resume(Effect.void))
          }),
          () => Effect.sync(() => upstream.close()),
        )
        const free = createServer()
        const port = yield* Effect.callback<number>(resume => {
          free.listen(0, '127.0.0.1', () => {
            const address = free.address()
            const found =
              typeof address === 'object' && address !== null ? address.port : 0
            free.close(() => resume(Effect.succeed(found)))
          })
        })
        const words = args({}, Option.some({ port: String(port), socket }))
        const relay = yield* Effect.acquireRelease(
          Effect.sync(() =>
            spawn(process.execPath, words.slice(words.indexOf('-e')), {
              stdio: ['ignore', 'ignore', 'inherit'],
            }),
          ),
          child => Effect.sync(() => child.kill('SIGKILL')),
        )
        expect(relay.pid).toBeGreaterThan(0)
        const answer = yield* Effect.callback<string>(resume => {
          const attempt = () => {
            const client = createConnection(port, '127.0.0.1')
            client.once('error', () => setTimeout(attempt, 20))
            client.once('connect', () => client.write('hello'))
            client.once('data', data => {
              client.destroy()
              resume(Effect.succeed(String(data)))
            })
          }
          attempt()
        })
        expect(answer).toBe('seen hello')
      }).pipe(Effect.scoped),
    ))
})

describe('an agent in a container', () => {
  const agentConfig = (base: string): PiAgentConfig => ({
    node: process.execPath,
    cli: 'unused on the host',
    extension: 'unused on the host',
    data: join(base, 'data'),
    configRoot: join(base, 'agents'),
    limits: {
      handshake: Duration.seconds(10),
      answer: Duration.seconds(10),
      abort: Duration.seconds(1),
      reap: Duration.seconds(5),
    },
    reaperPoll: Duration.millis(200),
    reaperGrace: Duration.millis(500),
  })

  const startOf = (
    state: ReturnType<typeof fixture>,
    prepared: Partial<PreparedContainers> = {},
    env: Readonly<Record<string, string>> = {},
  ) => ({
    ticket,
    project,
    worktree: state.worktree,
    providers: [
      { provider: 'anthropic', baseUrl: 'http://127.0.0.1:9/anthropic' },
    ],
    token: 'agent-token-1',
    model: Option.none(),
    tools: Option.none(),
    resume: Option.none(),
    env: { FABRICA_CONTROL_TOKEN: 'control-secret', ...env },
    projectTrusted: false,
    nice: Option.none(),
    container: {
      prepared: preparedOf({
        distribution: state.distribution,
        ...prepared,
      }),
      mounts: [samePath('/run/c/fa-1.sock')],
      relay: Option.none(),
      identity: { name: Option.some('Ada'), email: Option.none() },
    },
  })

  const withAgents = (
    state: ReturnType<typeof fixture>,
    body: Effect.Effect<void, unknown, PiAgent>,
  ) =>
    body.pipe(
      Effect.provide(
        agentLayer(agentConfig(state.base)).pipe(
          Layer.provideMerge(state.runner),
          Layer.provide(layerClock),
        ),
      ),
    )

  it.live(
    'removes a leftover, runs, starts Pi by exec, and removes it with the agent',
    () =>
      Effect.gen(function* () {
        const state = fixture(['docker'])
        yield* withAgents(
          state,
          Effect.gen(function* () {
            const agents = yield* PiAgent
            const agent = yield* agents
              .start(startOf(state))
              .pipe(Effect.scoped)
            yield* agent.close
          }),
        )
        const calls = state.cli.calls()
        const kinds = calls.map(([, subcommand]) => subcommand)
        expect(kinds).toEqual(['rm', 'run', 'exec', 'rm'])
        const name = 'fabrica-p1-fa-1'
        expect(calls[0]).toEqual(['docker', 'rm', '--force', name])
        expect(calls.at(-1)).toEqual(['docker', 'rm', '--force', name])
        const run = calls[1] ?? []
        expect(run).toContain(name)
        expect(run).toContain(`${state.worktree}:/workspaces/worktree`)
        expect(run).toContain(`${state.worktree}:${state.worktree}`)
        expect(run).toContain(`${state.distribution.root}:/opt/fabrica:ro`)
        expect(run).toContain('/run/c/fa-1.sock:/run/c/fa-1.sock')
        const exec = calls[2] ?? []
        expect(exec).toContain('--interactive')
        expect(
          exec.slice(exec.indexOf(name) + 1, exec.indexOf(name) + 3),
        ).toEqual(['/opt/fabrica/node', '/opt/fabrica/cli.mjs'])
        expect(exec).toContain('--extension')
        expect(exec[exec.indexOf('--extension') + 1]).toBe(
          '/opt/fabrica/extension.js',
        )
        expect(exec).toContain('FABRICA_CONTROL_TOKEN')
        expect(exec).toContain('PI_CODING_AGENT_DIR')
        expect(calls.flat().join(' ')).not.toContain('control-secret')
      }),
  )

  it.live(
    'mounts its session and configuration folders where they are on the host',
    () =>
      Effect.gen(function* () {
        const state = fixture(['docker'])
        yield* withAgents(
          state,
          Effect.gen(function* () {
            const agents = yield* PiAgent
            const agent = yield* agents
              .start(startOf(state))
              .pipe(Effect.scoped)
            yield* agent.close
          }),
        )
        const volumes = (state.cli.calls()[1] ?? []).filter(word =>
          word.includes(':'),
        )
        const sessions = join(
          state.base,
          'data',
          'projects',
          'p1',
          'sessions',
          'fa-1',
        )
        expect(volumes).toContain(`${sessions}:${sessions}`)
        expect(
          volumes.some(volume =>
            volume.startsWith(join(state.base, 'agents', 'agent-')),
          ),
        ).toBe(true)
      }),
  )

  it.live(
    'runs the setup commands in order before Pi, inside its container',
    () =>
      Effect.gen(function* () {
        const state = fixture(['docker'])
        const note = join(state.base, 'order')
        yield* withAgents(
          state,
          Effect.gen(function* () {
            const agents = yield* PiAgent
            const agent = yield* agents
              .start(
                startOf(
                  state,
                  {
                    setup: {
                      ...preparedOf().setup,
                      remoteUser: Option.some('vscode'),
                      remoteEnv: { WHERE: '${containerWorkspaceFolder}' },
                      lifecycle: [
                        [['/bin/sh', '-c', `echo one >> ${note}`]],
                        [['/bin/sh', '-c', `echo two-$WHERE >> ${note}`]],
                      ],
                    },
                  },
                  { PI_STUB_NOTE: note },
                ),
              )
              .pipe(Effect.scoped)
            yield* agent.close
          }),
        )
        expect(readFileSync(note, 'utf8').split('\n')).toEqual([
          'one',
          'two-/workspaces/worktree',
          'pi',
          '',
        ])
        const execs = state.cli
          .calls()
          .filter(([, subcommand]) => subcommand === 'exec')
        expect(execs).toHaveLength(3)
        for (const exec of execs) {
          expect(exec[exec.indexOf('--user') + 1]).toBe('vscode')
          expect(exec).toContain('WHERE=/workspaces/worktree')
        }
      }),
  )

  it.live(
    "reads ${containerEnv:…} from the running container, and a file's PATH never moves where the CLI is found",
    () =>
      Effect.gen(function* () {
        const state = fixture(['docker'])
        state.cli.answerInspect(['PATH=/usr/bin:/bin', 'FROM_IMAGE=yes'])
        const note = join(state.base, 'said')
        yield* withAgents(
          state,
          Effect.gen(function* () {
            const agents = yield* PiAgent
            const agent = yield* agents
              .start(
                startOf(state, {
                  setup: {
                    ...preparedOf().setup,
                    remoteEnv: {
                      PATH: '${containerEnv:PATH}:/some/other/path',
                      SEEN: '${containerEnv:FROM_IMAGE}',
                    },
                    lifecycle: [
                      [['/bin/sh', '-c', `echo "$PATH $SEEN" > ${note}`]],
                    ],
                  },
                }),
              )
              .pipe(Effect.scoped)
            yield* agent.close
          }),
        )
        const calls = state.cli.calls()
        expect(calls.map(([, subcommand]) => subcommand)).toEqual([
          'rm',
          'run',
          'inspect',
          'exec',
          'exec',
          'rm',
        ])
        expect(calls[2]).toEqual([
          'docker',
          'inspect',
          '--format',
          '{{json .Config.Env}}',
          'fabrica-p1-fa-1',
        ])
        expect(readFileSync(note, 'utf8')).toBe(
          '/usr/bin:/bin:/some/other/path yes\n',
        )
        const pi = calls[4] ?? []
        expect(pi).toContain('PATH=/usr/bin:/bin:/some/other/path')
        expect(pi).toContain('SEEN=yes')
      }),
  )

  it.live('asks the container nothing where no variable reads it', () =>
    Effect.gen(function* () {
      const state = fixture(['docker'])
      yield* withAgents(
        state,
        Effect.gen(function* () {
          const agents = yield* PiAgent
          const agent = yield* agents.start(startOf(state)).pipe(Effect.scoped)
          yield* agent.close
        }),
      )
      expect(
        state.cli.calls().some(([, subcommand]) => subcommand === 'inspect'),
      ).toBe(false)
    }),
  )

  it.live('a setup that fails starts no Pi, and removes the container', () =>
    Effect.gen(function* () {
      const state = fixture(['docker'])
      yield* withAgents(
        state,
        Effect.gen(function* () {
          const agents = yield* PiAgent
          const exit = yield* agents
            .start(
              startOf(state, {
                setup: {
                  ...preparedOf().setup,
                  lifecycle: [
                    [['/bin/sh', '-c', 'exit 3']],
                    [['/bin/sh', '-c', 'exit 0']],
                  ],
                },
              }),
            )
            .pipe(Effect.scoped, Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          const error = yield* Effect.flip(exit)
          expect(error).toBeInstanceOf(AgentStartFailed)
          expect(error.message).toContain('setup command')
          expect(error.reason._tag).toBe('ContainerSetup')
        }),
      )
      expect(state.cli.calls().map(([, subcommand]) => subcommand)).toEqual([
        'rm',
        'run',
        'exec',
        'rm',
      ])
    }),
  )

  it.live('a run the runtime refuses is a start failure saying why', () =>
    Effect.gen(function* () {
      const state = fixture(['docker'])
      state.cli.refuse('run')
      yield* withAgents(
        state,
        Effect.gen(function* () {
          const agents = yield* PiAgent
          const error = yield* agents
            .start(startOf(state))
            .pipe(Effect.scoped, Effect.flip)
          expect(error.reason).toEqual(
            AgentStartFailure.Container({
              message:
                "the container fabrica-p1-fa-1 didn't start: it exited 1: refused run",
            }),
          )
        }),
      )
    }),
  )

  it.live('a Pi that never answers leaves no container behind', () =>
    Effect.gen(function* () {
      const state = fixture(['docker'])
      yield* withAgents(
        state,
        Effect.gen(function* () {
          const agents = yield* PiAgent
          const failed = yield* agents
            .start(startOf(state, {}, { PI_STUB_SILENT: '1' }))
            .pipe(Effect.timeout('100 millis'), Effect.scoped, Effect.exit)
          expect(Exit.isFailure(failed)).toBe(true)
        }),
      )
      expect(state.cli.calls().at(-1)).toEqual([
        'docker',
        'rm',
        '--force',
        'fabrica-p1-fa-1',
      ])
    }),
  )

  it.live('gives the runtime how to find its daemon', () =>
    Effect.gen(function* () {
      const state = fixture(['docker'])
      const said = join(state.base, 'said')
      yield* withAgents(
        state,
        Effect.gen(function* () {
          const agents = yield* PiAgent
          const agent = yield* agents
            .start(
              startOf(state, {
                setup: {
                  ...preparedOf().setup,
                  lifecycle: [
                    [['/bin/sh', '-c', `echo "$DOCKER_HOST" > ${said}`]],
                  ],
                },
              }),
            )
            .pipe(Effect.scoped)
          yield* agent.close
        }),
      )
      expect(readFileSync(said, 'utf8')).toBe(
        'unix:///run/user/1000/docker.sock\n',
      )
    }),
  )
})

describe('the git configuration of a container', () => {
  it('holds who commits, as real git reads it, and trusts every folder', () => {
    const repo = join(root, `git${(counter += 1)}`)
    mkdirSync(repo)
    const file = join(repo, 'gitconfig')
    writeFileSync(
      file,
      gitConfigText({
        name: Option.some('Ada "the \\\\ first" Lovelace'),
        email: Option.some('ada@example.invalid'),
      }),
    )
    const git = (...words: ReadonlyArray<string>) =>
      execFileSync('git', [...words], {
        cwd: repo,
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin',
          HOME: repo,
          GIT_CONFIG_GLOBAL: file,
          GIT_CONFIG_NOSYSTEM: '1',
        },
      }).trim()
    expect(git('config', 'user.name')).toBe('Ada "the \\\\ first" Lovelace')
    expect(git('config', 'user.email')).toBe('ada@example.invalid')
    expect(git('config', 'safe.directory')).toBe('*')
  })

  it('names nobody where the host has no identity', () => {
    expect(gitConfigText({ name: Option.none(), email: Option.none() })).toBe(
      '[safe]\n\tdirectory = *\n',
    )
  })

  it.live('reaches every command in the container, by name', () =>
    Effect.gen(function* () {
      const state = fixture(['docker'])
      const note = join(state.base, 'said')
      yield* Effect.provide(
        Effect.gen(function* () {
          const agents = yield* PiAgent
          const agent = yield* agents
            .start({
              ticket,
              project,
              worktree: state.worktree,
              providers: [],
              token: 't',
              model: Option.none(),
              tools: Option.none(),
              resume: Option.none(),
              env: {},
              projectTrusted: false,
              nice: Option.none(),
              container: {
                prepared: preparedOf({
                  distribution: state.distribution,
                  setup: {
                    ...preparedOf().setup,
                    lifecycle: [
                      [['/bin/sh', '-c', `cat "$GIT_CONFIG_GLOBAL" > ${note}`]],
                    ],
                  },
                }),
                mounts: [],
                relay: Option.none(),
                identity: {
                  name: Option.some('Ada'),
                  email: Option.some('ada@example.invalid'),
                },
              },
            })
            .pipe(Effect.scoped)
          yield* agent.close
        }),
        agentLayer({
          node: process.execPath,
          cli: 'unused',
          extension: 'unused',
          data: join(state.base, 'data'),
          configRoot: join(state.base, 'agents'),
          limits: {
            handshake: Duration.seconds(10),
            answer: Duration.seconds(10),
            abort: Duration.seconds(1),
            reap: Duration.seconds(5),
          },
          reaperPoll: Duration.millis(200),
          reaperGrace: Duration.millis(500),
        }).pipe(Layer.provideMerge(state.runner), Layer.provide(layerClock)),
      )
      expect(readFileSync(note, 'utf8')).toContain('name = "Ada"')
      const execs = state.cli
        .calls()
        .filter(([, subcommand]) => subcommand === 'exec')
      for (const exec of execs) expect(exec).toContain('GIT_CONFIG_GLOBAL')
    }),
  )
})

describe('the container reaper', () => {
  it('removes the container once its stdin ends, however the engine died', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const state = fixture(['docker'])
        const reaper = spawn(
          process.execPath,
          containerReaperArguments({ runtime: 'docker', name: 'the-name' }),
          {
            stdio: ['pipe', 'ignore', 'inherit'],
            env: { PATH: state.cli.bin },
          },
        )
        yield* Effect.callback<void>(resume => {
          reaper.once('spawn', () => resume(Effect.void))
        })
        reaper.stdin?.end()
        yield* Effect.callback<void>(resume => {
          reaper.once('exit', () => resume(Effect.void))
        })
        for (let waited = 0; waited < 500; waited++) {
          if (state.cli.calls().flat().includes('the-name')) break
          yield* Effect.sleep('10 millis')
        }
        expect(state.cli.calls()).toEqual([
          ['docker', 'rm', '--force', 'the-name'],
        ])
      }),
    ))
})
