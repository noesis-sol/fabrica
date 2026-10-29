import { Context, Effect, Layer, Option, Result } from 'effect'
import { FetchHttpClient, type HttpClient } from 'effect/http'
import { execFileSync } from 'node:child_process'
import {
  type KeyObject,
  createHash,
  generateKeyPairSync,
  sign,
} from 'node:crypto'
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  readlink,
  writeFile,
} from 'node:fs/promises'
import { type Server, createServer } from 'node:http'
import * as NodePath from 'node:path'

import { describe, expect, it, layer } from '@effect/vitest'
import {
  ENGINE_TARGETS,
  type EngineTarget,
  UpdateFailure,
  distributionName,
} from '@fabrica/engine/update'
import {
  type Tools,
  airtightEnv,
  findTool,
  hostPathOfProcess,
  makeToolbox,
  shStub,
  tempFolder,
} from '@fabrica/testkit'

import {
  DistributionSource,
  type HostFacts,
  HostRefusal,
  HostShell,
  InstallConsent,
  InstallFailure,
  InstallPlan,
  Libc,
  checkHost,
  engineRelease,
  installEngine,
  judgeHost,
  sshShell,
} from '../src/install'

// Installing and updating an engine over SSH (spec §9.2, §8.4) against a stub remote shell: a stub `ssh`
// that runs the command it is given with `sh -c`, as the host's login shell would, in a host made of a
// temp home folder and stub `uname`, `sw_vers`, `sysctl`, `getconf` and `ldconfig` saying what system it
// is, beside the real tools the install runs there (tar, its sum, mv, ln). The engines offered are
// fixture distributions whose `fabrica` records how it ran, with checksums.txt signed by a test key:
// from a folder sent over the shell, or from releases served over HTTP, which the host downloads with
// its curl or the app downloads and sends on where the host has neither curl nor wget.

interface KeyPair {
  readonly privateKey: KeyObject
  readonly publicPem: string
}

const keyPair = (): KeyPair => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privateKey,
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}

const releaseKey = keyPair()
const strangerKey = keyPair()

/**
 * The stub ssh: says it is OpenSSH 9.6 to `-V`; else skips its options, logs the destination, and runs
 * the one remote word as a login shell would.
 */
const sshStub = shStub(
  [
    'if [ "$1" = "-V" ]; then echo "OpenSSH_9.6p1, OpenSSL 3.0.13" >&2; exit 0; fi',
    'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done',
    'shift',
    'printf \'%s\\n\' "$1" >> "$STUB_LOG"',
    'shift',
    'if [ -n "${STUB_SSH_REFUSE:-}" ]; then',
    "  echo 'me@server-1: Permission denied (publickey).' >&2",
    '  exit 255',
    'fi',
    'exec sh -c "$1"',
  ].join('\n'),
)

/** The host's facts, from the stubs' variables. */
const hostStubs: Readonly<Record<string, string>> = {
  uname: shStub(
    'case "$1" in -s) echo "$STUB_KERNEL" ;; -m) echo "$STUB_MACHINE" ;; esac',
  ),
  sw_vers: shStub('echo "$STUB_MACOS"'),
  sysctl: shStub(
    'case "$2" in sysctl.proc_translated) echo "${STUB_TRANSLATED:-0}" ;; hw.optional.sse2) echo 1 ;; *) exit 1 ;; esac',
  ),
  getconf: shStub('echo "glibc $STUB_GLIBC"'),
  ldconfig: shStub(
    "printf '\\tlibatomic.so.1 (libc6,AArch64) => /lib/aarch64-linux-gnu/libatomic.so.1\\n'",
  ),
  ssh: sshStub,
}

/** The real tools the install's scripts run on the host. */
const hostTools = [
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
]

/** Two hosts' toolboxes: one with curl, one with neither curl nor wget. */
class Hosts extends Context.Service<
  Hosts,
  { readonly withCurl: Tools; readonly bare: Tools }
>()('Hosts') {}

