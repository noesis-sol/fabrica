import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Result,
  Scope,
} from 'effect'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { Socket } from 'effect/socket'
import { TestClock } from 'effect/testing'
import { execFileSync, spawn } from 'node:child_process'
import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'
import { Duplex, PassThrough } from 'node:stream'

import { NodeSocket } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import {
  ClientHello,
  EngineHost,
  FabricaRpcs,
  ProjectId,
  ProtocolGroupName,
  TicketId,
  protocolGroups,
  protocolVersion,
} from '@fabrica/contracts'

import {
  EngineAlreadyRunning,
  type EnginePaths,
  EngineScopes,
  enginePaths,
  engineScopesLayer,
  pathsIn,
  runBridge,
  startEngine,
} from '../src/engine'
import { attentionHandlers, secretsHandlers, workersHandlers } from '../src/rpc'

// The engine daemon (spec §7.1, §7.2, §8.1, §8.2, §20.2): an engine started in a temporary data folder,
// called over a real socket and through the bridge's stdio.

const host = new EngineHost({
  platform: 'linux',
  arch: 'x64',
  hostname: 'test-host',
  cores: 8,
})
const release = '1.2.3'

/** A temporary folder for one test, removed when the test ends; short, as a socket's path must be. */
const scratch = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(NodePath.join(tmpdir(), 'fab-d-'))),
  folder => Effect.promise(() => rm(folder, { recursive: true, force: true })),
)

/** An engine's files in a new temporary data folder. */
const scratchPaths = Effect.map(scratch, root =>
  pathsIn({
    data: NodePath.join(root, 'data'),
    socketFolder: NodePath.join(root, 'data'),
  }),
)

const start = (paths: EnginePaths) => startEngine({ paths, host, release })

/** A protocol client over the socket the layer opens, for the current scope. */
const clientOver = Effect.fn(function* (
  socket: Layer.Layer<Socket.Socket, Socket.SocketError>,
) {
  const protocol = yield* Layer.build(
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide([socket, RpcSerialization.layerNdjson]),
    ),
  )
  return yield* RpcClient.make(FabricaRpcs).pipe(Effect.provide(protocol))
})

/** A protocol client on the engine's local socket. */
const clientAt = (path: string) => clientOver(NodeSocket.layerNet({ path }))

const hello = new ClientHello({
  name: 'daemon test',
  kind: 'cli',
  release,
  protocol: protocolVersion,
})

/** The engine package's folder, from which a child process finds `effect`. */
const packageFolder = NodePath.join(import.meta.dirname, '..')

/**
 * A child process that takes the engine's lock at `lock` with the lock module itself (Node strips its
 * types), says `got` or `busy`, and holds what it got until it is released.
 */
