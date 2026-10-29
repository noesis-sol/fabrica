import { Effect, Exit, Layer, Option, Schedule, Stream } from 'effect'
import { FetchHttpClient, type HttpClient } from 'effect/http'
import { RpcClientError, RpcSerialization, RpcServer } from 'effect/rpc'
import { SocketServer } from 'effect/socket'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmod, mkdir, readFile, readlink, writeFile } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { NodeSocketServer } from '@effect/platform-node'
import { describe, expect, it, layer } from '@effect/vitest'
import { EngineHello, EngineId, EngineRpcs } from '@fabrica/contracts'
import { distributionName } from '@fabrica/engine/update'
import {
  Toolbox,
  findTool,
  hostPathOfProcess,
  makeToolbox,
  shStub,
  tempFolder,
} from '@fabrica/testkit'

import {
  type EngineClientShape,
  Link,
  make,
  windowsDriveOf,
  windowsDriveWarning,
} from '../src'
import {
  DistributionSource,
  HostShell,
  InstallConsent,
  InstallFailure,
  InstallPlan,
  checkHost,
  installEngine,
  noServiceWords,
  wslShell,
} from '../src/install'
import {
  type WslFailure,
  WslSearch,
  checkoutWarning,
  chooseDistribution,
  decodeWslText,
  findDistribution,
  holdDistribution,
  holdScript,
  layerWsl,
  parseWslList,
  wslEnded,
  wslFailed,
  wslReconnect,
} from '../src/node'

// The WSL2 host (spec §7.6, H31) against a stub `wsl.exe` at the process boundary: a shell script that
// records each run's arguments and its WSL_UTF8, then answers as wsl.exe does. `--list --verbose`
// prints its folder's `list` file (UTF-16LE, as wsl.exe writes its own messages) and exits with its
// `code`; `-d <distro>` refuses a distribution other than its `distro` file's in WSL's words, runs an
// `--exec` command as it is given, and a `--` command through sh, as the distribution's shell would. The
// distribution is this machine with a temp home folder and stubs saying what system it is: the
// install's steps run there through the stub, the bridge's `fabrica` joins its stdio to a minimal
// engine's socket, and the keep-alive asks a fake engine at `~/.local/bin/fabrica`.

const wslStub = shStub(
  [
    'dir="$STUB_DIR"',
    `{ printf 'run %s\\n' "\${WSL_UTF8:-}"; printf '%s\\n' "$@"; } >> "$dir/runs.log"`,
    'case "$1" in',
    '--list) cat "$dir/list"; exit "$(cat "$dir/code")" ;;',
    '-d)',
    '  if [ "$2" != "$(cat "$dir/distro")" ]; then',
    "    printf 'There is no distribution with the supplied name.\\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\\n' >&2",
    '    exit 1',
    '  fi',
    '  if [ "$3" = --exec ]; then shift 3; exec "$@"; fi',
    '  shift 3',
    '  exec sh -c "$*"',
    '  ;;',
    'esac',
    'exit 2',
  ].join('\n'),
)

/** The bridge's `fabrica` on the distribution's PATH: `fabrica bridge` joins its stdio to the engine's socket. */
const fabricaStub = shStub(
  [
    'if [ -n "${STUB_NO_FABRICA:-}" ]; then',
    "  echo 'sh: 1: fabrica: not found' >&2",
    '  exit 127',
    'fi',
    `exec "$STUB_NODE" -e "const s = require('node:net').connect(process.env.STUB_ENGINE); process.stdin.pipe(s); s.pipe(process.stdout); s.on('close', () => process.exit(0)); s.on('error', () => process.exit(1))"`,
  ].join('\n'),
)

/** The distribution's system, and its systemd and flock, from the stubs' variables. */
const distroStubs: Readonly<Record<string, string>> = {
  'wsl.exe': wslStub,
  fabrica: fabricaStub,
  uname: shStub('case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac'),
  getconf: shStub('echo "glibc 2.39"'),
  ldconfig: shStub(
    "printf '\\tlibatomic.so.1 (libc6,x86-64) => /lib/x86_64-linux-gnu/libatomic.so.1\\n'",
  ),
  // As in a distribution without systemd: systemctl is there, but can't operate.
  systemctl: shStub(
    [
      '[ -z "${STUB_SYSTEMD:-}" ] || exit 0',
      'echo "System has not been booted with systemd as init system (PID 1). Can\'t operate." >&2',
      'exit 1',
    ].join('\n'),
  ),
  flock: shStub('[ -z "${STUB_FLOCK_HELD:-}" ]'),
}

