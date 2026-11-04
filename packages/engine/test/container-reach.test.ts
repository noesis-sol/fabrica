import { Duration, Effect, Layer, Option, Redacted } from 'effect'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as NodeSocket from '@effect/platform-node-shared/NodeSocket'
import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  CommandSetting,
  ControlAddressVariable,
  ControlRpcs,
  ControlSocketVariable,
  ControlTokenVariable,
  PermissionDecision,
  ProjectId,
  SessionId,
  TicketId,
  controlTokenClient,
} from '@fabrica/contracts'

import { type PreparedContainers, RuntimePlacement } from '../src/agent'
import { layer as checksLayer } from '../src/checks'
import {
  Attention,
  ControlRole,
  ControlServer,
  ControlTransport,
  checkOwnPassesLayer,
  layer as controlLayer,
} from '../src/control'
import { type GitConfig, layer as gitLayer } from '../src/git'
import {
  type RunnerConfig,
  commandEnvironment,
  hostHolders,
  hostPriority,
  layerClock,
  listProcesses,
  layer as runnerLayer,
} from '../src/process'
import {
  type AgentProxy,
  Authentication,
  ModelProxy,
  type ProviderRoute,
  layerOpen,
  make as makeProxy,
} from '../src/proxy'
import { containedAgent, controlTransportOf } from '../src/run/contained'
import { SecretMissing, Secrets } from '../src/secrets'
import { layerWake, noSleepCauses } from '../src/time'
import { WorkGraph, makeWorkGraph, storeLayer } from '../src/workgraph'

// How a worker in a container reaches the engine (spec §12.7): the control channel over its token-scoped
// TCP listener on Podman Machine (fab-mgi.61), the model proxy over a Unix socket of the agent's on Linux
// (fab-mgi.60), and each provider's URL and each mount as the runtime it runs on needs them.

let root = ''
let counter = 0
let gitFolder = ''

beforeAll(() => {
  // Short, so the sockets' paths stay under the 103 bytes every platform takes.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fab-reach-')))
  gitFolder = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
})

const folder = (name: string): string => {
  counter += 1
  const path = join(root, `${name}${counter}`)
  mkdirSync(path)
  return path
}

const runnerConfig = (): RunnerConfig => ({
  hostEnvironment: {
    PATH: `${gitFolder}:/usr/bin:/bin`,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
  },
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
  readRetries: { times: 1, spacing: Duration.zero },
}

const gitServices = () =>
  Layer.provide(
    gitLayer(gitConfig),
    Layer.provide(runnerLayer(runnerConfig()), layerClock),
  )

const controlServices = () => {
  const runner = Layer.provide(runnerLayer(runnerConfig()), layerClock)
  const gitService = gitServices()
  return controlLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        checkOwnPassesLayer.pipe(
          Layer.provideMerge(
            Layer.effect(WorkGraph, makeWorkGraph({ prefix: 'fa' })),
          ),
          Layer.provideMerge(storeLayer(':memory:')),
        ),
        gitService,
        Layer.provide(checksLayer, Layer.merge(runner, gitService)),
        Layer.provide(layerWake, noSleepCauses),
        Layer.succeed(Attention)({
          permission: () =>
            Effect.succeed(PermissionDecision.cases.allow_run.make({})),
          autoAnswer: () => Effect.succeedNone,
        }),
      ),
    ),
  )
}

const ticket = TicketId.make('fa-1')
const project = ProjectId.make('p1')

const openChannel = (transport: ControlTransport) =>
  Effect.gen(function* () {
    const graph = yield* WorkGraph
    const own = yield* graph.create({
      ticket: { type: 'task', title: 'Reach the engine' },
      actor: { _tag: 'maintainer' },
    })
    const control = yield* ControlServer
    const channel = yield* control.open({
      project,
      ticket: own.id,
      session: SessionId.make('session-1'),
      role: ControlRole.Worker(),
      worktree: folder('w'),
      folder: folder('s'),
      transport,
      questionWait: Duration.minutes(15),
      mergeStanding: Effect.succeed('not_queued'),
      checkOwn: {
        command: CommandSetting.cases.None.make({}),
        checkout: folder('c'),
        timeLimit: Duration.minutes(1),
        cores: 1,
        nice: Option.none(),
      },
    })
    return { channel, own: own.id }
  })

