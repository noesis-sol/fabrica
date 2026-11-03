import {
  Console,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Stdio,
  Stream,
} from 'effect'
import * as NodePath from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import { EngineHost } from '@fabrica/contracts'
import { Daemon, Process, Run, Secrets } from '@fabrica/engine'
import { layerHost, tempFolder } from '@fabrica/testkit'

import { LocalEngine } from '../src/cli/connect'
import { runCli } from '../src/cli/main'

// `fabrica credentials set|list|remove|login` (spec §19, §20.3): run as the CLI's entry runs it, against
// an engine started in a temporary data folder, whose secret store is in memory and whose one provider
// signs in as the test scripts it. A key is read from stdin, never from the command line, and never
// printed; a sign-in's steps are printed as they come, its question answered from stdin's next line.

const host = new EngineHost({
  platform: 'linux',
  arch: 'x64',
  hostname: 'test',
  cores: 4,
})

type Providers = Run.EngineCredentials['providers']

/** A provider whose sign-in shows a device code and asks for a code, and takes what it is given as its token. */
const provider: Providers[number] = {
  id: 'anthropic',
  name: 'Anthropic',
  auth: {
    oauth: {
      name: 'Anthropic',
      login: async interaction => {
        interaction.notify({
          type: 'auth_url',
          url: 'https://claude.test/oauth',
          instructions: 'Paste the code here.',
        })
        interaction.notify({
          type: 'device_code',
          userCode: 'ABCD-1234',
          verificationUri: 'https://device.test',
        })
        const code = await interaction.prompt({
          type: 'manual_code',
          message: 'The code:',
        })
        if (code !== 'right') throw new Error(`the provider refused ${code}`)
        return {
          type: 'oauth',
          access: code,
          refresh: 'refresh',
          expires: Number.MAX_SAFE_INTEGER,
        }
      },
      refresh: credential => Promise.resolve(credential),
      toAuth: credential => Promise.resolve({ apiKey: credential.access }),
    },
  },
  getModels: () => [],
  stream: () => {
    throw new Error('no model is called here')
  },
  streamSimple: () => {
    throw new Error('no model is called here')
  },
}

/** An engine in a temporary data folder, its credentials in memory; its local socket. */
const credentialsEngine = Effect.gen(function* () {
  const root = yield* tempFolder('credentials-cli')
  const paths = Daemon.pathsIn({
    data: NodePath.join(root, 'd'),
    socketFolder: NodePath.join(root, 'd'),
  })
  const items = new Map<string, Redacted.Redacted<string>>()
  const secrets = yield* Secrets.makeSecrets({
    store: {
      kind: 'file',
      read: item => Effect.sync(() => Option.fromUndefinedOr(items.get(item))),
      write: (item, value) =>
        Effect.sync(() => {
          items.set(item, value)
        }),
      remove: item =>
        Effect.sync(() => {
          items.delete(item)
        }),
    },
    cwd: root,
  }).pipe(
    Effect.provideService(
      Process.ProcessRunner,
      Process.ProcessRunner.of({
        run: () => Effect.die('a test ran a key command'),
        start: () => Effect.die('a test ran a key command'),
      }),
    ),
  )
  yield* Daemon.startEngine({
    paths,
    host,
    release: '1.2.3',
    runs: Layer.succeed(Run.RunHosting)(
      Run.RunHostingShape.Refused({
        reason: 'no runs here',
        credentials: { secrets, providers: [provider] },
      }),
    ),
  })
  return { socket: paths.socket, secrets, items }
})

/** `fabrica <args>` with stdin giving `input`: its exit and what it printed. */
const fabrica = (
  socket: string,
  input: string,
  ...args: ReadonlyArray<string>
) =>
  Effect.gen(function* () {
    const out: Array<string> = []
    const err: Array<string> = []
    const console: Console.Console = Object.assign(
      Object.create(globalThis.console),
      {
        log: (...parts: ReadonlyArray<unknown>) => out.push(parts.join(' ')),
        error: (...parts: ReadonlyArray<unknown>) => err.push(parts.join(' ')),
      },
    )
    const exit = yield* runCli(args).pipe(
      Effect.provideService(Console.Console, console),
      Effect.provide(
        Stdio.layerTest({
          stdin: Stream.make(input).pipe(
            Stream.map(text => new TextEncoder().encode(text)),
          ),
        }),
      ),
      Effect.provide([
        NodeServices.layer,
        Layer.succeed(LocalEngine)({ socket: Effect.succeed(socket) }),
        layerHost(),
      ]),
      Effect.exit,
    )
    return { exit, out, err }
  })

const textOf = (out: ReadonlyArray<string>) => out.join('\n')

