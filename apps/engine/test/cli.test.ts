import { Console, Effect, Exit, Layer, Schema } from 'effect'
import * as NodePath from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import { EngineHost, EngineStatus, protocolVersion } from '@fabrica/contracts'
import { Daemon } from '@fabrica/engine'
import { layerHost, tempFolder } from '@fabrica/testkit'

import { LocalEngine } from '../src/cli/connect'
import { runCli } from '../src/cli/main'
import { sanitise, sanitiseLine } from '../src/cli/sanitise'
import { version, versionLine } from '../src/version'

// The CLI's frame (spec §19): the sanitiser's table of control classes, then the `fabrica` command run as
// its entry runs it, against an engine started in a temporary data folder, its output caught from the
// console the CLI prints through.

describe('the sanitiser', () => {
  const table: ReadonlyArray<
    readonly [kind: string, given: string, shown: string]
  > = [
    ['plain text', 'Fix the parser (tutti-4zs)', 'Fix the parser (tutti-4zs)'],
    ['letters and emoji', 'Café naïve 日本 🚀', 'Café naïve 日本 🚀'],
    ['a backslash', 'C:\\path', 'C:\\path'],
    ['NUL', 'a\u0000b', 'a\\u0000b'],
    ['BEL', 'a\u0007b', 'a\\u0007b'],
    ['backspace', 'abc\u0008\u0008x', 'abc\\u0008\\u0008x'],
    ['carriage return', 'done\rfailed', 'done\\u000dfailed'],
    ['vertical tab and form feed', 'a\u000b\u000cb', 'a\\u000b\\u000cb'],
    [
      'a CSI colour sequence',
      '\u001b[31mred\u001b[0m',
      '\\u001b[31mred\\u001b[0m',
    ],
    ['an OSC title sequence', '\u001b]0;owned\u0007', '\\u001b]0;owned\\u0007'],
    [
      'an OSC 8 link',
      '\u001b]8;;https://x.test\u001b\\x',
      '\\u001b]8;;https://x.test\\u001b\\x',
    ],
    ['DEL', 'a\u007fb', 'a\\u007fb'],
    ['C1 NEL', 'a\u0085b', 'a\\u0085b'],
    ['C1 CSI', '\u009b31m', '\\u009b31m'],
    ['C1 OSC and ST', '\u009d0;t\u009c', '\\u009d0;t\\u009c'],
    ['bidi embeddings', 'a\u202ab\u202bc\u202cd', 'a\\u202ab\\u202bc\\u202cd'],
    ['bidi overrides', 'exe.\u202etxt\u202d', 'exe.\\u202etxt\\u202d'],
    [
      'bidi isolates',
      '\u2066a\u2067b\u2068c\u2069',
      '\\u2066a\\u2067b\\u2068c\\u2069',
    ],
    ['line separator', 'a\u2028b', 'a\\u2028b'],
    ['paragraph separator', 'a\u2029b', 'a\\u2029b'],
  ]

  it.each(table)('shows %s as escapes', (_kind, given, shown) => {
    expect(sanitise(given)).toBe(shown)
    expect(sanitiseLine(given)).toBe(shown)
  })

  it('keeps tabs and newlines in text, and escapes them in a value on one line', () => {
    expect(sanitise('a\tb\nc')).toBe('a\tb\nc')
    expect(sanitiseLine('a\tb\nc')).toBe('a\\u0009b\\u000ac')
  })

  it('leaves JSON as JSON, which parses to what was sent', () => {
    const value = {
      title:
        'a\u001b[2Jb\u0085c\u202ed\u2066e\u2028f\u2029g\u007fh\u009bi\tj\nk',
    }
    const shown = sanitise(JSON.stringify(value))
    expect(shown).toMatch(/^[\u0020-\u007e]*$/u)
    expect(JSON.parse(shown)).toStrictEqual(value)
  })
})

/** A hostname as an agent might set one: a title sequence, a bidi override and a line separator. */
const hostname = 'build\u001b]0;owned\u0007-\u202ehost\u2028'

const host = new EngineHost({
  platform: 'linux',
  arch: 'x64',
  hostname,
  cores: 8,
})
const release = '1.2.3'

interface Printed {
  readonly out: Array<string>
  readonly err: Array<string>
}

/** A console that keeps what is printed: `log` to `out`, `error` to `err`. */
const capture = (): Printed & { readonly console: Console.Console } => {
  const out: Array<string> = []
  const err: Array<string> = []
  const console: Console.Console = Object.assign(
    Object.create(globalThis.console),
    {
      log: (...args: ReadonlyArray<unknown>) => out.push(args.join(' ')),
      error: (...args: ReadonlyArray<unknown>) => err.push(args.join(' ')),
    },
  )
  return { out, err, console }
}