const takeLockInChild = (lock: string) =>
  new Promise<{
    readonly answer: string
    readonly release: () => Promise<void>
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const [lockModule, lock] = process.argv.slice(1)
const { Effect, Exit } = await import('effect')
const { acquireEngineLock } = await import(lockModule)
const exit = await Effect.runPromiseExit(Effect.scoped(acquireEngineLock({ lock, socket: lock }).pipe(
  Effect.andThen(Effect.sync(() => console.log('got'))),
  Effect.andThen(Effect.promise(() => new Promise(done => process.stdin.on('end', done).resume()))))))
if (Exit.isFailure(exit)) console.log('busy')`,
        NodePath.join(packageFolder, 'src', 'engine', 'lock.ts'),
        lock,
      ],
      { cwd: packageFolder, env: {}, stdio: ['pipe', 'pipe', 'inherit'] },
    )
    const exited = new Promise<void>(done => child.once('exit', () => done()))
    child.once('error', reject)
    child.stdout.setEncoding('utf8')
    child.stdout.once('data', (text: string) =>
      resolve({
        answer: text.trim(),
        release: () => {
          child.stdin.end()
          return exited
        },
      }),
    )
  })

/** The mode bits of the file at `path`. */
const modeOf = (path: string) =>
  Effect.promise(() => lstat(path)).pipe(Effect.map(info => info.mode & 0o777))

/** Whether an exit is a defect named `NotImplemented`, as the protocol carries it. */
/** The groups whose handlers answer `NotImplemented`: every one but those built (Engine, Tokens, Review, Projects, Backlog, Talks, Insights, Runs). */
type Unfilled = Exclude<
  ProtocolGroupName,
  | 'engine'
  | 'tokens'
  | 'review'
  | 'projects'
  | 'backlog'
  | 'talks'
  | 'insights'
  | 'runs'
>
const unfilled = ProtocolGroupName.literals.filter(
  (group): group is Unfilled =>
    group !== 'engine' &&
    group !== 'tokens' &&
    group !== 'review' &&
    group !== 'projects' &&
    group !== 'backlog' &&
    group !== 'talks' &&
    group !== 'insights' &&
    group !== 'runs',
)

/** Whether a handler's answer is an effect: the handlers built here need no service. */
const isEffect = (answer: unknown): answer is Effect.Effect<unknown, unknown> =>
  Effect.isEffect(answer)

/** A duplex stream reading what `readable` gives and writing to `writable`. */
const joined = (readable: PassThrough, writable: PassThrough): Duplex => {
  const duplex = new Duplex({
    read: () => readable.resume(),
    write: (chunk, _encoding, done) => {
      writable.write(chunk, done)
    },
    final: done => {
      writable.end()
      done()
    },
  })
  readable.on('data', chunk => {
    if (!duplex.push(chunk)) readable.pause()
  })
  readable.on('end', () => duplex.push(null))
  return duplex
}

const answeredNotImplemented = (exit: Exit.Exit<unknown, unknown>): boolean =>
  Exit.isFailure(exit) &&
  Cause.hasDies(exit.cause) &&
  exit.cause.reasons.some(
    reason =>
      Cause.isDieReason(reason) &&
      reason.defect instanceof Error &&
      reason.defect.name === 'NotImplemented',
  )

describe('the engine over its socket', () => {
  it.effect('answers the handshake, version, status and settings', () =>
    Effect.gen(function* () {
      const paths = yield* scratchPaths
      yield* start(paths)
      const client = yield* clientAt(paths.socket)

      const engineHello = yield* client['engine.connect'](hello)
      expect(engineHello.protocol).toBe(protocolVersion)
      expect(engineHello.release).toBe(release)

      const version = yield* client['engine.version']()
      expect(version.release).toBe(release)
      expect(version.protocol).toBe(protocolVersion)
      expect(version.supported).toContain(protocolVersion)

      const status = yield* client['engine.status']()
      expect(status.id).toBe(engineHello.engine)
      expect(status.release).toBe(release)
      expect(status.host).toEqual(host)
      expect(status.projects).toBe(0)
      expect(status.clients).toBe(1)
      // No machine_workers stored: half the host's 8 cores (§7.3).
      expect(status.machineWorkers).toBe(4)
      expect(status.stopping).toBe(false)

      const settings = yield* client['engine.settings']()
      expect(settings.keep_awake).toBe(true)
      expect(Option.isNone(settings.machine_workers)).toBe(true)
    }),
  )

  it.effect('tells a client too new for it which side to update', () =>
    Effect.gen(function* () {
      const paths = yield* scratchPaths
      yield* start(paths)
      const client = yield* clientAt(paths.socket)
      const mismatch = yield* client['engine.connect'](
        new ClientHello({ ...hello, protocol: protocolVersion + 2 }),
      ).pipe(Effect.flip)
      if (mismatch._tag !== 'VersionMismatch') {
        return expect.fail(`not a version mismatch: ${mismatch.message}`)
      }
      expect(mismatch.update).toBe('engine')
    }),
  )

  it.effect('keeps its ID from one start to the next', () =>
    Effect.gen(function* () {
      const paths = yield* scratchPaths
      const idOnce = Effect.scoped(
        Effect.gen(function* () {
          yield* start(paths)
          const client = yield* clientAt(paths.socket)
          return (yield* client['engine.status']()).id
        }),
      )
      const first = yield* idOnce
      expect(yield* idOnce).toBe(first)
    }),
  )

  it.effect(
    'answers engine.stop, says it is stopping and asks its scope to end',
    () =>
      Effect.gen(function* () {
        const paths = yield* scratchPaths
        const engine = yield* start(paths)
        const client = yield* clientAt(paths.socket)
        yield* client['engine.stop']()
        yield* engine.stopRequested
        expect((yield* client['engine.status']()).stopping).toBe(true)
      }),
  )
})

describe('one engine per data folder', () => {
  it.effect(
    'a second engine fails, saying one runs, until the first has ended',
    () =>
      Effect.gen(function* () {
        const paths = yield* scratchPaths
        const scope = yield* Scope.make()
        yield* start(paths).pipe(Scope.provide(scope))

        const second = yield* Effect.scoped(start(paths)).pipe(Effect.flip)
        expect(second).toBeInstanceOf(EngineAlreadyRunning)
        expect(second.message).toContain(paths.socket)

        // The first engine still serves.
        const client = yield* clientAt(paths.socket)
        expect((yield* client['engine.version']()).release).toBe(release)

        yield* Scope.close(scope, Exit.void)
        yield* Effect.scoped(start(paths))
      }),
  )

  it.effect('of two engines taking the lock at once, exactly one gets it', () =>
    Effect.gen(function* () {
      const root = yield* scratch
      for (const trial of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const lock = NodePath.join(root, `engine-${trial}.lock`)
        const both = yield* Effect.promise(() =>
          Promise.all([takeLockInChild(lock), takeLockInChild(lock)]),
        )
        expect(
          both.map(({ answer }) => answer).toSorted(),
          `trial ${trial}`,
        ).toEqual(['busy', 'got'])
        yield* Effect.promise(() =>
          Promise.all(both.map(({ release }) => release())),
        )
      }
    }),
  )

  it.effect('replaces the socket an engine that died left behind', () =>
    Effect.gen(function* () {
      const paths = yield* scratchPaths
      yield* Effect.scoped(start(paths))
      // A process that listens at the socket and dies before it can remove it.
      yield* Effect.sync(() => {
        try {
          execFileSync(
            process.execPath,
            [
              '-e',
              `require('node:net').createServer().listen(${JSON.stringify(paths.socket)}, () => process.kill(process.pid, 'SIGKILL'))`,
            ],
            { env: {} },
          )
        } catch {
          // It died of its SIGKILL, as it meant to.
        }
      })
      expect(
        (yield* Effect.promise(() => lstat(paths.socket))).isSocket(),
      ).toBe(true)

      yield* start(paths)
      const client = yield* clientAt(paths.socket)
      expect((yield* client['engine.version']()).release).toBe(release)
    }),
  )
})

describe('the socket and the data folder', () => {
  it.effect('the socket is mode 0600, in folders only the user enters', () =>
    Effect.gen(function* () {
      const root = yield* scratch
      const paths = pathsIn({
        data: NodePath.join(root, 'data'),
        socketFolder: NodePath.join(root, 'run', 'fabrica'),
      })
      yield* start(paths)
      expect(yield* modeOf(paths.socket)).toBe(0o600)
      expect(yield* modeOf(paths.socketFolder)).toBe(0o700)
      expect(yield* modeOf(paths.data)).toBe(0o700)
      expect(yield* modeOf(paths.logs)).toBe(0o700)
    }),
  )

  it('is where each platform keeps it', () => {
    const home = '/home/m'
    const darwin = enginePaths({
      platform: 'darwin',
      home: '/Users/m',
      environment: {},
    })
    expect(Result.getOrThrow(darwin)).toMatchObject({
      data: '/Users/m/Library/Application Support/fabrica',
      database: '/Users/m/Library/Application Support/fabrica/engine.db',
      lock: '/Users/m/Library/Application Support/fabrica/engine.lock',
      socket: '/Users/m/Library/Application Support/fabrica/engine.sock',
    })
    expect(
      Result.getOrThrow(
        enginePaths({ platform: 'linux', home, environment: {} }),
      ),
    ).toMatchObject({
      data: '/home/m/.local/share/fabrica',
      socket: '/home/m/.local/share/fabrica/engine.sock',
    })
    expect(
      Result.getOrThrow(
        enginePaths({
          platform: 'linux',
          home,
          environment: {
            XDG_DATA_HOME: '/data',
            XDG_RUNTIME_DIR: '/run/user/1000',
          },
        }),
      ),
    ).toMatchObject({
      data: '/data/fabrica',
      lock: '/data/fabrica/engine.lock',
      socketFolder: '/run/user/1000/fabrica',
      socket: '/run/user/1000/fabrica/engine.sock',
    })
    // The XDG specification ignores a relative path.
    expect(
      Result.getOrThrow(
        enginePaths({
          platform: 'linux',
          home,
          environment: { XDG_DATA_HOME: 'data' },
        }),
      ).data,
    ).toBe('/home/m/.local/share/fabrica')
    expect(
      Result.isFailure(
        enginePaths({ platform: 'win32', home, environment: {} }),
      ),
    ).toBe(true)
  })
})

describe('the groups not served yet', () => {
  it.effect(
    'answer NotImplemented over the socket, and the connection stays',
    () =>
      Effect.gen(function* () {
        const paths = yield* scratchPaths
        yield* start(paths)
        const client = yield* clientAt(paths.socket)
        const project = ProjectId.make('app')
        const ticket = TicketId.make('fa-a1b2')
        const calls: Record<Unfilled, Effect.Effect<unknown, unknown>> = {
          secrets: client['credentials.list'](),
          workers: client['worker.release']({ project, ticket }),
          attention: client['attention.list']({ project: Option.none() }),
        }
        for (const group of unfilled) {
          const exit = yield* Effect.exit(calls[group])
          expect(answeredNotImplemented(exit), group).toBe(true)
        }
        expect((yield* client['engine.version']()).release).toBe(release)
      }),
  )

  it.effect('answer NotImplemented to every request and stream', () =>
    Effect.gen(function* () {
      const layers: Record<Unfilled, Layer.Layer<never>> = {
        secrets: secretsHandlers,
        workers: workersHandlers,
        attention: attentionHandlers,
      }
      for (const group of unfilled) {
        const handlers = yield* Layer.build(layers[group])
        const requests = protocolGroups[group].requests
        expect(requests.size).toBeGreaterThan(0)
        for (const rpc of requests.values()) {
          const entry: unknown = handlers.mapUnsafe.get(rpc.key)
          if (
            typeof entry !== 'object' ||
            entry === null ||
            !('handler' in entry) ||
            typeof entry.handler !== 'function'
          ) {
            expect.fail(`${rpc._tag} has no handler`)
            continue
          }
          const answer: unknown = entry.handler(undefined, {})
          if (!isEffect(answer)) {
            expect.fail(`${rpc._tag} answered with no effect`)
            continue
          }
          expect(
            answeredNotImplemented(yield* Effect.exit(answer)),
            rpc._tag,
          ).toBe(true)
        }
      }
    }),
  )
})

describe('the bridge', () => {
  /** The bridge's stdio, and a client on its other end. */
  const bridgeStdio = Effect.gen(function* () {
    const input = new PassThrough()
    const output = new PassThrough()
    const client = yield* clientOver(
      Layer.effect(
        Socket.Socket,
        NodeSocket.fromDuplex(Effect.succeed(joined(output, input))),
      ),
    )
    return { input, output, client }
  })

  it.effect(
    'starts the engine when none runs, and carries the protocol over its stdio',
    () =>
      Effect.gen(function* () {
        const paths = yield* scratchPaths
        const scope = yield* Effect.scope
        const starts = yield* Ref.make(0)
        const { input, output, client } = yield* bridgeStdio
        const bridge = yield* runBridge({
          socket: paths.socket,
          input,
          output,
          // Starts the engine in the test's scope, and returns once it listens, as a detached one would.
          // Starts the engine and returns once it listens, as a detached one would; its scope ends once
          // it is asked to stop, as `serveEngine`'s does.
          startEngine: Effect.gen(function* () {
            yield* Ref.update(starts, n => n + 1)
            const engineScope = yield* Scope.fork(scope)
            const engine = yield* start(paths).pipe(Scope.provide(engineScope))
            yield* engine.stopRequested.pipe(
              Effect.andThen(Scope.close(engineScope, Exit.void)),
              Effect.forkIn(scope),
            )
          }).pipe(Effect.orDie),
        }).pipe(Effect.forkScoped)

        const engineHello = yield* client['engine.connect'](hello)
        expect(engineHello.release).toBe(release)
        expect((yield* client['engine.version']()).release).toBe(release)
        const status = yield* client['engine.status']()
        expect(status.id).toBe(engineHello.engine)
        expect(status.clients).toBe(1)
        expect(yield* Ref.get(starts)).toBe(1)

        // The engine ends the connection as it stops, and the bridge ends with it.
        yield* client['engine.stop']()
        yield* Fiber.join(bridge)
      }),
  )

  it.effect('reaches a running engine without starting one', () =>
    Effect.gen(function* () {
      const paths = yield* scratchPaths
      yield* start(paths)
      const { input, output, client } = yield* bridgeStdio
      yield* runBridge({
        socket: paths.socket,
        input,
        output,
        startEngine: Effect.die('the bridge started an engine while one ran'),
      }).pipe(Effect.forkScoped)
      expect((yield* client['engine.status']()).release).toBe(release)
    }),
  )

  it.effect('fails when a started engine takes no connection', () =>
    Effect.gen(function* () {
      const paths = yield* scratchPaths
      const bridge = yield* runBridge({
        socket: paths.socket,
        input: new PassThrough(),
        output: new PassThrough(),
        startEngine: Effect.void,
      }).pipe(Effect.flip, Effect.forkScoped)
      yield* TestClock.adjust('10 seconds')
      const failure = yield* Fiber.join(bridge)
      expect(failure._tag).toBe('BridgeFailed')
      expect(failure.message).toContain('took no connection')
    }),
  )
})

describe('the engine scopes', () => {
  it.effect('end the runs, then the agents, then the servers', () =>
    Effect.gen(function* () {
      const ended: Array<string> = []
      const root = yield* Scope.make()
      const scopes = Context.get(
        yield* Layer.buildWithScope(engineScopesLayer, root),
        EngineScopes,
      )
      const record = (name: string) => Effect.sync(() => ended.push(name))
      yield* Scope.addFinalizer(scopes.servers, record('servers'))
      yield* Scope.addFinalizer(scopes.agents, record('agents'))
      yield* Scope.addFinalizer(scopes.runs, record('runs'))
      yield* Scope.close(root, Exit.void)
      expect(ended).toEqual(['runs', 'agents', 'servers'])
    }),
  )
})