describe('the control channel over TCP', () => {
  it.live(
    'listens on loopback, is named by its reached address, and takes the token alone',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { channel, own } = yield* openChannel(
            ControlTransport.Tcp({ reachedAt: '192.168.127.254' }),
          )
          expect(channel.socket).toMatch(/^127\.0\.0\.1:\d+$/u)
          const port = Number(channel.socket.split(':')[1])
          expect(channel.environment[ControlAddressVariable]).toBe(
            `192.168.127.254:${port}`,
          )
          expect(channel.environment[ControlSocketVariable]).toBeUndefined()
          const clientWith = (token: string) =>
            Effect.gen(function* () {
              const context = yield* Layer.build(
                Layer.mergeAll(
                  RpcClient.layerProtocolSocket().pipe(
                    Layer.provide(
                      NodeSocket.layerNet({ host: '127.0.0.1', port }),
                    ),
                    Layer.provide(RpcSerialization.layerNdjson),
                  ),
                  controlTokenClient(token),
                ),
              )
              return yield* Effect.provide(RpcClient.make(ControlRpcs), context)
            })
          const client = yield* clientWith(
            channel.environment[ControlTokenVariable] ?? '',
          )
          const shown = yield* client.get_ticket({ id: Option.some(own) })
          expect(shown.ticket.id).toBe(own)
          const refused = yield* clientWith('not its token')
          const failure = yield* refused
            .get_ticket({ id: Option.some(own) })
            .pipe(Effect.flip)
          expect(failure._tag).toBe('ControlUnauthorized')
        }),
      ).pipe(Effect.provide(controlServices())),
  )

  it.live('the socket stays where none is asked for', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { channel } = yield* openChannel(ControlTransport.Unix())
        expect(channel.environment[ControlSocketVariable]).toBe(channel.socket)
        expect(channel.environment[ControlAddressVariable]).toBeUndefined()
      }),
    ).pipe(Effect.provide(controlServices())),
  )
})

const secrets = Secrets.of({
  store: 'file',
  set: () => Effect.void,
  list: Effect.succeed([]),
  get: name => Effect.fail(new SecretMissing({ name })),
  read: () => Effect.succeedNone,
  modify: () => Effect.succeedNone,
  remove: () => Effect.succeed(false),
})

describe('the model proxy on a mounted socket', () => {
  const routes: ReadonlyArray<ProviderRoute> = [
    {
      provider: 'anthropic',
      upstream: 'http://127.0.0.1:9',
      api: 'anthropic-messages',
      authentication: Authentication.None(),
    },
  ]

  it.live(
    'answers there as on its port, only its owner let in, and is gone with the scope',
    () =>
      Effect.gen(function* () {
        const socket = join(folder('p'), 'fa-1.p.sock')
        yield* Effect.scoped(
          Effect.gen(function* () {
            const proxy = yield* makeProxy({ routes }).pipe(
              Effect.provideService(Secrets, secrets),
              Effect.provide(layerOpen),
            )
            yield* proxy.listenOn(socket)
            expect(statSync(socket).mode & 0o777).toBe(0o600)
            const status = yield* Effect.callback<number>(resume => {
              const call = request(
                {
                  socketPath: socket,
                  path: '/anthropic/v1/messages',
                  method: 'POST',
                },
                answer => {
                  answer.resume()
                  resume(Effect.succeed(answer.statusCode ?? 0))
                },
              )
              call.on('error', error => resume(Effect.die(error)))
              call.end('{}')
            })
            // No token: the way in is the same as on its port.
            expect(status).toBe(401)
          }),
        )
        expect(() => statSync(socket)).toThrow()
      }),
  )

  it.live('says why where the socket cannot open', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const proxy = yield* makeProxy({ routes }).pipe(
          Effect.provideService(Secrets, secrets),
          Effect.provide(layerOpen),
        )
        const failure = yield* proxy
          .listenOn(join(root, 'no-such-folder', 'x.sock'))
          .pipe(Effect.flip)
        expect(failure.message).toContain('no-such-folder')
      }),
    ),
  )
})

const preparedOn = (placement: RuntimePlacement): PreparedContainers => ({
  placement,
  image: 'i',
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
  memory: 1,
  cpus: 1,
  network: Option.none(),
  distribution: { root: '/d', node: 'n', cli: 'c', extension: 'e' },
  uid: 1,
  gid: 1,
  environment: {},
  notices: [],
})