const layerHosts = Layer.effect(
  Hosts,
  Effect.gen(function* () {
    const hostPath = hostPathOfProcess()
    // macOS has had sha256sum only since 15; shasum, before it.
    const sum = Option.isSome(yield* findTool('sha256sum', hostPath))
      ? 'sha256sum'
      : 'shasum'
    const make = (extra: ReadonlyArray<string>) =>
      makeToolbox({
        tools: [...hostTools, sum, ...extra],
        stubs: hostStubs,
        hostPath,
      })
    return { withCurl: yield* make(['curl']), bare: yield* make([]) }
  }),
)

/** A host to install on: its system, in the stubs' variables. */
interface StubHost {
  readonly kernel: 'Darwin' | 'Linux'
  readonly machine: string
  readonly macos?: string
  readonly glibc?: string
  readonly sshRefuses?: boolean
}

const mac: StubHost = { kernel: 'Darwin', machine: 'arm64', macos: '14.5' }

/** A host's home and its shell over the stub ssh. */
const stubHost = Effect.fn(function* (host: StubHost, given?: Tools) {
  const tools = given ?? (yield* Hosts).bare
  const home = yield* tempFolder('host')
  const log = NodePath.join(yield* tempFolder('ssh-log'), 'ssh.log')
  const env = airtightEnv({
    path: tools.bin,
    home,
    vars: {
      STUB_LOG: log,
      STUB_KERNEL: host.kernel,
      STUB_MACHINE: host.machine,
      STUB_MACOS: host.macos ?? '',
      STUB_GLIBC: host.glibc ?? '',
      ...(host.sshRefuses === true ? { STUB_SSH_REFUSE: '1' } : {}),
    },
  })
  return {
    home,
    log,
    shell: sshShell({ destination: 'me@server-1', env }),
  }
})

/** The fixture `fabrica` of `version`: records each run in $HOME/ran, and answers as the engine's would. */
const launcher = (version: string) =>
  shStub(
    [
      `printf '%s %s\\n' '${version}' "$*" >> "$HOME/ran"`,
      'case "$1" in',
      `--version) echo 'fabrica v${version}' ;;`,
      'service) echo "installed the launchd agent fabrica.engine: $HOME/Library/LaunchAgents/fabrica.engine.plist" ;;',
      'engine) echo "the engine is winding its runs down and stopping" ;;',
      'esac',
    ].join('\n'),
  )

interface Fixture {
  readonly version: string
  readonly targets: ReadonlyArray<EngineTarget>
  /** The key checksums.txt is signed with: the release key unless given. */
  readonly key?: KeyPair
  /** The archives' bytes aren't those checksums.txt has. */
  readonly tampered?: boolean
}

/** A folder holding a release's archives for `targets`, its checksums.txt and its signature. */
const fixtureRelease = Effect.fn(function* (fixture: Fixture, folder?: string) {
  const root = folder ?? (yield* tempFolder('release'))
  const stage = yield* tempFolder('stage')
  const lines: Array<string> = []
  for (const target of fixture.targets) {
    const name = distributionName({ version: fixture.version, target })
    const bin = NodePath.join(stage, name, 'bin')
    const archive = NodePath.join(root, `${name}.tar.gz`)
    yield* Effect.promise(async () => {
      await mkdir(bin, { recursive: true })
      await writeFile(NodePath.join(bin, 'fabrica'), launcher(fixture.version))
      await chmod(NodePath.join(bin, 'fabrica'), 0o755)
    })
    yield* Effect.sync(() =>
      execFileSync('tar', ['-czf', archive, '-C', stage, name], {
        env: { PATH: '/usr/bin:/bin', COPYFILE_DISABLE: '1' },
        stdio: 'ignore',
      }),
    )
    const bytes = yield* Effect.promise(() => readFile(archive))
    lines.push(
      `${createHash('sha256').update(bytes).digest('hex')}  ${name}.tar.gz`,
    )
    if (fixture.tampered === true) {
      yield* Effect.promise(() =>
        writeFile(archive, Buffer.concat([bytes, Buffer.from('x')])),
      )
    }
  }
  const checksums = Buffer.from(`${lines.join('\n')}\n`)
  yield* Effect.promise(async () => {
    await writeFile(NodePath.join(root, 'checksums.txt'), checksums)
    await writeFile(
      NodePath.join(root, 'checksums.txt.sig'),
      sign(null, checksums, (fixture.key ?? releaseKey).privateKey),
    )
  })
  return root
})