/** The real tools the install's scripts and the keep-alive run in the distribution. */
const distroTools = [
  'sh',
  'cat',
  'mkdir',
  'mv',
  'ln',
  'rm',
  'tar',
  'gzip',
  'awk',
  'sed',
  'head',
  'tr',
  'cut',
  'dirname',
  'grep',
  'sleep',
]

const layerDistro = Layer.effect(
  Toolbox,
  Effect.gen(function* () {
    const hostPath = hostPathOfProcess()
    // macOS has had sha256sum only since 15; shasum, before it.
    const sum = Option.isSome(yield* findTool('sha256sum', hostPath))
      ? 'sha256sum'
      : 'shasum'
    return yield* makeToolbox({
      tools: [...distroTools, sum],
      stubs: distroStubs,
      hostPath,
    })
  }),
)

/** A run of the stub, as it recorded it. */
interface Run {
  readonly utf8: string
  readonly args: ReadonlyArray<string>
}

/** A distribution: the stub's folder, wsl.exe's list and exit code, and a home folder. */
const setUp = Effect.fn(function* (options?: {
  readonly list?: Uint8Array
  readonly code?: number
  readonly vars?: Readonly<Record<string, string>>
}) {
  const tools = yield* Toolbox
  const dir = yield* tempFolder('wsl')
  const home = yield* tempFolder('wsl-home')
  yield* Effect.promise(() =>
    Promise.all([
      writeFile(NodePath.join(dir, 'distro'), 'Ubuntu'),
      writeFile(NodePath.join(dir, 'list'), options?.list ?? new Uint8Array()),
      writeFile(NodePath.join(dir, 'code'), String(options?.code ?? 0)),
      writeFile(NodePath.join(dir, 'runs.log'), ''),
    ]),
  )
  return {
    dir,
    home,
    env: {
      ...tools.env({
        STUB_DIR: dir,
        STUB_NODE: process.execPath,
        ...options?.vars,
      }),
      HOME: home,
    },
    runs: Effect.promise(async (): Promise<ReadonlyArray<Run>> => {
      const text = await readFile(NodePath.join(dir, 'runs.log'), 'utf8')
      return text
        .split(/^run /mu)
        .filter(block => block !== '')
        .map(block => {
          const [utf8 = '', ...args] = block.replace(/\n$/u, '').split('\n')
          return { utf8, args }
        })
    }),
  }
})

/** Text as wsl.exe writes its own: UTF-16LE with a byte order mark. */
const wide = (text: string): Uint8Array => Buffer.from(`﻿${text}`, 'utf16le')

const listing = [
  '  NAME                   STATE           VERSION',
  '* docker-desktop         Running         2',
  '  Debian                 Stopped         1',
  '  Ubuntu-24.04           Stopped         2',
  '  Ubuntu                 Running         2',
  '',
].join('\r\n')

const readText = (path: string) =>
  Effect.promise(() => readFile(path, 'utf8').catch(() => ''))