describe('what an agent is given for its container', () => {
  const granted: AgentProxy = {
    token: Redacted.make('t'),
    baseUrls: {},
    providers: [
      { provider: 'anthropic', baseUrl: 'http://127.0.0.1:4242/anthropic' },
    ],
  }

  const contained = (placement: Option.Option<RuntimePlacement>) => {
    const repo = folder('r')
    execFileSync('git', ['init', '--quiet'], {
      cwd: repo,
      env: { PATH: `${gitFolder}:/usr/bin:/bin`, HOME: root },
    })
    const sockets = folder('s')
    const listened: Array<string> = []
    const proxy = ModelProxy.of({
      address: 'http://127.0.0.1:4242',
      grant: () => Effect.die('unused'),
      listenOn: socket =>
        Effect.sync(() => {
          listened.push(socket)
        }),
      events: Effect.die('unused'),
      windows: Effect.succeed([]),
      probe: () => Effect.die('unused'),
      refresh: () => Effect.die('unused'),
    })
    return containedAgent({
      ticket,
      checkout: repo,
      worktree: repo,
      sockets,
      containers: Option.map(placement, preparedOn),
      channel: { socket: join(sockets, 'fa-1.sock') },
      granted,
    }).pipe(
      Effect.scoped,
      Effect.provideService(ModelProxy, proxy),
      Effect.provide(gitServices()),
      Effect.map(given => ({ given, repo, sockets, listened })),
    )
  }

  it.live('nothing where the project has no container', () =>
    Effect.gen(function* () {
      const { given, listened } = yield* contained(Option.none())
      expect(given.providers).toEqual(granted.providers)
      expect(given.container).toEqual({})
      expect(listened).toEqual([])
    }),
  )

  it.live(
    'on Linux, both sockets mounted and the relay, its proxy URLs as they are',
    () =>
      Effect.gen(function* () {
        const { given, repo, sockets, listened } = yield* contained(
          Option.some(RuntimePlacement.RootlessLinux({ runtime: 'podman' })),
        )
        const socket = join(sockets, 'fa-1.p.sock')
        expect(listened).toEqual([socket])
        expect(given.providers).toEqual(granted.providers)
        expect(given.container.container?.relay).toEqual(
          Option.some({ port: '4242', socket }),
        )
        const targets = given.container.container?.mounts.map(
          mount => mount.target,
        )
        expect(targets).toEqual(
          expect.arrayContaining([
            join(sockets, 'fa-1.sock'),
            socket,
            join(repo, '.git'),
          ]),
        )
      }),
  )

  it.live(
    'on Docker Desktop, the control socket mounted and the proxy at its host name',
    () =>
      Effect.gen(function* () {
        const { given, sockets, listened } = yield* contained(
          Option.some(RuntimePlacement.DockerDesktop()),
        )
        expect(listened).toEqual([])
        expect(given.providers[0]?.baseUrl).toBe(
          'http://host.docker.internal:4242/anthropic',
        )
        expect(given.container.container?.relay).toEqual(Option.none())
        expect(
          given.container.container?.mounts.map(mount => mount.target),
        ).toContain(join(sockets, 'fa-1.sock'))
      }),
  )

  it.live(
    'on Podman Machine, no socket mounted, both reached over gvproxy',
    () =>
      Effect.gen(function* () {
        const { given, sockets, listened } = yield* contained(
          Option.some(RuntimePlacement.PodmanMachine()),
        )
        expect(listened).toEqual([])
        expect(given.providers[0]?.baseUrl).toBe(
          'http://192.168.127.254:4242/anthropic',
        )
        expect(
          given.container.container?.mounts.filter(mount =>
            mount.target.startsWith(sockets),
          ),
        ).toEqual([])
      }),
  )

  it('asks for the channel the placement reaches', () => {
    expect(controlTransportOf({ containers: Option.none() })).toEqual(
      ControlTransport.Unix(),
    )
    expect(
      controlTransportOf({
        containers: Option.some(preparedOn(RuntimePlacement.DockerDesktop())),
      }),
    ).toEqual(ControlTransport.Unix())
    expect(
      controlTransportOf({
        containers: Option.some(preparedOn(RuntimePlacement.PodmanMachine())),
      }),
    ).toEqual(ControlTransport.Tcp({ reachedAt: '192.168.127.254' }))
  })
})

describe("the runtime's environment", () => {
  const host = {
    PATH: '/bin',
    DOCKER_HOST: 'unix:///d.sock',
    CONTAINER_HOST: 'ssh://p',
  }

  it('reaches only a command that drives the runtime', () => {
    expect(commandEnvironment({ host, extra: {} })).toEqual({ PATH: '/bin' })
    expect(
      commandEnvironment({ host, extra: {}, containerRuntime: true }),
    ).toEqual(host)
  })
})
