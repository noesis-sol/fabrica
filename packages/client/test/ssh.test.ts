import {
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  PubSub,
  Queue,
  Redacted,
  Ref,
  Result,
  Schedule,
  Schema,
  Stream,
} from 'effect'
import { RpcClientError, RpcSerialization, RpcServer } from 'effect/rpc'
import { Socket, SocketServer } from 'effect/socket'
import { readFile, writeFile } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { NodeSocketServer } from '@effect/platform-node'
import { describe, expect, it, layer } from '@effect/vitest'
import {
  EngineHello,
  EngineId,
  EngineRpcs,
  EngineStatus,
  type Resume,
  ResumePlan,
  StreamEpoch,
  planResume,
} from '@fabrica/contracts'
import { Toolbox, layerToolbox, shStub, tempFolder } from '@fabrica/testkit'

import {
  type EngineClientShape,
  Link,
  SshDestination,
  type StreamItem,
  make,
} from '../src'
import {
  type HostKeyPrompt,
  SshFailed,
  type SshFailure,
  SshPrompting,
  type SshPrompts,
  type TextPrompt,
  layerSsh,
  parseSshVersion,
  sshEnded,
  sshFailed,
  sshReconnect,
} from '../src/node'

// The SSH bridge against a stub `ssh` at the process boundary: a Node script standing in for OpenSSH,
// which records each run's arguments and askpass variables, then does what its folder's `mode` file
// says: bridges its stdio to a minimal engine's socket as `ssh host fabrica bridge` would, refuses a
// changed host key in OpenSSH's words, or asks through `SSH_ASKPASS` (an unknown host's key, a key's
// passphrase) before it bridges. The engine's end of a connection can be cut, as a dead link ends it.

const stubScript = `
const fs = process.getBuiltinModule('node:fs')
const net = process.getBuiltinModule('node:net')
const path = process.getBuiltinModule('node:path')
const { spawnSync } = process.getBuiltinModule('node:child_process')
const dir = process.env.STUB_DIR
const args = process.argv.slice(2)
if (args[0] === '-V') {
  process.stderr.write(fs.readFileSync(path.join(dir, 'version'), 'utf8'))
  process.exit(0)
}
fs.appendFileSync(path.join(dir, 'runs.log'), JSON.stringify({
  args,
  askpass: process.env.SSH_ASKPASS ?? null,
  require: process.env.SSH_ASKPASS_REQUIRE ?? null,
}) + '\\n')
const mode = fs.readFileSync(path.join(dir, 'mode'), 'utf8').trim()
const ask = prompt => {
  const asked = spawnSync(process.env.SSH_ASKPASS, [prompt], { stdio: ['ignore', 'pipe', 'inherit'] })
  return asked.status === 0 ? asked.stdout.toString('utf8').replace(/\\n$/, '') : null
}
const fail = (text, code) => {
  process.stderr.write(text)
  process.exit(code)
}
const bridge = () => {
  const socket = net.connect(process.env.STUB_ENGINE)
  process.stdin.pipe(socket)
  socket.pipe(process.stdout)
  socket.on('close', () => fail('client_loop: send disconnect: Broken pipe\\n', 255))
  socket.on('error', () => fail('ssh: connect to host server-1 port 22: Connection refused\\n', 255))
}
if (mode === 'bridge') {
  bridge()
} else if (mode === 'changed') {
  fail([
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    'IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!',
    'Host key for server-1 has changed and you have requested strict checking.',
    'Host key verification failed.',
    '',
  ].join('\\n'), 255)
} else if (mode === 'unknown') {
  const answer = ask([
    "The authenticity of host 'server-1 (192.0.2.7)' can't be established.",
    'ED25519 key fingerprint is SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU.',
    'This key is not known by any other names.',
    'Are you sure you want to continue connecting (yes/no/[fingerprint])? ',
  ].join('\\n'))
  if (answer === 'yes') bridge()
  else fail('Host key verification failed.\\n', 255)
} else if (mode === 'passphrase') {
  const answer = ask("Enter passphrase for key '/home/u/.ssh/id_ed25519': ")
  if (answer === 'open sesame') bridge()
  else fail('u@server-1: Permission denied (publickey).\\n', 255)
} else if (mode === 'missing') {
  fail('sh: 1: fabrica: not found\\n', 127)
}
`

const toolbox = layerToolbox({
  stubs: { ssh: shStub('exec "$STUB_NODE" "$STUB_SCRIPT" "$@"') },
})

