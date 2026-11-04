import {
  Cause,
  Console,
  Effect,
  Exit,
  Layer,
  Option,
  Queue,
  Schema,
  SchemaGetter,
  Stdio,
  Stream,
  Terminal,
} from 'effect'
import { chmod, lstat, readFile, writeFile } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { describe, expect, layer } from '@effect/vitest'
import { presentedFingerprint } from '@fabrica/client/node'
import {
  EngineHost,
  parseListenAddress,
  protocolVersion,
} from '@fabrica/contracts'
import { Daemon } from '@fabrica/engine'
import {
  Toolbox,
  layerHost,
  layerToolbox,
  shStub,
  tempFolder,
} from '@fabrica/testkit'

import { LocalEngine, SshEnvironment } from '../src/cli/connect'
import { KnownEnginesFolder } from '../src/cli/known-engines'
import { runCli } from '../src/cli/main'
import { version } from '../src/version'

// `fabrica engine add|list|remove` and `--engine <name>` (spec §19, §9.1, §9.3): the CLI keeps its own known
// engines in a file in the user's config folder, and reaches each by its name as the app reaches it. The
// stub ssh and wsl.exe record their arguments and bridge their stdio to an engine started in a temporary
// data folder, as the commands they stand for would; an engine over TLS is a real listener.

const bridgeScript = `
const net = process.getBuiltinModule('node:net')
const socket = net.connect(process.argv[1])
process.stdin.pipe(socket)
socket.pipe(process.stdout)
socket.on('close', () => process.exit(0))
socket.on('error', () => process.exit(255))
`

const bridgeStub = shStub(
  [
    'printf "%s\\n" "$@" > "$STUB_DIR/args"',
    'if [ "$STUB_MODE" = no-distro ]; then',
    '  echo "There is no distribution with the supplied name." >&2',
    '  echo "Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND" >&2',
    '  exit 1',
    'fi',
    'exec "$STUB_NODE" -e "$STUB_BRIDGE" "$STUB_ENGINE"',
  ].join('\n'),
)

const toolbox = layerToolbox({
  stubs: { ssh: bridgeStub, 'wsl.exe': bridgeStub },
})

const host = new EngineHost({
  platform: 'linux',
  arch: 'x64',
  hostname: 'server-1',
  cores: 4,
})
const release = '1.2.3'

const decodeCreated = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ token: Schema.String })).pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transform(({ token }) => token),
      encode: SchemaGetter.forbidden(() => 'only decoded'),
    }),
  ),
)

/** A key pressed at a prompt. */
const pressed = (name: string, input?: string): Terminal.UserInput => ({
  input: Option.fromUndefinedOr(input),
  key: { name, ctrl: false, meta: false, shift: false },
})

const typed = (text: string): ReadonlyArray<Terminal.UserInput> => [
  ...Array.from(text, letter => pressed(letter, letter)),
  pressed('return'),
]

/** A terminal the user types `keys` on, whichever prompts read them. */
const terminalTyping = (keys: ReadonlyArray<Terminal.UserInput>) =>
  Effect.gen(function* () {
    const input = yield* Queue.unbounded<Terminal.UserInput, Cause.Done>()
    yield* Queue.offerAll(input, keys)
    return Terminal.make({
      columns: Effect.succeed(200),
      rows: Effect.succeed(50),
      readInput: Effect.succeed(input),
      readLine: Effect.succeed(''),
      display: () => Effect.void,
    })
  })

/** How `fabrica` is run: stdin giving `input`, unless a terminal types `keys`. */
type Typing =
  | { readonly input: string }
  | { readonly keys: ReadonlyArray<Terminal.UserInput> }