const folderSource = (folder: string) =>
  DistributionSource.Folder({ folder, keys: [releaseKey.publicPem] })

/** Runs `effect` on the host's shell, with Node's fetch for the releases. */
const onHost =
  (shell: HostShell['Service']) =>
  <A, E>(effect: Effect.Effect<A, E, HostShell | HttpClient.HttpClient>) =>
    effect.pipe(
      Effect.provideService(HostShell, shell),
      Effect.provide(FetchHttpClient.layer),
    )

const readText = (path: string) =>
  Effect.promise(() => readFile(path, 'utf8').catch(() => ''))

const listed = (path: string) =>
  Effect.promise(() => readdir(path).catch((): ReadonlyArray<string> => []))

const enginesOf = (home: string) =>
  NodePath.join(home, '.local', 'share', 'fabrica', 'engine')

const linkOf = (home: string) => NodePath.join(home, '.local', 'bin', 'fabrica')

/** The releases folder served over HTTP on the loopback, laid out as GitHub serves them. */
const serveReleases = (root: string) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly url: string
      readonly asked: Array<string>
      readonly server: Server
    }>(resume => {
      const asked: Array<string> = []
      const server = createServer((request, response) => {
        const path = new URL(request.url ?? '/', 'http://fixture').pathname
        asked.push(path)
        readFile(NodePath.join(root, path))
          .then(bytes => response.writeHead(200).end(bytes))
          .catch(() => response.writeHead(404).end())
      })
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        const port =
          typeof address === 'object' && address !== null ? address.port : 0
        resume(
          Effect.succeed({ url: `http://127.0.0.1:${port}`, asked, server }),
        )
      })
    }),
    ({ server }) =>
      Effect.callback<void>(done => {
        server.close(() => done(Effect.void))
        // Node's fetch keeps its connections alive, which close would wait on.
        server.closeAllConnections()
      }),
  )

/** How long a test of the install has: each runs a dozen shells over the stub ssh, on a loaded machine. */
const shellTime = 30_000