const epoch = Schema.decodeUnknownSync(StreamEpoch)('epoch-1')

const statusWith = (clients: number): EngineStatus =>
  Schema.decodeUnknownSync(EngineStatus)({
    id: 'e-1',
    release: '0.1.0',
    startedAt: 1_793_268_900_000,
    host: { platform: 'linux', arch: 'x64', hostname: 'server-1', cores: 4 },
    projects: 0,
    runs: 0,
    liveWorkers: 0,
    machineWorkers: 2,
    clients,
    stopping: false,
  })

type StatusItem = StreamItem<EngineStatus, EngineStatus>

/** A minimal engine: hello, and a status stream that resumes after a sequence number. */
const serveEngine = (path: string) =>
  Effect.gen(function* () {
    const log = yield* Ref.make<ReadonlyArray<EngineStatus>>([statusWith(1)])
    const resumes = yield* Ref.make<ReadonlyArray<Option.Option<Resume>>>([])
    const patches = yield* PubSub.unbounded<StatusItem>()
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
      'engine.watchStatus': ({ resume }) =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* Ref.update(resumes, all => [...all, resume])
            const subscription = yield* PubSub.subscribe(patches)
            const statuses = yield* Ref.get(log)
            const last = statuses.length - 1
            const plan = planResume({ resume, epoch, oldest: 1, latest: last })
            const first = ResumePlan.$match(plan, {
              Snapshot: (): ReadonlyArray<StatusItem> => [
                {
                  _tag: 'snapshot',
                  epoch,
                  seq: last,
                  value: statuses[last] ?? statusWith(0),
                },
              ],
              PatchesAfter: ({ after }): ReadonlyArray<StatusItem> =>
                statuses.slice(after + 1).map((value, index) => ({
                  _tag: 'patch',
                  seq: after + 1 + index,
                  value,
                })),
            })
            return Stream.concat(
              Stream.fromIterable(first),
              Stream.fromSubscription(subscription),
            )
          }),
        ),
      'engine.watchLoad': () => Stream.die('not served'),
    })
    const listening = yield* NodeSocketServer.make({ path })
    // Each connection races the current cut; `drop` cuts every open one.
    const cut = yield* Ref.make(yield* Deferred.make<void>())
    const server = SocketServer.SocketServer.of({
      address: listening.address,
      run: handler =>
        listening.run(socket =>
          Effect.flatMap(Ref.get(cut), dropped =>
            Effect.raceFirst(handler(socket), Deferred.await(dropped)),
          ),
        ),
    })
    yield* Layer.build(
      RpcServer.layer(EngineRpcs).pipe(
        Layer.provide(handlers),
        Layer.provide(RpcServer.layerProtocolSocketServer),
        Layer.provide(RpcSerialization.layerNdjson),
        Layer.provide(Layer.succeed(SocketServer.SocketServer, server)),
      ),
    )
    return {
      resumes,
      publish: (clients: number) =>
        Effect.gen(function* () {
          const seq = (yield* Ref.get(log)).length
          yield* Ref.update(log, statuses => [...statuses, statusWith(clients)])
          yield* PubSub.publish(patches, {
            _tag: 'patch',
            seq,
            value: statusWith(clients),
          })
        }),
      drop: Effect.flatMap(Deferred.make<void>(), next =>
        Effect.flatMap(Ref.getAndSet(cut, next), dropped =>
          Deferred.succeed(dropped, undefined),
        ),
      ),
    }
  })

interface Run {
  readonly args: ReadonlyArray<string>
  readonly askpass: string | null
  readonly require: string | null
}

