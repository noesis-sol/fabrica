import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Redacted,
  Schedule,
  Stream,
} from 'effect'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import { Socket, SocketServer } from 'effect/socket'
import { TestClock } from 'effect/testing'
import { writeFile } from 'node:fs/promises'
import * as Net from 'node:net'
import * as NodePath from 'node:path'

import { NodeSocketServer } from '@effect/platform-node'
import { describe, expect, layer } from '@effect/vitest'
import { EngineHello, EngineId, EngineRpcs } from '@fabrica/contracts'
import { Toolbox, layerToolbox, shStub, tempFolder } from '@fabrica/testkit'

import { Link, SshDestination, make } from '../src'
import {
  SshPrompting,
  type SshPrompts,
  layerSsh,
  reachLimit,
  sshReconnect,
  sshSocket,
} from '../src/node'

// A connection over the SSH bridge opens once the engine is reached (H61), not as ssh starts: the RPC's
// pinger fails a connection whose ping goes unanswered for about 10 s once it opens, so a prompt ssh
// holds longer, a passphrase the user looks up, must not fail it. Against a stub `ssh` that asks through
// `SSH_ASKPASS` before it bridges its stdio to a minimal engine, or waits for the test's word (as ssh
// waits on a terminal's prompt, or on a security key's touch while its notice shows), or never answers;
// on the TestClock.

const stubScript = `
const net = process.getBuiltinModule('node:net')
const { spawn, spawnSync } = process.getBuiltinModule('node:child_process')
if (process.argv[2] === '-V') {
  process.stderr.write('OpenSSH_9.6p1 Ubuntu-3ubuntu13.5, OpenSSL 3.0.13 30 Jan 2024\\n')
  process.exit(0)
}
const bridge = () => {
  const socket = net.connect(process.env.STUB_ENGINE)
  process.stdin.pipe(socket)
  socket.pipe(process.stdout)
  socket.on('close', () => process.exit(255))
  socket.on('error', () => process.exit(255))
}
if (process.env.STUB_MODE === 'passphrase') {
  const asked = spawnSync(process.env.SSH_ASKPASS, ["Enter passphrase for key '/home/u/.ssh/id_ed25519': "], { stdio: ['ignore', 'pipe', 'inherit'] })
  if (asked.status === 0 && asked.stdout.toString('utf8') === 'open sesame\\n') bridge()
  else {
    process.stderr.write('u@server-1: Permission denied (publickey).\\n')
    process.exit(255)
  }
} else if (process.env.STUB_MODE === 'touch') {
  // As ssh waits on a security key's touch: a notice through the helper, stopped once touched.
  const notice = spawn(process.env.SSH_ASKPASS, ['Confirm user presence for key ED25519-SK SHA256:47DEQpj8HBSa'], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, SSH_ASKPASS_PROMPT: 'none' },
  })
  const control = net.connect(process.env.STUB_CONTROL)
  control.once('data', () => {
    notice.kill('SIGTERM')
    bridge()
  })
} else {
  // Says it started, then bridges once told to: never, in 'silent' mode.
  const control = net.connect(process.env.STUB_CONTROL)
  control.once('data', bridge)
}
`

const toolbox = layerToolbox({
  stubs: { ssh: shStub('exec "$STUB_NODE" "$STUB_SCRIPT" "$@"') },
})

const destination = SshDestination.make('u@server-1')

/** A minimal engine on a Unix socket at `path`: its hello, nothing else. */
const serveEngine = (path: string) =>
  Effect.gen(function* () {
    const handlers = EngineRpcs.toLayer({
      'engine.connect': hello =>
        Effect.succeed(
          new EngineHello({
            protocol: hello.protocol,
            engine: EngineId.make('e-1'),
            release: '0.1.0',
          }),
        ),
      'engine.version': () => Effect.die('not served'),
      'engine.status': () => Effect.die('not served'),
      'engine.settings': () => Effect.die('not served'),
      'engine.stop': () => Effect.die('not served'),
      'engine.update': () => Effect.die('not served'),
      'engine.watchStatus': () => Stream.die('not served'),
      'engine.watchLoad': () => Stream.die('not served'),
    })
    const server: SocketServer.SocketServer['Service'] =
      yield* NodeSocketServer.make({ path })
    yield* Layer.build(
      RpcServer.layer(EngineRpcs).pipe(
        Layer.provide(handlers),
        Layer.provide(RpcServer.layerProtocolSocketServer),
        Layer.provide(RpcSerialization.layerNdjson),
        Layer.provide(Layer.succeed(SocketServer.SocketServer, server)),
      ),
    )
  })

/** Where the stub says it started: each of its runs, as a connection to write the word to go on to. */
const controlAt = (path: string) =>
  Effect.gen(function* () {
    const started = yield* Queue.unbounded<Net.Socket>()
    const server = Net.createServer(socket =>
      Queue.offerUnsafe(started, socket),
    )
    yield* Effect.acquireRelease(
      Effect.callback<void>(resume => {
        server.listen(path, () => resume(Effect.void))
      }),
      () => Effect.sync(() => server.close()),
    )
    return Queue.take(started)
  })