layer(layerHosts)('the install over SSH', it => {
  it.effect(
    'a fresh install checks the host, places the engine, links fabrica and starts its service',
    () =>
      Effect.gen(function* () {
        const host = yield* stubHost(mac)
        const folder = yield* fixtureRelease({
          version: '0.1.0',
          targets: ['darwin-arm64', 'linux-x64'],
        })
        const run = onHost(host.shell)
        const check = yield* run(checkHost(folderSource(folder)))
        expect(check).toEqual({
          host: 'Darwin arm64, macOS 14.5',
          target: 'darwin-arm64',
          plan: InstallPlan.cases.Install.make({ to: '0.1.0' }),
          notes: [],
        })
        const installed = yield* run(
          installEngine({
            source: folderSource(folder),
            consent: InstallConsent.cases.Install.make({ to: '0.1.0' }),
          }),
        )
        const placed = NodePath.join(
          enginesOf(host.home),
          '0.1.0',
          'bin',
          'fabrica',
        )
        expect(installed).toEqual({
          version: '0.1.0',
          launcher: placed,
          service: `installed the launchd agent fabrica.engine: ${host.home}/Library/LaunchAgents/fabrica.engine.plist`,
        })
        expect(yield* Effect.promise(() => readlink(linkOf(host.home)))).toBe(
          placed,
        )
        // The install's own folder is gone: only the version is left.
        expect(yield* listed(enginesOf(host.home))).toEqual(['0.1.0'])
        expect(yield* readText(NodePath.join(host.home, 'ran'))).toBe(
          '0.1.0 --version\n0.1.0 service install\n',
        )
        // Every command went over ssh to the destination.
        expect(
          (yield* readText(host.log)).split('\n').filter(line => line !== ''),
        ).toSatisfy((lines: ReadonlyArray<string>) =>
          lines.every(line => line === 'me@server-1'),
        )
        // Checked again, the engine is the one offered.
        expect((yield* run(checkHost(folderSource(folder)))).plan).toEqual(
          InstallPlan.cases.Current.make({ version: '0.1.0' }),
        )
      }),
    shellTime,
  )

  it.effect(
    "an update takes the user's consent, stops the old engine, relinks and restarts through the service",
    () =>
      Effect.gen(function* () {
        const host = yield* stubHost(mac)
        const run = onHost(host.shell)
        const first = yield* fixtureRelease({
          version: '0.1.0',
          targets: ['darwin-arm64'],
        })
        yield* run(
          installEngine({
            source: folderSource(first),
            consent: InstallConsent.cases.Install.make({ to: '0.1.0' }),
          }),
        )
        const next = yield* fixtureRelease({
          version: '0.2.0',
          targets: ['darwin-arm64'],
        })
        const check = yield* run(checkHost(folderSource(next)))
        expect(check.plan).toEqual(
          InstallPlan.cases.Update.make({ from: '0.1.0', to: '0.2.0' }),
        )
        // Agreeing to an install of what isn't there any more is refused, and changes nothing.
        const stale = yield* run(
          installEngine({
            source: folderSource(next),
            consent: InstallConsent.cases.Install.make({ to: '0.2.0' }),
          }),
        ).pipe(Effect.flip)
        expect(stale).toEqual(
          InstallFailure.ConsentStale({
            consented: 'installing 0.2.0',
            found: 'updating 0.1.0 to 0.2.0',
          }),
        )
        expect(yield* listed(enginesOf(host.home))).toEqual(['0.1.0'])

        const before = yield* readText(NodePath.join(host.home, 'ran'))
        const installed = yield* run(
          installEngine({
            source: folderSource(next),
            consent: InstallConsent.cases.Update.make({
              from: '0.1.0',
              to: '0.2.0',
            }),
          }),
        )
        expect(installed.version).toBe('0.2.0')
        expect(yield* Effect.promise(() => readlink(linkOf(host.home)))).toBe(
          NodePath.join(enginesOf(host.home), '0.2.0', 'bin', 'fabrica'),
        )
        expect([...(yield* listed(enginesOf(host.home)))].sort()).toEqual([
          '0.1.0',
          '0.2.0',
        ])
        const ran = (yield* readText(NodePath.join(host.home, 'ran')))
          .slice(before.length)
          .split('\n')
        // The old engine is asked to wind down and stop before the service starts the new one.
        expect(ran.slice(-3)).toEqual([
          '0.1.0 engine stop',
          '0.2.0 service install',
          '',
        ])
      }),
    shellTime,
  )

  it.effect(
    "a release whose checksums.txt isn't signed by a release key is refused before the host is changed",
    () =>
      Effect.gen(function* () {
        const host = yield* stubHost(mac)
        const folder = yield* fixtureRelease({
          version: '0.1.0',
          targets: ['darwin-arm64'],
          key: strangerKey,
        })
        const run = onHost(host.shell)
        expect(
          yield* run(checkHost(folderSource(folder))).pipe(Effect.flip),
        ).toEqual(
          InstallFailure.Release({ failure: UpdateFailure.BadSignature() }),
        )
        expect(
          yield* run(
            installEngine({
              source: folderSource(folder),
              consent: InstallConsent.cases.Install.make({ to: '0.1.0' }),
            }),
          ).pipe(Effect.flip),
        ).toEqual(
          InstallFailure.Release({ failure: UpdateFailure.BadSignature() }),
        )
        expect(yield* listed(NodePath.join(host.home, '.local'))).toEqual([])
      }),
    shellTime,
  )

  it.effect(
    'a distribution with no engine for the host’s architecture is refused, naming what it has',
    () =>
      Effect.gen(function* () {
        const host = yield* stubHost({
          kernel: 'Linux',
          machine: 'aarch64',
          glibc: '2.39',
        })
        const folder = yield* fixtureRelease({
          version: '0.1.0',
          targets: ['darwin-arm64', 'linux-x64'],
        })
        const failure = yield* onHost(host.shell)(
          installEngine({
            source: folderSource(folder),
            consent: InstallConsent.cases.Install.make({ to: '0.1.0' }),
          }),
        ).pipe(Effect.flip)
        expect(failure).toEqual(
          InstallFailure.ArchitectureMismatch({
            target: 'linux-arm64',
            offered: ['darwin-arm64', 'linux-x64'],
          }),
        )
        expect(yield* listed(NodePath.join(host.home, '.local'))).toEqual([])
      }),
    shellTime,
  )

  it.effect(
    "an archive that isn't the one checksums.txt sums is refused on the host, and nothing is left there",
    () =>
      Effect.gen(function* () {
        const host = yield* stubHost(mac)
        const folder = yield* fixtureRelease({
          version: '0.1.0',
          targets: ['darwin-arm64'],
          tampered: true,
        })
        const failure = yield* onHost(host.shell)(
          installEngine({
            source: folderSource(folder),
            consent: InstallConsent.cases.Install.make({ to: '0.1.0' }),
          }),
        ).pipe(Effect.flip)
        expect(failure._tag).toBe('Release')
        expect(
          InstallFailure.$is('Release')(failure) &&
            UpdateFailure.$is('ChecksumMismatch')(failure.failure),
        ).toBe(true)
        expect(yield* listed(enginesOf(host.home))).toEqual([])
        expect(
          yield* listed(NodePath.join(host.home, '.local', 'bin')),
        ).toEqual([])
      }),
    shellTime,
  )

  it.effect(
    'from the releases, the host downloads the archive with its curl; without one, the app sends it',
    () =>
      Effect.gen(function* () {
        const root = yield* tempFolder('releases')
        const folder = NodePath.join(root, 'download', 'v0.1.0')
        yield* Effect.promise(() => mkdir(folder, { recursive: true }))
        yield* fixtureRelease(
          { version: '0.1.0', targets: ['darwin-arm64'] },
          folder,
        )
        const served = yield* serveReleases(root)
        const stage = yield* tempFolder('app')
        const source = DistributionSource.Releases({
          releases: served.url,
          keys: [releaseKey.publicPem],
          release: Option.some('0.1.0'),
          stage,
        })
        const consent = InstallConsent.cases.Install.make({ to: '0.1.0' })
        const archive = '/download/v0.1.0/fabrica-0.1.0-darwin-arm64.tar.gz'
        const hosts = yield* Hosts

        const curled = yield* stubHost(mac, hosts.withCurl)
        yield* onHost(curled.shell)(installEngine({ source, consent }))
        expect(yield* Effect.promise(() => readlink(linkOf(curled.home)))).toBe(
          NodePath.join(enginesOf(curled.home), '0.1.0', 'bin', 'fabrica'),
        )
        expect(served.asked.filter(path => path === archive)).toHaveLength(1)

        const bare = yield* stubHost(mac, hosts.bare)
        yield* onHost(bare.shell)(installEngine({ source, consent }))
        expect(yield* Effect.promise(() => readlink(linkOf(bare.home)))).toBe(
          NodePath.join(enginesOf(bare.home), '0.1.0', 'bin', 'fabrica'),
        )
        // The app downloaded it this time, and left nothing of it behind.
        expect(served.asked.filter(path => path === archive)).toHaveLength(2)
        expect(yield* listed(stage)).toEqual([])
      }),
    shellTime,
  )

  it.effect(
    "a host ssh can't sign in to fails the check, saying so",
    () =>
      Effect.gen(function* () {
        const host = yield* stubHost({ ...mac, sshRefuses: true })
        const folder = yield* fixtureRelease({
          version: '0.1.0',
          targets: ['darwin-arm64'],
        })
        const failure = yield* onHost(host.shell)(
          checkHost(folderSource(folder)),
        ).pipe(Effect.flip)
        expect(InstallFailure.$is('Unreachable')(failure)).toBe(true)
        expect(
          InstallFailure.$is('Unreachable')(failure) ? failure.reason : '',
        ).toContain('ssh could not sign in to me@server-1')
      }),
    shellTime,
  )
})