/** An engine in a temporary folder, listening over TLS, and `fabrica <args>` run with the stubs there. */
const setUp = (mode = 'bridge') =>
  Effect.gen(function* () {
    const tools = yield* Toolbox
    const root = yield* tempFolder('known')
    const paths = Daemon.pathsIn({
      data: NodePath.join(root, 'd'),
      socketFolder: NodePath.join(root, 'd'),
    })
    const started = yield* Daemon.startEngine({
      paths,
      host,
      release,
      listen: {
        listen: parseListenAddress('127.0.0.1:0'),
        listen_certificate: Option.none(),
        listen_key: Option.none(),
      },
    })
    if (Option.isNone(started.listening))
      return yield* Effect.die('the engine doesn’t listen over TLS')
    const { port } = started.listening.value.address
    const folder = NodePath.join(root, 'config', 'fabrica')
    const env = tools.env({
      STUB_DIR: root,
      STUB_MODE: mode,
      STUB_NODE: process.execPath,
      STUB_BRIDGE: bridgeScript,
      STUB_ENGINE: paths.socket,
      ...(mode === 'no-wsl' ? { PATH: NodePath.join(root, 'no-tools') } : {}),
    })
    const run = (typing: Typing, args: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const out: Array<string> = []
        const err: Array<string> = []
        const console: Console.Console = Object.assign(
          Object.create(globalThis.console),
          {
            log: (...parts: ReadonlyArray<unknown>) =>
              out.push(parts.join(' ')),
            error: (...parts: ReadonlyArray<unknown>) =>
              err.push(parts.join(' ')),
          },
        )
        const onTerminal = 'keys' in typing
        const terminal = yield* terminalTyping(onTerminal ? typing.keys : [])
        const exit = yield* runCli(args).pipe(
          Effect.provideService(Console.Console, console),
          Effect.provideService(SshEnvironment, { env }),
          Effect.provideService(KnownEnginesFolder, {
            folder: Effect.succeed(folder),
          }),
          Effect.provide([
            NodeServices.layer,
            Layer.succeed(Terminal.Terminal)(terminal),
            Stdio.layerTest({
              stdinIsTerminal: Effect.succeed(onTerminal),
              stdin: Stream.make(onTerminal ? '' : typing.input).pipe(
                Stream.map(text => new TextEncoder().encode(text)),
              ),
            }),
            Layer.succeed(LocalEngine)({
              socket: Effect.succeed(paths.socket),
            }),
            layerHost(),
          ]),
          Effect.exit,
        )
        return { exit, out, err }
      })
    const fabrica = (...args: ReadonlyArray<string>) => run({ input: '' }, args)
    const fabricaGiven = (input: string, ...args: ReadonlyArray<string>) =>
      run({ input }, args)
    const fabricaTyping = (
      keys: ReadonlyArray<Terminal.UserInput>,
      ...args: ReadonlyArray<string>
    ) => run({ keys }, args)
    const args = Effect.promise(async () =>
      (await readFile(NodePath.join(root, 'args'), 'utf8')).split('\n'),
    )
    /** A pairing token the engine made. */
    const makeToken = Effect.gen(function* () {
      const made = yield* fabrica('token', 'create', 'cli', '--json')
      return yield* decodeCreated(made.out.join(''))
    })
    const address = `127.0.0.1:${port}`
    const fingerprint = yield* presentedFingerprint({
      host: '127.0.0.1',
      port,
    })
    return {
      fabrica,
      fabricaGiven,
      fabricaTyping,
      args,
      makeToken,
      address,
      port,
      fingerprint,
      file: NodePath.join(folder, 'engines.json'),
    }
  })

const versionAnswer = {
  cli: { release: version, protocol: protocolVersion },
  engine: {
    release,
    protocol: protocolVersion,
    supported: [protocolVersion],
  },
}

