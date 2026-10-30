import { Console, Effect, Exit, Layer } from 'effect'
import { access, readFile } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { describe, expect, layer } from '@effect/vitest'
import { bridgeRemote } from '@fabrica/client/node'
import { EngineHost, protocolVersion } from '@fabrica/contracts'
import { Daemon } from '@fabrica/engine'
import {
  Toolbox,
  layerHost,
  layerToolbox,
  shStub,
  tempFolder,
} from '@fabrica/testkit'

import { LocalEngine, SshEnvironment } from '../src/cli/connect'
import { runCli } from '../src/cli/main'
import { version } from '../src/version'

// `--engine ssh://<destination>` (spec §19, §8.2): the CLI reaches an engine on another host through the
// SSH bridge, as the app does. A stub ssh records its arguments, then either bridges its stdio to an
// engine started in a temporary data folder, as `ssh host fabrica bridge` would, or refuses a changed
// host key in OpenSSH's words.

const bridgeScript = `
const net = process.getBuiltinModule('node:net')
const socket = net.connect(process.argv[1])
process.stdin.pipe(socket)
socket.pipe(process.stdout)
socket.on('close', () => process.exit(0))
socket.on('error', () => process.exit(255))
`

const toolbox = layerToolbox({
  stubs: {
    ssh: shStub(
      [
        'printf "%s\\n" "$@" > "$STUB_DIR/args"',
        'if [ "$STUB_MODE" = changed ]; then',
        '  echo "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @" >&2',
        '  echo "Host key verification failed." >&2',
        '  exit 255',
        'fi',
        'exec "$STUB_NODE" -e "$STUB_BRIDGE" "$STUB_ENGINE"',
      ].join('\n'),
    ),
  },
})

const host = new EngineHost({
  platform: 'linux',
  arch: 'x64',
  hostname: 'server-1',
  cores: 4,
})
const release = '1.2.3'

/** A console that keeps what is printed. */
const capture = () => {
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

/** An engine in a temporary folder, a stub folder, and `fabrica <args>` run with ssh's stub there. */
const setUp = (mode: string) =>
  Effect.gen(function* () {
    const tools = yield* Toolbox
    const root = yield* tempFolder('ssh-cli')
    const paths = Daemon.pathsIn({
      data: NodePath.join(root, 'd'),
      socketFolder: NodePath.join(root, 'd'),
    })
    yield* Daemon.startEngine({ paths, host, release })
    const env = tools.env({
      STUB_DIR: root,
      STUB_MODE: mode,
      STUB_NODE: process.execPath,
      STUB_BRIDGE: bridgeScript,
      STUB_ENGINE: paths.socket,
    })
    const fabrica = (...args: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const printed = capture()
        const exit = yield* runCli(args).pipe(
          Effect.provideService(Console.Console, printed.console),
          Effect.provideService(SshEnvironment, { env }),
          Effect.provide([
            NodeServices.layer,
            // No command here reaches the local engine.
            Layer.succeed(LocalEngine)({
              socket: Effect.succeed(NodePath.join(root, 'none.sock')),
            }),
            layerHost(),
          ]),
          Effect.exit,
        )
        return { exit, out: printed.out, err: printed.err }
      })
    const args = Effect.promise(async () =>
      (await readFile(NodePath.join(root, 'args'), 'utf8')).split('\n'),
    )
    const ran = Effect.promise(() =>
      access(NodePath.join(root, 'args')).then(
        () => true,
        () => false,
      ),
    )
    return { fabrica, args, ran }
  })

describe('fabrica --engine ssh://', () => {
  layer(toolbox, { excludeTestServices: true })(it => {
    it.effect('reaches the engine through the SSH bridge', () =>
      Effect.gen(function* () {
        const { fabrica, args } = yield* setUp('bridge')
        const { exit, out } = yield* fabrica(
          '--engine',
          'ssh://u@server-1:2222',
          'engine',
          'version',
          '--json',
        )
        expect(exit).toStrictEqual(Exit.void)
        expect(JSON.parse(out.join(''))).toStrictEqual({
          cli: { release: version, protocol: protocolVersion },
          engine: {
            release,
            protocol: protocolVersion,
            supported: [protocolVersion],
          },
        })
        expect((yield* args).slice(-6)).toEqual([
          '--',
          'ssh://u@server-1:2222',
          ...bridgeRemote,
          '',
        ])
      }).pipe(Effect.scoped),
    )

    it.effect('says why ssh refused a changed host key', () =>
      Effect.gen(function* () {
        const { fabrica } = yield* setUp('changed')
        const { exit, err } = yield* fabrica(
          '--engine',
          'ssh://u@server-1',
          'engine',
          'status',
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(err).toStrictEqual([
          "fabrica: the host key of ssh://u@server-1 has changed, so ssh refused the connection: check the new key with the host's administrator, then replace the old one in known_hosts",
        ])
      }).pipe(Effect.scoped),
    )

    it.effect('runs no ssh for a destination ssh would read as an option', () =>
      Effect.gen(function* () {
        const { fabrica, ran } = yield* setUp('bridge')
        const { exit, err } = yield* fabrica(
          '--engine',
          'ssh://-oProxyCommand=sh',
          'engine',
          'status',
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(err[0]).toMatch(
          /^fabrica: no engine named ssh:\/\/-oProxyCommand=sh is known/u,
        )
        expect(yield* ran).toBe(false)
      }).pipe(Effect.scoped),
    )
  })
})