describe('the WSL distribution', () => {
  it('reads wsl.exe in UTF-16 and in UTF-8', () => {
    expect(decodeWslText(wide('  NAME\r\n* Ubuntu'))).toBe('  NAME\r\n* Ubuntu')
    expect(decodeWslText(Buffer.from('* Ubuntu Running 2\n'))).toBe(
      '* Ubuntu Running 2\n',
    )
  })

  it('lists distributions by their version, whatever language the header and the state are in', () => {
    expect(parseWslList(listing)).toEqual([
      { name: 'docker-desktop', version: 2, default: true },
      { name: 'Debian', version: 1, default: false },
      { name: 'Ubuntu-24.04', version: 2, default: false },
      { name: 'Ubuntu', version: 2, default: false },
    ])
    expect(
      parseWslList(
        '  NAME      ZUSTAND          VERSION\n* Ubuntu    Wird ausgeführt  2\n',
      ),
    ).toEqual([{ name: 'Ubuntu', version: 2, default: true }])
  })

  it("chooses the default WSL2 distribution, else the first, and never a tool's own", () => {
    // Docker Desktop's is the default here: the first other WSL2 one is chosen.
    expect(chooseDistribution(parseWslList(listing))).toEqual(
      WslSearch.Found({ distro: 'Ubuntu-24.04' }),
    )
    expect(
      chooseDistribution([
        { name: 'Ubuntu-24.04', version: 2, default: false },
        { name: 'Ubuntu', version: 2, default: true },
      ]),
    ).toEqual(WslSearch.Found({ distro: 'Ubuntu' }))
    expect(
      chooseDistribution([
        { name: 'Debian', version: 1, default: true },
        { name: 'docker-desktop', version: 2, default: false },
      ]),
    ).toEqual(WslSearch.None({ wsl1: ['Debian'] }))
  })

  it('warns about a checkout on a Windows drive', () => {
    expect(windowsDriveOf('/mnt/c/Users/me/project')).toEqual(Option.some('C'))
    expect(windowsDriveOf('/mnt/d')).toEqual(Option.some('D'))
    expect(windowsDriveOf('/mnt/wsl/shared')).toEqual(Option.none())
    expect(windowsDriveOf('/home/me/mnt/c/project')).toEqual(Option.none())
    expect(windowsDriveWarning('/mnt/c/Users/me/project')).toEqual(
      Option.some(
        "/mnt/c/Users/me/project is on the Windows drive C:, where git is slow and POSIX file semantics don't hold: clone the project into the distribution's own file system, such as under ~/",
      ),
    )
    expect(windowsDriveWarning('/home/me/project')).toEqual(Option.none())
  })

  it('tells why the bridge ended', () => {
    const ended = (code: number | null, stderr: string) =>
      Option.map(
        wslEnded({ code, signal: code === null ? 'SIGTERM' : null, stderr }),
        failure => failure._tag,
      )
    expect(ended(0, '')).toEqual(Option.none())
    expect(
      ended(
        4294967295,
        'There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n',
      ),
    ).toEqual(Option.some('DistroMissing'))
    expect(ended(127, '/bin/bash: line 1: fabrica: command not found')).toEqual(
      Option.some('BridgeMissing'),
    )
    expect(
      ended(1, 'The Windows Subsystem for Linux instance has terminated.'),
    ).toEqual(Option.some('Lost'))
    expect(ended(null, '')).toEqual(Option.some('Lost'))
  })
})

layer(layerDistro, { excludeTestServices: true })(
  'detection through wsl.exe',
  it => {
    it.effect(
      'finds the distribution in wsl.exe --list --verbose, asking for UTF-8',
      () =>
        Effect.gen(function* () {
          const { env, runs } = yield* setUp({ list: wide(listing) })
          expect(yield* findDistribution({ env })).toEqual(
            WslSearch.Found({ distro: 'Ubuntu-24.04' }),
          )
          expect(yield* runs).toEqual([
            { utf8: '1', args: ['--list', '--verbose'] },
          ])
        }),
    )

    it.effect('finds none where WSL has no distribution', () =>
      Effect.gen(function* () {
        const { env } = yield* setUp({
          list: wide(
            "Windows Subsystem for Linux has no installed distributions.\r\nYou can resolve this by installing a distribution with the instructions below:\r\n\r\nUse 'wsl.exe --list --online' to list available distributions\r\nand 'wsl.exe --install <Distro>' to install.\r\n",
          ),
          code: 1,
        })
        expect(yield* findDistribution({ env })).toEqual(
          WslSearch.None({ wsl1: [] }),
        )
      }),
    )

    it.effect("says why where wsl.exe can't be run", () =>
      Effect.gen(function* () {
        const { env, dir } = yield* setUp()
        const found = yield* findDistribution({
          env,
          wsl: NodePath.join(dir, 'no-wsl.exe'),
        })
        expect(WslSearch.$is('Unavailable')(found)).toBe(true)
      }),
    )

    it.effect(
      'warns about a checkout on a Windows drive, its links resolved in the distribution',
      () =>
        Effect.gen(function* () {
          const { env, home, runs } = yield* setUp()
          const project = NodePath.join(home, 'project')
          yield* Effect.promise(() => mkdir(project))
          expect(
            yield* checkoutWarning({ env, distro: 'Ubuntu', path: project }),
          ).toEqual(Option.none())
          // Not there to resolve, it is still judged by its own path.
          expect(
            Option.isSome(
              yield* checkoutWarning({
                env,
                distro: 'Ubuntu',
                path: '/mnt/c/Users/me/project',
              }),
            ),
          ).toBe(true)
          expect((yield* runs)[0]?.args.slice(0, 4)).toEqual([
            '-d',
            'Ubuntu',
            '--exec',
            'sh',
          ])
        }),
    )
  },
)