describe('fabrica engine add|list|remove and --engine <name>', () => {
  layer(toolbox, { excludeTestServices: true })(it => {
    it.effect(
      'reaches an engine by its name through ssh, until it is removed',
      () =>
        Effect.gen(function* () {
          const { fabrica, args } = yield* setUp()
          const none = yield* fabrica('engine', 'list')
          expect(none.out).toStrictEqual([
            'no known engines: add one with `fabrica engine add <name>`',
          ])

          const added = yield* fabrica(
            'engine',
            'add',
            'box',
            '--ssh',
            'u@server-1',
          )
          expect(added.exit).toStrictEqual(Exit.void)
          expect(added.out).toStrictEqual([
            'added box: ssh u@server-1; reach it with `--engine box`',
          ])

          const reached = yield* fabrica(
            '--engine',
            'box',
            'engine',
            'version',
            '--json',
          )
          expect(reached.exit).toStrictEqual(Exit.void)
          expect(JSON.parse(reached.out.join(''))).toStrictEqual(versionAnswer)
          expect(yield* args).toContain('u@server-1')

          const removed = yield* fabrica('engine', 'remove', 'box', '--json')
          expect(JSON.parse(removed.out.join(''))).toStrictEqual({
            removed: 'box',
          })
          const gone = yield* fabrica('--engine', 'box', 'engine', 'version')
          expect(Exit.isFailure(gone.exit)).toBe(true)
          expect(gone.err).toStrictEqual([
            'fabrica: no engine named box is known: name the local engine (local), one `fabrica engine add` keeps, or one on another host by its SSH destination (ssh://[user@]host[:port])',
          ])
        }).pipe(Effect.scoped),
    )

    it.effect('reaches an engine by its name through wsl.exe', () =>
      Effect.gen(function* () {
        const { fabrica, args } = yield* setUp()
        yield* fabrica('engine', 'add', 'wsl', '--wsl', 'Ubuntu')
        const listed = yield* fabrica('engine', 'list', '--json')
        expect(JSON.parse(listed.out.join(''))).toStrictEqual([
          { name: 'wsl', address: { _tag: 'Wsl', distro: 'Ubuntu' } },
        ])
        const reached = yield* fabrica(
          '-e',
          'wsl',
          'engine',
          'version',
          '--json',
        )
        expect(reached.exit).toStrictEqual(Exit.void)
        expect(JSON.parse(reached.out.join(''))).toStrictEqual(versionAnswer)
        expect((yield* args).slice(0, 3)).toStrictEqual([
          '-d',
          'Ubuntu',
          '--exec',
        ])
      }).pipe(Effect.scoped),
    )

    it.effect('says why wsl.exe refused, and tries no more', () =>
      Effect.gen(function* () {
        const { fabrica } = yield* setUp('no-distro')
        yield* fabrica('engine', 'add', 'wsl', '--wsl', 'Gone')
        const { exit, err } = yield* fabrica(
          '--engine',
          'wsl',
          'engine',
          'status',
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(err).toStrictEqual([
          'fabrica: WSL has no distribution named Gone: install it, or choose another',
        ])
      }).pipe(Effect.scoped),
    )

    it.effect('says no engine answered where there is no wsl.exe', () =>
      Effect.gen(function* () {
        const { fabrica } = yield* setUp('no-wsl')
        yield* fabrica('engine', 'add', 'wsl', '--wsl', 'Ubuntu')
        const { exit, err } = yield* fabrica(
          '--engine',
          'wsl',
          'engine',
          'status',
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(err).toStrictEqual([
          'fabrica: no engine answered through wsl.exe in the WSL distribution Ubuntu',
        ])
      }).pipe(Effect.scoped),
    )

    it.effect(
      'pairs over TLS with the fingerprint given, keeping the token to itself in a file only its user reads',
      () =>
        Effect.gen(function* () {
          const engine = yield* setUp()
          const token = yield* engine.makeToken
          const added = yield* engine.fabricaGiven(
            `${token}\n`,
            'engine',
            'add',
            'tls',
            '--tls',
            engine.address,
            '--fingerprint',
            engine.fingerprint,
          )
          expect(added.exit).toStrictEqual(Exit.void)
          expect(added.out.join('\n')).not.toContain(token)

          const text = yield* engine.fabrica('engine', 'list')
          expect(text.out).toStrictEqual([
            `tls  tls ${engine.address}, certificate SHA-256 ${engine.fingerprint}`,
          ])
          const json = yield* engine.fabrica('engine', 'list', '--json')
          expect(JSON.parse(json.out.join(''))).toStrictEqual([
            {
              name: 'tls',
              address: {
                _tag: 'Tls',
                host: '127.0.0.1',
                port: engine.port,
                fingerprint: engine.fingerprint,
              },
            },
          ])

          const kept = yield* Effect.promise(() => lstat(engine.file))
          expect(kept.mode & 0o777).toBe(0o600)
          const held = yield* Effect.promise(() =>
            readFile(engine.file, 'utf8'),
          )
          expect(held).toContain(token)

          const reached = yield* engine.fabrica(
            '--engine',
            'tls',
            'engine',
            'version',
            '--json',
          )
          expect(reached.exit).toStrictEqual(Exit.void)
          expect(JSON.parse(reached.out.join(''))).toStrictEqual(versionAnswer)
        }).pipe(Effect.scoped),
    )

    it.effect(
      'says the engine presents another certificate than the pinned one',
      () =>
        Effect.gen(function* () {
          const engine = yield* setUp()
          const token = yield* engine.makeToken
          const other = engine.fingerprint.startsWith('00')
            ? engine.fingerprint.replace(/^00/u, '11')
            : engine.fingerprint.replace(/^../u, '00')
          yield* engine.fabricaGiven(
            token,
            'engine',
            'add',
            'tls',
            '--tls',
            engine.address,
            '--fingerprint',
            other,
          )
          const { exit, err } = yield* engine.fabrica(
            '--engine',
            'tls',
            'engine',
            'status',
          )
          expect(Exit.isFailure(exit)).toBe(true)
          expect(err).toStrictEqual([
            `fabrica: the engine's certificate changed since it was paired: it presented ${engine.fingerprint}, not the ${other} it was paired with; pair it again only once you know the new certificate is the engine's`,
          ])
        }).pipe(Effect.scoped),
    )

    it.effect('says the engine refused the token', () =>
      Effect.gen(function* () {
        const engine = yield* setUp()
        yield* engine.fabricaGiven(
          'not-the-token',
          'engine',
          'add',
          'tls',
          '--tls',
          engine.address,
          '--fingerprint',
          engine.fingerprint,
        )
        const { exit, err } = yield* engine.fabrica(
          '--engine',
          'tls',
          'engine',
          'status',
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(err.join('\n')).toMatch(
          /^fabrica: the engine refused the pairing token \(HTTP 40\d\)/u,
        )
      }).pipe(Effect.scoped),
    )

    it.effect('says no engine answers over TLS', () =>
      Effect.gen(function* () {
        const engine = yield* setUp()
        yield* engine.fabricaGiven(
          'a-token',
          'engine',
          'add',
          'tls',
          '--tls',
          '127.0.0.1:1',
          '--fingerprint',
          engine.fingerprint,
        )
        const { exit, err } = yield* engine.fabrica(
          '--engine',
          'tls',
          'engine',
          'status',
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(err).toStrictEqual([
          'fabrica: no engine answered over TLS at 127.0.0.1:1',
        ])
      }).pipe(Effect.scoped),
    )

    it.effect(
      'has a script give the fingerprint: off a terminal nobody can accept it',
      () =>
        Effect.gen(function* () {
          const engine = yield* setUp()
          const { exit, err } = yield* engine.fabricaGiven(
            'a-token',
            'engine',
            'add',
            'tls',
            '--tls',
            engine.address,
          )
          expect(Exit.isFailure(exit)).toBe(true)
          expect(err).toStrictEqual([
            `fabrica: the engine at ${engine.address} presents the certificate SHA-256 ${engine.fingerprint}: compare it with what \`fabrica engine status\` prints on its host, and give it with --fingerprint`,
          ])
          const after = yield* engine.fabrica('engine', 'list', '--json')
          expect(JSON.parse(after.out.join(''))).toStrictEqual([])
        }).pipe(Effect.scoped),
    )

    it.effect(
      'pins the fingerprint the user accepts on the terminal, then takes the token typed unseen',
      () =>
        Effect.gen(function* () {
          const engine = yield* setUp()
          const token = yield* engine.makeToken
          const added = yield* engine.fabricaTyping(
            [pressed('y', 'y'), ...typed(token)],
            'engine',
            'add',
            'tls',
            '--tls',
            engine.address,
          )
          expect(added.exit).toStrictEqual(Exit.void)
          const reached = yield* engine.fabrica(
            '--engine',
            'tls',
            'engine',
            'version',
            '--json',
          )
          expect(JSON.parse(reached.out.join(''))).toStrictEqual(versionAnswer)
        }).pipe(Effect.scoped),
    )

    it.effect('keeps nothing where the user turns the fingerprint down', () =>
      Effect.gen(function* () {
        const engine = yield* setUp()
        const { exit, err } = yield* engine.fabricaTyping(
          [pressed('n', 'n')],
          'engine',
          'add',
          'tls',
          '--tls',
          engine.address,
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(err).toStrictEqual([
          `fabrica: the certificate of the engine at ${engine.address} wasn't accepted: nothing was kept`,
        ])
        const after = yield* engine.fabrica('engine', 'list', '--json')
        expect(JSON.parse(after.out.join(''))).toStrictEqual([])
      }).pipe(Effect.scoped),
    )

    it.effect('says it can’t read a TLS engine’s certificate', () =>
      Effect.gen(function* () {
        const engine = yield* setUp()
        const { exit, err } = yield* engine.fabricaGiven(
          'a-token',
          'engine',
          'add',
          'tls',
          '--tls',
          '127.0.0.1:1',
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(err.join('\n')).toMatch(
          /^fabrica: couldn't reach an engine over TLS at 127\.0\.0\.1:1/u,
        )
      }).pipe(Effect.scoped),
    )

    it.effect.each([
      {
        words: 'without a way to reach it',
        args: ['engine', 'add', 'box'],
        says: 'fabrica: say how the engine is reached: one of --ssh, --wsl or --tls',
      },
      {
        words: 'with two ways to reach it',
        args: ['engine', 'add', 'box', '--ssh', 'host', '--wsl', 'Ubuntu'],
        says: 'fabrica: say how the engine is reached: one of --ssh, --wsl or --tls',
      },
      {
        words: 'with a fingerprint it doesn’t go with',
        args: [
          'engine',
          'add',
          'box',
          '--ssh',
          'host',
          '--fingerprint',
          Array(32).fill('AB').join(':'),
        ],
        says: 'fabrica: --fingerprint goes with --tls',
      },
      {
        words: 'with a TLS address that is none',
        args: ['engine', 'add', 'box', '--tls', 'no-port'],
        says: 'fabrica: no-port is no TLS address: give host:port, or [v6]:port',
      },
      {
        words: 'with no token',
        args: [
          'engine',
          'add',
          'box',
          '--tls',
          '127.0.0.1:1',
          '--fingerprint',
          Array(32).fill('AB').join(':'),
        ],
        says: 'fabrica: no pairing token was given: make one with `fabrica token create <name>` on the host',
      },
    ])('refuses to add an engine $words', ({ args, says }) =>
      Effect.gen(function* () {
        const { fabrica } = yield* setUp()
        const { exit, err } = yield* fabrica(...args)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(err).toStrictEqual([says])
        const after = yield* fabrica('engine', 'list', '--json')
        expect(JSON.parse(after.out.join(''))).toStrictEqual([])
      }).pipe(Effect.scoped),
    )

    it.effect.each(['local', 'ssh://host', 'two words', '-e'])(
      'refuses the name %s, which --engine would read otherwise',
      name =>
        Effect.gen(function* () {
          const { fabrica } = yield* setUp()
          const { exit } = yield* fabrica(
            'engine',
            'add',
            name,
            '--ssh',
            'host',
          )
          expect(Exit.isFailure(exit)).toBe(true)
          const after = yield* fabrica('engine', 'list', '--json')
          expect(JSON.parse(after.out.join(''))).toStrictEqual([])
        }).pipe(Effect.scoped),
    )

    it.effect('refuses a name already known, keeping the engine it names', () =>
      Effect.gen(function* () {
        const { fabrica } = yield* setUp()
        yield* fabrica('engine', 'add', 'box', '--ssh', 'first')
        const again = yield* fabrica('engine', 'add', 'box', '--wsl', 'Ubuntu')
        expect(Exit.isFailure(again.exit)).toBe(true)
        expect(again.err).toStrictEqual([
          'fabrica: an engine named box is known already: remove it first, with `fabrica engine remove box`',
        ])
        const after = yield* fabrica('engine', 'list')
        expect(after.out).toStrictEqual(['box  ssh first'])
      }).pipe(Effect.scoped),
    )

    it.effect('says a name it can’t remove isn’t known', () =>
      Effect.gen(function* () {
        const { fabrica } = yield* setUp()
        const { exit, err } = yield* fabrica('engine', 'remove', 'nope')
        expect(Exit.isFailure(exit)).toBe(true)
        expect(err).toStrictEqual([
          'fabrica: no engine named nope is known: `fabrica engine list` says which are',
        ])
      }).pipe(Effect.scoped),
    )

    it.effect('says the file can’t be read, and never overwrites it', () =>
      Effect.gen(function* () {
        const { fabrica, file } = yield* setUp()
        yield* fabrica('engine', 'add', 'box', '--ssh', 'host')
        yield* Effect.promise(() => writeFile(file, 'not json'))
        const reached = yield* fabrica('--engine', 'box', 'engine', 'status')
        expect(Exit.isFailure(reached.exit)).toBe(true)
        expect(reached.err).toStrictEqual([
          `fabrica: couldn't read engines.json in ${NodePath.dirname(file)}: it isn't a list of known engines this fabrica reads`,
        ])
        const added = yield* fabrica('engine', 'add', 'other', '--ssh', 'host')
        expect(Exit.isFailure(added.exit)).toBe(true)
        expect(yield* Effect.promise(() => readFile(file, 'utf8'))).toBe(
          'not json',
        )
      }).pipe(Effect.scoped),
    )

    it.effect('says it can’t write the file', () =>
      Effect.gen(function* () {
        const { fabrica, file } = yield* setUp()
        yield* fabrica('engine', 'add', 'box', '--ssh', 'host')
        const folder = NodePath.dirname(file)
        yield* Effect.acquireUseRelease(
          Effect.promise(() => chmod(folder, 0o500)),
          () =>
            Effect.gen(function* () {
              const { exit, err } = yield* fabrica(
                'engine',
                'add',
                'other',
                '--ssh',
                'host',
              )
              expect(Exit.isFailure(exit)).toBe(true)
              expect(err.join('\n')).toContain(
                `fabrica: couldn't write engines.json in ${folder}:`,
              )
            }),
          () => Effect.promise(() => chmod(folder, 0o700)),
        )
      }).pipe(Effect.scoped),
    )
  })
})