const facts = (overrides: Partial<HostFacts>): HostFacts => ({
  kernel: 'Linux',
  machine: 'x86_64',
  home: '/home/me',
  macos: Option.none(),
  translated: false,
  libc: Libc.Glibc({ version: '2.39' }),
  libatomic: Option.some(true),
  sse2: Option.some(true),
  downloader: 'curl',
  sha256: true,
  tar: true,
  engine: Option.none(),
  ...overrides,
})

const refusalOf = (host: HostFacts) =>
  Result.match(judgeHost(host), {
    onSuccess: () => Option.none<HostRefusal>(),
    onFailure: Option.some,
  })

describe('the check of a host', () => {
  it('runs the engine target of its system and CPU, the arm64 one under Rosetta', () => {
    expect(Result.map(judgeHost(facts({})), ({ target }) => target)).toEqual(
      Result.succeed('linux-x64'),
    )
    expect(
      Result.map(
        judgeHost(
          facts({
            kernel: 'Darwin',
            machine: 'x86_64',
            macos: Option.some('15.1'),
            translated: true,
            libc: Libc.Unknown(),
            libatomic: Option.none(),
          }),
        ),
        ({ target }) => target,
      ),
    ).toEqual(Result.succeed('darwin-arm64'))
    expect(ENGINE_TARGETS).toContain('darwin-arm64')
  })

  it("refuses a host the engine can't run on, saying why", () => {
    expect(refusalOf(facts({ machine: 'riscv64' }))).toEqual(
      Option.some(
        HostRefusal.NoTarget({ kernel: 'Linux', machine: 'riscv64' }),
      ),
    )
    expect(refusalOf(facts({ libc: Libc.Musl() }))).toEqual(
      Option.some(HostRefusal.Musl()),
    )
    expect(refusalOf(facts({ libc: Libc.Glibc({ version: '2.27' }) }))).toEqual(
      Option.some(HostRefusal.GlibcTooOld({ version: '2.27' })),
    )
    expect(refusalOf(facts({ libatomic: Option.some(false) }))).toEqual(
      Option.some(HostRefusal.NoLibatomic()),
    )
    expect(refusalOf(facts({ sse2: Option.some(false) }))).toEqual(
      Option.some(HostRefusal.CpuLacks({ component: 'Node', flag: 'sse2' })),
    )
    expect(
      refusalOf(
        facts({
          kernel: 'Darwin',
          machine: 'arm64',
          macos: Option.some('13.4'),
        }),
      ),
    ).toEqual(Option.some(HostRefusal.MacosTooOld({ version: '13.4' })))
    expect(refusalOf(facts({ tar: false }))).toEqual(
      Option.some(HostRefusal.NoTool({ tool: 'tar' })),
    )
  })

  it("notes what it couldn't tell, and goes on", () => {
    const judged = judgeHost(
      facts({ libc: Libc.Unknown(), sse2: Option.none() }),
    )
    expect(Result.map(judged, ({ notes }) => notes)).toEqual(
      Result.succeed([
        "Couldn't tell the glibc version, which must be 2.28 or later.",
        "Couldn't tell whether the CPU has SSE2, which Node needs.",
      ]),
    )
  })

  it("reads the engine's release from its --version, and nothing else", () => {
    expect(engineRelease('fabrica v0.3.1\n')).toEqual(Option.some('0.3.1'))
    expect(engineRelease('fabrica v0.3.1-rc.2')).toEqual(
      Option.some('0.3.1-rc.2'),
    )
    expect(engineRelease('tutti v0.3.1')).toEqual(Option.none())
    expect(engineRelease('')).toEqual(Option.none())
  })
})