// The install through wsl.exe, from a release folder of the linux-x64 engine signed by a test key.

const releaseKey = generateKeyPairSync('ed25519')
const releasePem = releaseKey.publicKey
  .export({ type: 'spki', format: 'pem' })
  .toString()

/** The fixture `fabrica`: records each run in $HOME/ran, and answers as the engine's would. */
const launcher = shStub(
  [
    `printf '%s\\n' "$*" >> "$HOME/ran"`,
    'case "$1" in',
    "--version) echo 'fabrica v0.1.0' ;;",
    'service) echo "installed the systemd user unit fabrica-engine.service" ;;',
    'esac',
  ].join('\n'),
)

const fixtureRelease = Effect.gen(function* () {
  const root = yield* tempFolder('wsl-release')
  const stage = yield* tempFolder('wsl-stage')
  const name = distributionName({ version: '0.1.0', target: 'linux-x64' })
  const bin = NodePath.join(stage, name, 'bin')
  const archive = NodePath.join(root, `${name}.tar.gz`)
  yield* Effect.promise(async () => {
    await mkdir(bin, { recursive: true })
    await writeFile(NodePath.join(bin, 'fabrica'), launcher)
    await chmod(NodePath.join(bin, 'fabrica'), 0o755)
  })
  yield* Effect.sync(() =>
    execFileSync('tar', ['-czf', archive, '-C', stage, name], {
      env: { PATH: '/usr/bin:/bin', COPYFILE_DISABLE: '1' },
      stdio: 'ignore',
    }),
  )
  const bytes = yield* Effect.promise(() => readFile(archive))
  const checksums = Buffer.from(
    `${createHash('sha256').update(bytes).digest('hex')}  ${name}.tar.gz\n`,
  )
  yield* Effect.promise(async () => {
    await writeFile(NodePath.join(root, 'checksums.txt'), checksums)
    await writeFile(
      NodePath.join(root, 'checksums.txt.sig'),
      sign(null, checksums, releaseKey.privateKey),
    )
  })
  return DistributionSource.Folder({ folder: root, keys: [releasePem] })
})

/** How long a test of the install has: each runs a dozen shells through the stub, on a loaded machine. */
const shellTime = 30_000