/** A test's stub folder, its engine, and ssh's environment. */
const setUp = (mode: string) =>
  Effect.gen(function* () {
    const tools = yield* Toolbox
    const dir = yield* tempFolder('ssh')
    const script = NodePath.join(dir, 'stub.mjs')
    const socket = NodePath.join(dir, 'engine.sock')
    yield* Effect.promise(() =>
      Promise.all([
        writeFile(script, stubScript),
        writeFile(NodePath.join(dir, 'mode'), mode),
        writeFile(NodePath.join(dir, 'runs.log'), ''),
        writeFile(
          NodePath.join(dir, 'version'),
          'OpenSSH_9.6p1 Ubuntu-3ubuntu13.5, OpenSSL 3.0.13 30 Jan 2024\n',
        ),
      ]),
    )
    const engine = yield* serveEngine(socket)
    return {
      dir,
      engine,
      env: tools.env({
        STUB_DIR: dir,
        STUB_NODE: process.execPath,
        STUB_SCRIPT: script,
        STUB_ENGINE: socket,
      }),
      setMode: (next: string) =>
        Effect.promise(() => writeFile(NodePath.join(dir, 'mode'), next)),
      setVersion: (text: string) =>
        Effect.promise(() => writeFile(NodePath.join(dir, 'version'), text)),
      runs: Effect.promise(async (): Promise<ReadonlyArray<Run>> => {
        const text = await readFile(NodePath.join(dir, 'runs.log'), 'utf8')
        return text
          .split('\n')
          .filter(line => line !== '')
          .map(line => Schema.decodeUnknownSync(RunSchema)(JSON.parse(line)))
      }),
    }
  })

const RunSchema = Schema.Struct({
  args: Schema.Array(Schema.String),
  askpass: Schema.NullOr(Schema.String),
  require: Schema.NullOr(Schema.String),
})

const destination = Schema.decodeUnknownSync(SshDestination)('u@server-1')