describe('fabrica credentials', () => {
  it.live('sets a key from stdin and a command, lists names, and removes', () =>
    Effect.gen(function* () {
      const { socket, items } = yield* credentialsEngine

      const empty = yield* fabrica(socket, '', 'credentials', 'list')
      expect(empty.exit).toStrictEqual(Exit.void)
      expect(textOf(empty.out)).toContain('no credentials')

      const set = yield* fabrica(
        socket,
        'sk-from-stdin\n',
        'credentials',
        'set',
        'openai.work',
        '--provider',
        'openai',
      )
      expect(set.exit).toStrictEqual(Exit.void)
      expect(textOf(set.out)).not.toContain('sk-from-stdin')
      const kept = items.get('openai.work')
      expect(kept && Redacted.value(kept)).toContain('sk-from-stdin')

      const command = yield* fabrica(
        socket,
        '',
        'credentials',
        'set',
        'google',
        '--command',
        'op read k',
      )
      expect(command.exit).toStrictEqual(Exit.void)

      const listed = yield* fabrica(socket, '', 'credentials', 'list')
      expect(listed.out).toStrictEqual([
        'google       command\nopenai.work  key  openai',
      ])
      expect(textOf(listed.out)).not.toContain('sk-from-stdin')

      const json = yield* fabrica(socket, '', 'credentials', 'list', '--json')
      expect(JSON.parse(textOf(json.out))).toStrictEqual([
        { name: 'google', kind: 'command', provider: null },
        { name: 'openai.work', kind: 'key', provider: 'openai' },
      ])

      const removed = yield* fabrica(
        socket,
        '',
        'credentials',
        'remove',
        'google',
      )
      expect(removed.out).toStrictEqual(['removed google'])
      const gone = yield* fabrica(socket, '', 'credentials', 'remove', 'google')
      expect(Exit.isFailure(gone.exit)).toBe(true)
      expect(gone.err).toStrictEqual([
        'fabrica: the engine has no credential named google',
      ])

      const none = yield* fabrica(socket, '\n', 'credentials', 'set', 'x')
      expect(Exit.isFailure(none.exit)).toBe(true)
      expect(none.err).toStrictEqual(['fabrica: no key was given for x'])
    }).pipe(Effect.scoped),
  )

  it.live(
    'signs in, printing the terms, the URL and code, and answering from stdin',
    () =>
      Effect.gen(function* () {
        const { socket } = yield* credentialsEngine
        const { exit, out, err } = yield* fabrica(
          socket,
          'right\n',
          'credentials',
          'login',
          'anthropic',
        )
        expect(err).toStrictEqual([])
        expect(exit).toStrictEqual(Exit.void)
        expect(out).toStrictEqual([
          "Whether this provider's terms allow its subscription in a third-party agent is yours to check.",
          'open https://claude.test/oauth\nPaste the code here.',
          'enter ABCD-1234 at https://device.test',
          'The code:',
          'signed in: the engine keeps it as anthropic',
        ])
        const listed = yield* fabrica(socket, '', 'credentials', 'list')
        expect(listed.out).toStrictEqual(['anthropic  oauth  anthropic'])
      }).pipe(Effect.scoped),
  )

  it.live('prints each step as JSON with --json', () =>
    Effect.gen(function* () {
      const { socket } = yield* credentialsEngine
      const { out } = yield* fabrica(
        socket,
        'right\n',
        'credentials',
        'login',
        'anthropic',
        '--json',
      )
      expect(out.map((line): unknown => JSON.parse(line))).toMatchObject([
        { _tag: 'terms' },
        { _tag: 'open_url', url: 'https://claude.test/oauth' },
        { _tag: 'device_code', code: 'ABCD-1234' },
        { _tag: 'asked', message: 'The code:', choices: [] },
        { _tag: 'signed_in', account: 'anthropic' },
      ])
    }).pipe(Effect.scoped),
  )

  it.live('says why a sign-in failed', () =>
    Effect.gen(function* () {
      const { socket } = yield* credentialsEngine
      const failed = yield* fabrica(
        socket,
        'wrong\n',
        'credentials',
        'login',
        'anthropic',
      )
      expect(Exit.isFailure(failed.exit)).toBe(true)
      expect(failed.err).toStrictEqual([
        'fabrica: the sign-in to anthropic failed: the provider refused wrong',
      ])
      const none = yield* fabrica(socket, '', 'credentials', 'login', 'mistral')
      expect(none.err).toStrictEqual([
        'fabrica: the sign-in to mistral failed: mistral has no sign-in in pi-ai',
      ])
    }).pipe(Effect.scoped),
  )
})