layer(layerDistro, { excludeTestServices: true })(
  'the install through wsl.exe',
  it => {
    const install = (vars: Readonly<Record<string, string>>) =>
      Effect.gen(function* () {
        const { env, home, runs } = yield* setUp({ vars })
        const source = yield* fixtureRelease
        const shell = wslShell({ distro: 'Ubuntu', env })
        const run = <A, E>(
          effect: Effect.Effect<A, E, HostShell | HttpClient.HttpClient>,
        ) =>
          effect.pipe(
            Effect.provideService(HostShell, shell),
            Effect.provide(FetchHttpClient.layer),
          )
        const check = yield* run(checkHost(source))
        expect(check.target).toBe('linux-x64')
        expect(check.plan).toEqual(
          InstallPlan.cases.Install.make({ to: '0.1.0' }),
        )
        const installed = yield* run(
          installEngine({
            source,
            consent: InstallConsent.cases.Install.make({ to: '0.1.0' }),
            loginService: 'where-systemd-runs',
          }),
        )
        const placed = NodePath.join(
          home,
          '.local',
          'share',
          'fabrica',
          'engine',
          '0.1.0',
          'bin',
          'fabrica',
        )
        expect(installed.launcher).toBe(placed)
        expect(
          yield* Effect.promise(() =>
            readlink(NodePath.join(home, '.local', 'bin', 'fabrica')),
          ),
        ).toBe(placed)
        // Every command ran in the distribution, without a shell between, wsl.exe speaking UTF-8.
        const all = yield* runs
        expect(all.length).toBeGreaterThan(3)
        expect(
          all.every(
            ({ utf8, args }) =>
              utf8 === '1' &&
              args[0] === '-d' &&
              args[1] === 'Ubuntu' &&
              args[2] === '--exec',
          ),
        ).toBe(true)
        return {
          installed,
          ran: yield* readText(NodePath.join(home, 'ran')),
        }
      })

    it.effect('says so where WSL has no such distribution', () =>
      Effect.gen(function* () {
        const { env } = yield* setUp()
        const source = yield* fixtureRelease
        const failure = yield* Effect.flip(
          checkHost(source).pipe(
            Effect.provideService(
              HostShell,
              wslShell({ distro: 'Debian', env }),
            ),
            Effect.provide(FetchHttpClient.layer),
          ),
        )
        expect(failure).toEqual(
          InstallFailure.Unreachable({
            reason:
              "couldn't run the install's commands on WSL Debian: WSL has no distribution named Debian: install it, or choose another",
          }),
        )
      }),
    )

    it.effect(
      'installs the engine in the distribution, and its systemd user unit where systemd runs',
      () =>
        Effect.gen(function* () {
          const { installed, ran } = yield* install({ STUB_SYSTEMD: '1' })
          expect(installed.service).toBe(
            'installed the systemd user unit fabrica-engine.service',
          )
          expect(ran).toBe('--version\nservice install\n')
        }),
      shellTime,
    )

    it.effect(
      "installs no login service where the distribution's systemd doesn't run: the bridge starts the engine",
      () =>
        Effect.gen(function* () {
          const { installed, ran } = yield* install({})
          expect(installed.service).toBe(noServiceWords)
          expect(ran).toBe('--version\n')
        }),
      shellTime,
    )
  },
)

// The bridge.