/** Prompts that answer as a test says, and record what they were asked. */
const makePrompts = (answers: {
  readonly hostKey?: boolean
  readonly secret?: Option.Option<string>
}) =>
  Effect.gen(function* () {
    const hostKeys = yield* Ref.make<ReadonlyArray<HostKeyPrompt>>([])
    const secrets = yield* Ref.make<ReadonlyArray<TextPrompt>>([])
    const prompts: SshPrompts = {
      hostKey: prompt =>
        Effect.as(
          Ref.update(hostKeys, all => [...all, prompt]),
          answers.hostKey ?? false,
        ),
      secret: prompt =>
        Effect.as(
          Ref.update(secrets, all => [...all, prompt]),
          Option.map(answers.secret ?? Option.none(), Redacted.make),
        ),
      confirm: () => Effect.succeed(false),
      notice: () => Effect.void,
    }
    return { prompts, hostKeys, secrets }
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

/** The SSH failure a client's start failed with. */
const failureOf = (
  exit: Exit.Exit<EngineClientShape, unknown>,
): Option.Option<SshFailure['_tag']> =>
  Exit.match(exit, {
    onSuccess: () => Option.none(),
    onFailure: cause =>
      Option.flatMap(
        Option.filter(
          Option.fromNullishOr(
            cause.reasons.find(reason => reason._tag === 'Fail')?.error,
          ),
          (error): error is RpcClientError.RpcClientError =>
            error instanceof RpcClientError.RpcClientError,
        ),
        error => Option.map(sshFailed(error), failed => failed.failure._tag),
      ),
  })

describe('the SSH bridge', () => {
  layer(toolbox, { excludeTestServices: true })(it => {
    it.effect(
      'runs ssh with keepalives and nothing forwarded, and reaches the engine',
      () =>
        Effect.gen(function* () {
          const { env, runs } = yield* setUp('bridge')
          const client = yield* clientOver(env, SshPrompting.Terminal())
          const link = yield* client.link
          expect(Link.$is('Up')(link)).toBe(true)
          const [run] = yield* runs
          expect(run?.args).toEqual([
            '-T',
            '-o',
            'ClearAllForwardings=yes',
            '-o',
            'ForwardAgent=no',
            '-o',
            'ForwardX11=no',
            '-o',
            'ControlMaster=no',
            '-o',
            'ServerAliveInterval=15',
            '-o',
            'ServerAliveCountMax=3',
            '--',
            'u@server-1',
            'fabrica',
            'bridge',
          ])
          expect(run?.askpass).toBeNull()
        }),
    )

    it.effect('asks nothing in batch mode', () =>
      Effect.gen(function* () {
        const { env, runs } = yield* setUp('bridge')
        yield* clientOver(env, SshPrompting.None())
        const [run] = yield* runs
        expect(run?.args.slice(-6)).toEqual([
          '-o',
          'BatchMode=yes',
          '--',
          'u@server-1',
          'fabrica',
          'bridge',
        ])
      }),
    )

    it.effect(
      'runs ssh again after a lost link and resumes its streams after their last sequence number',
      () =>
        Effect.gen(function* () {
          const { env, engine, runs } = yield* setUp('bridge')
          const client = yield* clientOver(env, SshPrompting.Terminal())
          const items = yield* Queue.unbounded<StatusItem>()
          yield* client
            .watch(resume => client.rpc['engine.watchStatus']({ resume }))
            .pipe(
              Stream.runForEach(item => Queue.offer(items, item)),
              Effect.forkScoped,
            )
          const take = Effect.map(Queue.take(items), item =>
            item._tag === 'snapshot'
              ? `snapshot ${item.seq}: ${item.value.clients}`
              : `patch ${item.seq}: ${item.value.clients}`,
          )
          expect(yield* take).toBe('snapshot 0: 1')
          yield* engine.publish(2)
          expect(yield* take).toBe('patch 1: 2')

          const before = yield* client.link
          yield* engine.drop
          yield* engine.publish(3)
          expect(yield* take).toBe('patch 2: 3')
          yield* client.links.pipe(
            Stream.filter(
              next =>
                Link.$is('Up')(next) && next.connection > before.connection,
            ),
            Stream.runHead,
          )
          expect((yield* runs).length).toBe(2)
          const resumed = (yield* Ref.get(engine.resumes)).map(resume =>
            Option.match(resume, {
              onNone: () => 'none',
              onSome: ({ after }) => `after ${after}`,
            }),
          )
          expect(resumed).toEqual(['none', 'after 1'])
        }),
    )

    it.effect('refuses a changed host key, as ssh does', () =>
      Effect.gen(function* () {
        const { env, runs } = yield* setUp('changed')
        const exit = yield* Effect.exit(
          clientOver(env, SshPrompting.Terminal()),
        )
        expect(failureOf(exit)).toEqual(Option.some('HostKeyChanged'))
        expect((yield* runs).length).toBe(1)
      }),
    )

    it.effect(
      "relays an unknown host's fingerprint and connects once it is accepted",
      () =>
        Effect.gen(function* () {
          const { env, dir, runs } = yield* setUp('unknown')
          const { prompts, hostKeys } = yield* makePrompts({ hostKey: true })
          const client = yield* clientOver(
            env,
            SshPrompting.Relay({
              node: process.execPath,
              folder: dir,
              prompts,
            }),
          )
          expect(Link.$is('Up')(yield* client.link)).toBe(true)
          const [asked] = yield* Ref.get(hostKeys)
          expect(asked?.host).toBe('server-1 (192.0.2.7)')
          expect(asked?.fingerprint).toEqual(
            Option.some('SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU'),
          )
          expect(asked?.destination).toBe('u@server-1')
          const [run] = yield* runs
          expect(run?.require).toBe('force')
          expect(run?.askpass).not.toBeNull()
        }),
    )

    it.effect("refuses an unknown host's key that isn't accepted", () =>
      Effect.gen(function* () {
        const { env, dir } = yield* setUp('unknown')
        const { prompts } = yield* makePrompts({ hostKey: false })
        const exit = yield* Effect.exit(
          clientOver(
            env,
            SshPrompting.Relay({
              node: process.execPath,
              folder: dir,
              prompts,
            }),
          ),
        )
        expect(failureOf(exit)).toEqual(Option.some('HostKeyUnknown'))
      }),
    )

    it.effect("relays a key's passphrase through SSH_ASKPASS", () =>
      Effect.gen(function* () {
        const { env, dir } = yield* setUp('passphrase')
        const { prompts, secrets } = yield* makePrompts({
          secret: Option.some('open sesame'),
        })
        const client = yield* clientOver(
          env,
          SshPrompting.Relay({ node: process.execPath, folder: dir, prompts }),
        )
        expect(Link.$is('Up')(yield* client.link)).toBe(true)
        expect((yield* Ref.get(secrets)).map(prompt => prompt.text)).toEqual([
          "Enter passphrase for key '/home/u/.ssh/id_ed25519': ",
        ])
      }),
    )

    it.effect('fails to sign in where the passphrase is cancelled', () =>
      Effect.gen(function* () {
        const { env, dir } = yield* setUp('passphrase')
        const { prompts } = yield* makePrompts({ secret: Option.none() })
        const exit = yield* Effect.exit(
          clientOver(
            env,
            SshPrompting.Relay({
              node: process.execPath,
              folder: dir,
              prompts,
            }),
          ),
        )
        expect(failureOf(exit)).toEqual(Option.some('AuthenticationFailed'))
      }),
    )

    it.effect('refuses to relay prompts through an ssh older than 8.4', () =>
      Effect.gen(function* () {
        const { env, dir, runs, setVersion } = yield* setUp('bridge')
        yield* setVersion('OpenSSH_for_Windows_8.1p1, LibreSSL 3.0.2\n')
        const { prompts } = yield* makePrompts({})
        const exit = yield* Effect.exit(
          clientOver(
            env,
            SshPrompting.Relay({
              node: process.execPath,
              folder: dir,
              prompts,
            }),
          ),
        )
        expect(failureOf(exit)).toEqual(Option.some('TooOld'))
        expect(yield* runs).toEqual([])
      }),
    )

    it.effect('says so where the host has no fabrica', () =>
      Effect.gen(function* () {
        const { env } = yield* setUp('missing')
        const exit = yield* Effect.exit(
          clientOver(env, SshPrompting.Terminal()),
        )
        expect(failureOf(exit)).toEqual(Option.some('BridgeMissing'))
      }),
    )
  })
})

/** What ssh's end says, by its failure's tag. */
const endedWith = (stderr: string, code: number) =>
  Option.match(sshEnded({ code, signal: null, stderr }), {
    onNone: () => 'closed',
    onSome: failure => failure._tag,
  })

describe("ssh's end", () => {
  it('is read from its exit and its own words', () => {
    expect(endedWith('', 0)).toBe('closed')
    expect(
      endedWith(
        'Host key for server-1 has changed and you have requested strict checking.\nHost key verification failed.\n',
        255,
      ),
    ).toBe('HostKeyChanged')
    expect(
      endedWith(
        'No ED25519 host key is known for server-1 and you have requested strict checking.\nHost key verification failed.\n',
        255,
      ),
    ).toBe('HostKeyUnknown')
    expect(endedWith('u@server-1: Permission denied (publickey).\n', 255)).toBe(
      'AuthenticationFailed',
    )
    expect(endedWith('bash: line 1: fabrica: command not found\n', 127)).toBe(
      'BridgeMissing',
    )
    expect(endedWith('Timeout, server server-1 not responding.\n', 255)).toBe(
      'Lost',
    )
  })

  it.effect('stops the reconnects at a refusal, and only there', () =>
    Effect.gen(function* () {
      /** How many times a connection ssh ends with `stderr` is tried, three retries allowed. */
      const tries = (stderr: string) =>
        Effect.gen(function* () {
          const attempts = yield* Ref.make(0)
          const failure = Option.getOrThrow(
            sshEnded({ code: 255, signal: null, stderr }),
          )
          const attempt: Effect.Effect<void, Socket.SocketError> =
            Effect.andThen(
              Ref.update(attempts, count => count + 1),
              Effect.fail(
                new Socket.SocketError({
                  reason: new Socket.SocketReadError({
                    cause: new SshFailed({ destination, failure }),
                  }),
                }),
              ),
            )
          yield* Effect.ignore(
            Effect.retry(attempt, sshReconnect(Schedule.recurs(3))),
          )
          return yield* Ref.get(attempts)
        })
      expect(yield* tries('u@server-1: Permission denied (publickey).')).toBe(1)
      expect(yield* tries('Timeout, server server-1 not responding.')).toBe(4)
    }),
  )
})

describe('an ssh destination', () => {
  it('is never an option', () => {
    const valid = (text: string) =>
      Result.isSuccess(Schema.decodeUnknownResult(SshDestination)(text))
    expect(valid('u@server-1')).toBe(true)
    expect(valid('ssh://u@server-1:2222')).toBe(true)
    expect(valid('-oProxyCommand=touch /tmp/x')).toBe(false)
    expect(valid('ssh://-oProxyCommand=sh')).toBe(false)
    expect(valid('u@-oProxyCommand=sh')).toBe(false)
    expect(valid('server-1')).toBe(true)
    expect(valid('server 1')).toBe(false)
    expect(valid('')).toBe(false)
  })

  it("reads OpenSSH's version", () => {
    expect(parseSshVersion('OpenSSH_9.6p1 Ubuntu-3ubuntu13.5')).toEqual(
      Option.some({ major: 9, minor: 6 }),
    )
    expect(parseSshVersion('OpenSSH_for_Windows_8.1p1, LibreSSL')).toEqual(
      Option.some({ major: 8, minor: 1 }),
    )
    expect(parseSshVersion('dropbear v2022.83')).toEqual(Option.none())
  })
})