/** `fabrica <args>` with the local engine at `socket`: its exit and what it printed. */
const fabrica = (socket: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const printed = capture()
    const exit = yield* runCli(args).pipe(
      Effect.provideService(Console.Console, printed.console),
      Effect.provide([
        NodeServices.layer,
        Layer.succeed(LocalEngine)({ socket: Effect.succeed(socket) }),
        layerHost(),
      ]),
      Effect.exit,
    )
    return { exit, out: printed.out, err: printed.err }
  })

/** A new temporary folder's engine files; short, as a socket's path must be. */
const scratchPaths = Effect.map(tempFolder('cli'), root =>
  Daemon.pathsIn({
    data: NodePath.join(root, 'd'),
    socketFolder: NodePath.join(root, 'd'),
  }),
)

/** An engine started in a temporary data folder, for the test's scope. */
const testEngine = Effect.gen(function* () {
  const paths = yield* scratchPaths
  const engine = yield* Daemon.startEngine({ paths, host, release })
  return { socket: paths.socket, engine }
})

/** The one line of JSON a command printed. */
const onlyJson = (out: ReadonlyArray<string>): unknown => {
  expect(out).toHaveLength(1)
  return JSON.parse(out[0] ?? '')
}

describe('fabrica engine', () => {
  it.live('says the engine’s version and its own as JSON', () =>
    Effect.gen(function* () {
      const { socket } = yield* testEngine
      const { exit, out } = yield* fabrica(
        socket,
        'engine',
        'version',
        '--json',
      )
      expect(exit).toStrictEqual(Exit.void)
      expect(onlyJson(out)).toStrictEqual({
        cli: { release: version, protocol: protocolVersion },
        engine: {
          release,
          protocol: protocolVersion,
          supported: [protocolVersion],
        },
      })
    }).pipe(Effect.scoped),
  )

  it.live('says the versions as text', () =>
    Effect.gen(function* () {
      const { socket } = yield* testEngine
      const { exit, out } = yield* fabrica(socket, 'engine', 'version')
      expect(exit).toStrictEqual(Exit.void)
      expect(out.join('\n')).toBe(
        [
          `fabrica ${version} (protocol ${protocolVersion})`,
          `engine  ${release} (protocol ${protocolVersion}, speaks ${protocolVersion})`,
        ].join('\n'),
      )
    }).pipe(Effect.scoped),
  )

  it.live(
    'says the engine’s status as JSON that decodes, sanitised and whole',
    () =>
      Effect.gen(function* () {
        const { socket } = yield* testEngine
        const { exit, out } = yield* fabrica(
          socket,
          '--json',
          'engine',
          'status',
        )
        expect(exit).toStrictEqual(Exit.void)
        expect(out[0]).toMatch(/^[\u0020-\u007e]*$/u)
        const status = Schema.decodeUnknownSync(EngineStatus)(onlyJson(out))
        expect(status.release).toBe(release)
        expect(status.host.hostname).toBe(hostname)
        expect(status.machineWorkers).toBe(4)
        expect(status.stopping).toBe(false)
      }).pipe(Effect.scoped),
  )

  it.live('says the engine’s status as text, the engine’s values escaped', () =>
    Effect.gen(function* () {
      const { socket } = yield* testEngine
      const { exit, out } = yield* fabrica(
        socket,
        'engine',
        'status',
        '-e',
        'local',
      )
      expect(exit).toStrictEqual(Exit.void)
      const text = out.join('\n')
      expect(text).toMatch(/^[\u0020-\u007e\n]*$/u)
      expect(text).toContain('release   1.2.3')
      expect(text).toContain(
        'host      build\\u001b]0;owned\\u0007-\\u202ehost\\u2028 (linux x64, 8 cores)',
      )
      expect(text).toContain('workers   0 of 4')
    }).pipe(Effect.scoped),
  )

  it.live('stops the engine', () =>
    Effect.gen(function* () {
      const { socket, engine } = yield* testEngine
      const { exit, out } = yield* fabrica(socket, 'engine', 'stop', '--json')
      expect(exit).toStrictEqual(Exit.void)
      expect(onlyJson(out)).toStrictEqual({ stopping: true })
      yield* engine.stopRequested
    }).pipe(Effect.scoped),
  )

  it.live('says no engine answers where none runs', () =>
    Effect.gen(function* () {
      const paths = yield* scratchPaths
      const { exit, out, err } = yield* fabrica(
        paths.socket,
        'engine',
        'status',
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(out).toStrictEqual([])
      expect(err).toStrictEqual([
        `fabrica: no engine answers at ${paths.socket}: start one with \`fabrica serve\``,
      ])
    }).pipe(Effect.scoped),
  )

  it.live('refuses an engine it doesn’t know, before it connects', () =>
    Effect.gen(function* () {
      const paths = yield* scratchPaths
      const { exit, err } = yield* fabrica(
        paths.socket,
        'engine',
        'version',
        '--engine',
        'server\u001b[2J-1',
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(err).toStrictEqual([
        'fabrica: no engine named server\\u001b[2J-1 is known: only the local engine (local) is, yet',
      ])
    }).pipe(Effect.scoped),
  )
})

describe('the command line', () => {
  /** Every command of spec §19 not yet built, as it is typed after `fabrica`. */
  const notYet: ReadonlyArray<ReadonlyArray<string>> = [
    ['service', 'install'],
    ['service', 'uninstall'],
    ['service', 'status'],
    ['engine', 'update'],
    ['token', 'create'],
    ['token', 'list'],
    ['token', 'revoke'],
    ['credentials', 'set'],
    ['credentials', 'list'],
    ['credentials', 'remove'],
    ['credentials', 'login'],
    ['project', 'add'],
    ['project', 'list'],
    ['project', 'remove'],
    ['init'],
    ['run'],
    ['run', 'status'],
    ['run', 'drain'],
    ['run', 'undrain'],
    ['run', 'stop'],
    ['follow'],
    ['answer'],
    ['talk', 'refine'],
    ['talk', 'feature'],
    ['talk', 'answer'],
    ['talk', 'run'],
    ...[
      'list',
      'show',
      'create',
      'update',
      'close',
      'reopen',
      'defer',
      'dep',
      'label',
      'note',
      'ready',
      'why',
      'rebuild',
      'import',
    ].map(name => ['tickets', name]),
    ['requires'],
    ['report'],
    ['insights'],
  ]

  it.effect.each(notYet.map(command => command.join(' ')))(
    'says `fabrica %s` isn’t built yet',
    command =>
      Effect.gen(function* () {
        const { exit, out, err } = yield* fabrica(
          '/nowhere',
          ...command.split(' '),
          '--json',
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(out).toStrictEqual([])
        expect(err).toStrictEqual([
          `fabrica: \`fabrica ${command}\` is not in ${versionLine} yet`,
        ])
      }),
  )

  it.effect('says a stub isn’t built whatever it is given', () =>
    Effect.gen(function* () {
      const { exit, err } = yield* fabrica('/nowhere', 'report', 'run-7')
      expect(Exit.isFailure(exit)).toBe(true)
      expect(err).toStrictEqual([
        `fabrica: \`fabrica report\` is not in ${versionLine} yet`,
      ])
    }),
  )

  it.effect('lists every command group of §19 in its help', () =>
    Effect.gen(function* () {
      const { exit, out } = yield* fabrica('/nowhere', '--help')
      expect(exit).toStrictEqual(Exit.void)
      const help = out.join('\n')
      for (const group of [
        'serve',
        'bridge',
        'service',
        'engine',
        'token',
        'credentials',
        'project',
        'init',
        'run',
        'follow',
        'answer',
        'talk',
        'tickets',
        'requires',
        'report',
        'insights',
      ]) {
        expect(help).toMatch(new RegExp(`^  ${group} `, 'mu'))
      }
      expect(help).toContain('--json')
      expect(help).toContain('--engine, -e')
      expect(help).toMatch(/^[\u0020-\u007e\n]*$/u)
    }),
  )

  it.effect(
    'takes flags with two dashes, and refuses a long one with one',
    () =>
      Effect.gen(function* () {
        const { exit, out, err } = yield* fabrica(
          '/nowhere',
          'engine',
          'version',
          '-json',
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(out.join('\n')).toContain('USAGE')
        expect(err.join('\n')).toContain('Unrecognized flag: -j')
      }),
  )

  it.effect('sanitises the errors it prints of what it was given', () =>
    Effect.gen(function* () {
      const { exit, err } = yield* fabrica(
        '/nowhere',
        'engine',
        'version',
        '--bad\u001b[2J\u202e',
      )
      expect(Exit.isFailure(exit)).toBe(true)
      const printed = err.join('\n')
      expect(printed).toContain('Unrecognized flag: --bad')
      expect(printed).toContain('\\u202e')
      expect(printed).toMatch(/^[\u0020-\u007e\n]*$/u)
    }),
  )
})