/** A minimal engine at `path`: it says hello, and serves nothing else. */
const serveEngine = (path: string) =>
  Effect.gen(function* () {
    const handlers = EngineRpcs.toLayer({
      'engine.connect': hello =>
        Effect.succeed(
          new EngineHello({
            protocol: hello.protocol,
            engine: EngineId.make('e-wsl'),
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
    const listening = yield* NodeSocketServer.make({ path })
    yield* Layer.build(
      RpcServer.layer(EngineRpcs).pipe(
        Layer.provide(handlers),
        Layer.provide(RpcServer.layerProtocolSocketServer),
        Layer.provide(RpcSerialization.layerNdjson),
        Layer.provide(Layer.succeed(SocketServer.SocketServer, listening)),
      ),
    )
  })

const clientIn = ({
  env,
  distro,
}: {
  readonly env: Readonly<Record<string, string>>
  readonly distro: string
}) =>
  make({
    name: 'test client',
    kind: 'cli',
    release: '0.1.0',
    protocol: 1,
    reconnect: wslReconnect(Schedule.spaced('10 millis')),
  }).pipe(Effect.provide(layerWsl({ distro, env })))

/** The WSL failure a client's start failed with. */
const failureOf = (
  exit: Exit.Exit<EngineClientShape, unknown>,
): Option.Option<WslFailure['_tag']> =>
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
        error => Option.map(wslFailed(error), failed => failed.failure._tag),
      ),
  })

layer(layerDistro, { excludeTestServices: true })('the WSL bridge', it => {
  it.effect(
    'runs wsl.exe -d <distro> -- fabrica bridge, and reaches the engine',
    () =>
      Effect.gen(function* () {
        const socket = NodePath.join(
          yield* tempFolder('wsl-engine'),
          'engine.sock',
        )
        yield* serveEngine(socket)
        const { env, runs } = yield* setUp({ vars: { STUB_ENGINE: socket } })
        const client = yield* clientIn({ env, distro: 'Ubuntu' })
        expect(Link.$is('Up')(yield* client.link)).toBe(true)
        expect(yield* runs).toEqual([
          { utf8: '1', args: ['-d', 'Ubuntu', '--', 'fabrica', 'bridge'] },
        ])
      }),
  )

  it.effect('refuses a distribution WSL has none of, and tries no more', () =>
    Effect.gen(function* () {
      const { env, runs } = yield* setUp()
      const exit = yield* Effect.exit(clientIn({ env, distro: 'Debian' }))
      expect(failureOf(exit)).toEqual(Option.some('DistroMissing'))
      expect((yield* runs).length).toBe(1)
    }),
  )

  it.effect('refuses a distribution with no fabrica on its PATH', () =>
    Effect.gen(function* () {
      const { env } = yield* setUp({ vars: { STUB_NO_FABRICA: '1' } })
      const exit = yield* Effect.exit(clientIn({ env, distro: 'Ubuntu' }))
      expect(failureOf(exit)).toEqual(Option.some('BridgeMissing'))
    }),
  )
})

// The keep-alive, asking a fake engine that answers as its `answers` file says, one letter for each
// question: `y` it answers, `n` it doesn't.

const fakeEngine = shStub(
  [
    'n=$(($(cat "$HOME/asked" 2>/dev/null || echo 0) + 1))',
    'echo "$n" > "$HOME/asked"',
    '[ "$1 $2" = "engine status" ] || exit 2',
    '[ "$(cut -c "$n" "$HOME/answers")" = y ]',
  ].join('\n'),
)

const withEngine = (answers: string) =>
  Effect.gen(function* () {
    const set = yield* setUp()
    const bin = NodePath.join(set.home, '.local', 'bin')
    yield* Effect.promise(async () => {
      await mkdir(bin, { recursive: true })
      await writeFile(NodePath.join(bin, 'fabrica'), fakeEngine)
      await chmod(NodePath.join(bin, 'fabrica'), 0o755)
      await writeFile(NodePath.join(set.home, 'answers'), `${answers}\n`)
    })
    return {
      ...set,
      asked: Effect.map(readText(NodePath.join(set.home, 'asked')), text =>
        text.trim(),
      ),
    }
  })

layer(layerDistro, { excludeTestServices: true })(
  'the keep-alive through wsl.exe',
  it => {
    it.effect(
      'holds the distribution while the engine answers, and ends once it stops',
      () =>
        Effect.gen(function* () {
          const { env, home, runs, asked } = yield* withEngine('yyyn')
          const held = yield* holdDistribution({
            env,
            distro: 'Ubuntu',
            every: 0,
            wait: 0,
          })
          expect(yield* held.ended).toEqual({ code: 0, signal: null })
          expect(yield* asked).toBe('4')
          expect(yield* runs).toEqual([
            {
              utf8: '1',
              args: [
                '-d',
                'Ubuntu',
                '--exec',
                'sh',
                '-c',
                holdScript,
                'sh',
                '0',
                '0',
              ],
            },
          ])
          // It held the lock that keeps a second from holding it too.
          expect(
            yield* readText(
              NodePath.join(
                home,
                '.local',
                'share',
                'fabrica',
                'wsl-hold.lock',
              ),
            ),
          ).toBe('')
        }),
    )

    it.effect(
      "waits for the engine's first answer, as the bridge starts it",
      () =>
        Effect.gen(function* () {
          const { env, asked } = yield* withEngine('nyn')
          const held = yield* holdDistribution({
            env,
            distro: 'Ubuntu',
            every: 0,
            wait: 1,
          })
          expect((yield* held.ended).code).toBe(0)
          expect(yield* asked).toBe('3')
        }),
    )

    it.effect('ends at once where no engine answers in time', () =>
      Effect.gen(function* () {
        const { env, asked } = yield* withEngine('n')
        const held = yield* holdDistribution({
          env,
          distro: 'Ubuntu',
          every: 0,
          wait: 0,
        })
        expect((yield* held.ended).code).toBe(0)
        expect(yield* asked).toBe('1')
      }),
    )

    it.effect(
      'leaves the distribution to the keep-alive already holding it',
      () =>
        Effect.gen(function* () {
          const { env, asked } = yield* withEngine('yyyn')
          const held = yield* holdDistribution({
            env: { ...env, STUB_FLOCK_HELD: '1' },
            distro: 'Ubuntu',
            every: 0,
            wait: 0,
          })
          expect((yield* held.ended).code).toBe(0)
          expect(yield* asked).toBe('')
        }),
    )
  },
)