/** A test's stub in `mode`, its engine and control, and ssh's environment. */
const setUp = (mode: 'passphrase' | 'touch' | 'wait' | 'silent') =>
  Effect.gen(function* () {
    const tools = yield* Toolbox
    const dir = yield* tempFolder('ssh-reach')
    const script = NodePath.join(dir, 'stub.mjs')
    const engine = NodePath.join(dir, 'engine.sock')
    const control = NodePath.join(dir, 'control.sock')
    yield* Effect.promise(() => writeFile(script, stubScript))
    yield* serveEngine(engine)
    return {
      dir,
      started: yield* controlAt(control),
      env: tools.env({
        STUB_MODE: mode,
        STUB_NODE: process.execPath,
        STUB_SCRIPT: script,
        STUB_ENGINE: engine,
        STUB_CONTROL: control,
      }),
    }
  })

const clientOver = (
  env: Readonly<Record<string, string>>,
  prompting: SshPrompting,
) =>
  make({
    name: 'test client',
    kind: 'cli',
    release: '0.1.0',
    protocol: 1,
    reconnect: sshReconnect(Schedule.spaced('10 millis')),
  }).pipe(Effect.provide(layerSsh({ destination, env, prompting })))

/** One turn of the event loop, for the real I/O an effect waits on (a write to ssh's stdin) to finish. */
const turn = Effect.promise(
  () => new Promise<void>(resolve => setImmediate(resolve)),
)

/**
 * Moves the TestClock on past `reachLimit` and the pinger's 10 s, a second at a time with turns of the
 * event loop between: the pinger writes its ping before it waits for the next, and the write is real.
 */
const holdPastLimits = Effect.forEach(
  Array.from({ length: Duration.toSeconds(reachLimit) + 30 }),
  () =>
    Effect.andThen(TestClock.adjust('1 second'), Effect.andThen(turn, turn)),
  { discard: true },
)

/** Prompts whose passphrase is given once `answer` is, `asked` told as ssh asks for it. */
const heldPassphrase = Effect.gen(function* () {
  const asked = yield* Deferred.make<void>()
  const answer = yield* Deferred.make<void>()
  const prompts: SshPrompts = {
    hostKey: () => Effect.succeed(false),
    secret: () =>
      Deferred.succeed(asked, undefined).pipe(
        Effect.andThen(Deferred.await(answer)),
        Effect.as(Option.some(Redacted.make('open sesame'))),
      ),
    confirm: () => Effect.succeed(false),
    notice: () => Effect.void,
  }
  return {
    prompts,
    asked: Deferred.await(asked),
    answer: Deferred.succeed(answer, undefined),
  }
})

describe('a connection over the SSH bridge, opened once the engine is reached', () => {
  layer(toolbox)(it => {
    it.effect(
      'says hello on its first connection after a prompt held past the pinger and the reach limit',
      () =>
        Effect.gen(function* () {
          const { dir, env } = yield* setUp('passphrase')
          const held = yield* heldPassphrase
          const starting = yield* Effect.forkChild(
            clientOver(
              env,
              SshPrompting.Relay({
                node: process.execPath,
                folder: dir,
                prompts: held.prompts,
              }),
            ),
          )
          yield* held.asked
          yield* holdPastLimits
          yield* held.answer
          const client = yield* Fiber.join(starting)
          const link = yield* client.link
          expect(Link.$is('Up')(link) && link.connection).toBe(1)
        }).pipe(Effect.scoped),
    )

    it.effect(
      'waits on a security key while its notice shows, then says hello on its first connection',
      () =>
        Effect.gen(function* () {
          const { dir, env, started } = yield* setUp('touch')
          const noticed = yield* Deferred.make<void>()
          const starting = yield* Effect.forkChild(
            clientOver(
              env,
              SshPrompting.Relay({
                node: process.execPath,
                folder: dir,
                prompts: {
                  hostKey: () => Effect.succeed(false),
                  secret: () => Effect.succeed(Option.none()),
                  confirm: () => Effect.succeed(false),
                  notice: () => Deferred.succeed(noticed, undefined),
                },
              }),
            ),
          )
          const ssh = yield* started
          yield* Deferred.await(noticed)
          yield* holdPastLimits
          ssh.write('touched')
          const client = yield* Fiber.join(starting)
          const link = yield* client.link
          expect(Link.$is('Up')(link) && link.connection).toBe(1)
        }).pipe(Effect.scoped),
    )

    it.effect(
      'waits on the terminal as long as ssh does, then says hello on its first connection',
      () =>
        Effect.gen(function* () {
          const { env, started } = yield* setUp('wait')
          const starting = yield* Effect.forkChild(
            clientOver(env, SshPrompting.Terminal()),
          )
          const ssh = yield* started
          yield* holdPastLimits
          ssh.write('go')
          const client = yield* Fiber.join(starting)
          const link = yield* client.link
          expect(Link.$is('Up')(link) && link.connection).toBe(1)
        }).pipe(Effect.scoped),
    )

    it.effect('fails an open that reaches no engine within the limit', () =>
      Effect.gen(function* () {
        const { env, started } = yield* setUp('silent')
        const socket = yield* sshSocket({
          destination,
          env,
          prompting: SshPrompting.None(),
        })
        const opening = yield* Effect.forkChild(
          Effect.flip(Effect.scoped(socket.reader)),
        )
        yield* started
        yield* TestClock.adjust(reachLimit)
        const failed: Socket.SocketError = yield* Fiber.join(opening)
        expect(failed.reason).toMatchObject({
          _tag: 'SocketOpenError',
          kind: 'Timeout',
        })
      }).pipe(Effect.scoped),
    )
  })
})
