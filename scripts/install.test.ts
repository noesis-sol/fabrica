import { Effect, Result } from 'effect'
import { createHash, generateKeyPairSync } from 'node:crypto'
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  readlink,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, layer } from '@effect/vitest'

import {
  Toolbox,
  layerToolbox,
  runCommand,
  runCommandExit,
  shStub,
  tempFolder,
} from '../packages/testkit/src/index.ts'
import { signFile } from './sign-checksums'

// The install script (spec §9.2, §22.5) against a fixture release served from a folder: the host's
// checks (macOS's and glibc's floors, libatomic, the CPU against the native inventory's baselines, the
// arm64 build under Rosetta) with uname, sysctl, sw_vers, getconf and ldd stubbed; the signature and the
// archive's SHA-256; and the new fabrica's --version run where it is installed, its stdout alone read.

const script = join(import.meta.dirname, 'install.sh')

/** The stubs read what they answer from the variables the test sets: FAKE_*. */
const stubs = {
  uname: shStub(
    'case "$1" in -s) echo "$FAKE_KERNEL" ;; -m) echo "$FAKE_MACHINE" ;; *) exit 1 ;; esac',
  ),
  sysctl: shStub(
    '[ "$1" = -n ] && shift\n' +
      'name=$(printf %s "$1" | tr . _)\n' +
      'eval "value=\\${FAKE_SYSCTL_$name-}"\n' +
      '[ -n "$value" ] || exit 1\n' +
      'echo "$value"',
  ),
  sw_vers: shStub('[ -n "${FAKE_MACOS:-}" ] || exit 1\necho "$FAKE_MACOS"'),
  getconf: shStub(
    '[ -n "${FAKE_GLIBC:-}" ] || exit 1\necho "glibc $FAKE_GLIBC"',
  ),
  ldd: shStub(
    '[ -n "${FAKE_LDD:-}" ] || exit 1\necho "$FAKE_LDD"\nexit "${FAKE_LDD_EXIT:-0}"',
  ),
  // The archive's SHA-256, with the Node the test names where the PATH has none.
  sha256sum: shStub(
    'exec "${FAKE_NODE:-node}" -e \'const c = require("node:crypto"), f = require("node:fs")\n' +
      'for (const p of process.argv.slice(1)) console.log(c.createHash("sha256").update(f.readFileSync(p)).digest("hex") + "  " + p)\' "$@"',
  ),
  // OpenSSL 3, verifying with Node as `openssl pkeyutl -verify -pubin -inkey K -rawin -in F -sigfile S`
  // would, and saying what it was asked in FAKE_OPENSSL_ASKED.
  'openssl-3': shStub(
    'case "$1" in version) echo "OpenSSL 3.5.0 1 Jul 2025"; exit 0 ;; esac\n' +
      'echo "$*" >> "$FAKE_OPENSSL_ASKED"\n' +
      'while [ $# -gt 0 ]; do case "$1" in -inkey) key=$2 ;; -in) data=$2 ;; -sigfile) sig=$2 ;; esac; shift; done\n' +
      'exec node -e \'const c = require("node:crypto"), f = require("node:fs")\n' +
      'const [d, k, s] = process.argv.slice(1).map(p => f.readFileSync(p))\n' +
      'process.exit(c.verify(null, d, c.createPublicKey(k), s) ? 0 : 1)\' "$data" "$key" "$sig"',
  ),
  // macOS's own openssl, which can't verify ed25519.
  libressl: shStub(
    'case "$1" in version) echo "LibreSSL 3.3.6"; exit 0 ;; esac\nexit 1',
  ),
}

const tools = [
  'sh',
  'curl',
  'tar',
  'gzip',
  'awk',
  'sed',
  'grep',
  'cat',
  'mkdir',
  'rm',
  'mv',
  'ln',
  'tr',
  'tail',
  'node',
]

type Target = 'darwin-x64' | 'darwin-arm64' | 'linux-x64' | 'linux-arm64'

/** The fixture's `fabrica`: says where it ran, warns on stderr, and prints its version. */
const launcher = (said: string, exit = 0) =>
  shStub(
    'printf \'%s\\n\' "$0" >> "$FIXTURE_RAN"\n' +
      'echo "a warning on stderr" >&2\n' +
      `echo '${said}'\nexit ${exit}`,
  )

interface ReleaseSpec {
  readonly tag: string
  readonly targets: ReadonlyArray<Target>
  /** The fixture's fabrica, by default printing `fabrica <tag>`. */
  readonly launcher?: string
  /** An archive whose bytes aren't those checksums.txt has. */
  readonly tampered?: boolean
}

const keyPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}

const releaseKey = keyPair()

/**
 * A folder laid out as GitHub serves releases: `latest` holding the latest tag, and each release's
 * archives, checksums.txt and checksums.txt.sig under download/<tag>/, signed with `key`.
 */
const fixtureReleases = Effect.fn(function* (
  specs: ReadonlyArray<ReleaseSpec>,
  key = releaseKey,
) {
  const toolbox = yield* Toolbox
  const root = yield* tempFolder('releases')
  for (const spec of specs) {
    const version = spec.tag.slice(1)
    const folder = join(root, 'download', spec.tag)
    const stage = join(root, 'stage', spec.tag)
    yield* Effect.promise(() => mkdir(folder, { recursive: true }))
    const sums: Array<string> = []
    for (const target of spec.targets) {
      const name = `fabrica-${version}-${target}`
      const bin = join(stage, name, 'bin')
      yield* Effect.promise(async () => {
        await mkdir(bin, { recursive: true })
        await writeFile(
          join(bin, 'fabrica'),
          spec.launcher ?? launcher(`fabrica ${spec.tag}`),
        )
        await chmod(join(bin, 'fabrica'), 0o755)
      })
      const archive = join(folder, `${name}.tar.gz`)
      yield* runCommand({
        command: 'tar',
        args: ['-czf', archive, '-C', stage, name],
        cwd: root,
        env: toolbox.env({ COPYFILE_DISABLE: '1' }),
      })
      const bytes = yield* Effect.promise(() => readFile(archive))
      sums.push(
        `${createHash('sha256').update(bytes).digest('hex')}  ${name}.tar.gz\n`,
      )
      if (spec.tampered === true)
        yield* Effect.promise(() =>
          writeFile(archive, Buffer.concat([bytes, Buffer.from('x')])),
        )
    }
    const checksums = join(folder, 'checksums.txt')
    yield* Effect.promise(() => writeFile(checksums, sums.join('')))
    const signed = signFile({
      file: checksums,
      pem: key.privatePem,
      releaseKeys: [key.publicPem],
    })
    expect(Result.isSuccess(signed)).toBe(true)
  }
  yield* Effect.promise(() =>
    writeFile(join(root, 'latest'), `${specs.at(-1)?.tag ?? ''}\n`),
  )
  return root
})

/** The hosts the stubs play. */
const hosts = {
  'linux-x64': {
    FAKE_KERNEL: 'Linux',
    FAKE_MACHINE: 'x86_64',
    FAKE_GLIBC: '2.39',
  },
  'linux-arm64': {
    FAKE_KERNEL: 'Linux',
    FAKE_MACHINE: 'aarch64',
    FAKE_GLIBC: '2.28',
  },
  'darwin-x64': {
    FAKE_KERNEL: 'Darwin',
    FAKE_MACHINE: 'x86_64',
    FAKE_MACOS: '15.1',
    FAKE_SYSCTL_hw_optional_sse2: '1',
  },
  'darwin-arm64': {
    FAKE_KERNEL: 'Darwin',
    FAKE_MACHINE: 'arm64',
    FAKE_MACOS: '26.0.1',
  },
} as const

const x64Flags =
  'fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 ht syscall nx lm'

/** A host of the test's: its home, its /proc/cpuinfo, and a library folder holding libatomic.so.1. */
const makeHost = Effect.fn(function* (
  options: {
    readonly cpuFlags?: string
    readonly libatomic?: boolean
  } = {},
) {
  const root = yield* tempFolder('host')
  const home = join(root, 'home')
  const lib = join(root, 'lib')
  const cpuinfo = join(root, 'cpuinfo')
  const ran = join(root, 'ran')
  yield* Effect.promise(async () => {
    await mkdir(home)
    await mkdir(lib)
    await writeFile(ran, '')
    await writeFile(
      cpuinfo,
      `processor\t: 0\nflags\t\t: ${options.cpuFlags ?? x64Flags}\n\nprocessor\t: 1\nflags\t\t: ${options.cpuFlags ?? x64Flags}\n`,
    )
    if (options.libatomic !== false)
      await writeFile(join(lib, 'libatomic.so.1'), '')
  })
  return { root, home, lib, cpuinfo, ran }
})

type Host = Effect.Success<ReturnType<typeof makeHost>>

const engineFolder = (host: Host) =>
  join(host.home, '.local', 'share', 'fabrica', 'engine')

layer(layerToolbox({ tools, stubs }))('the install script', it => {
  /** Runs the install script (or `path`) on `host`, as `machine`, from the fixture releases. */
  const install = ({
    host,
    releases,
    machine,
    vars = {},
    path = script,
  }: {
    readonly host: Host
    readonly releases: string
    readonly machine: Readonly<Record<string, string>>
    readonly vars?: Readonly<Record<string, string>>
    readonly path?: string
  }) =>
    Effect.gen(function* () {
      const toolbox = yield* Toolbox
      return yield* runCommandExit({
        command: 'sh',
        args: [path],
        cwd: host.root,
        env: toolbox.env({
          HOME: host.home,
          FIXTURE_RAN: host.ran,
          FABRICA_DOWNLOAD_URL: `file://${releases}`,
          FABRICA_TEST_RELEASE_KEY: releaseKey.publicPem,
          FABRICA_TEST_CPUINFO: host.cpuinfo,
          FABRICA_TEST_LIB_DIRS: host.lib,
          FABRICA_TEST_OPENSSL: '',
          ...machine,
          ...vars,
        }),
      })
    })

  const ranAt = (host: Host) =>
    Effect.promise(() => readFile(host.ran, 'utf8')).pipe(
      Effect.map(text => text.split('\n').filter(line => line !== '')),
    )

  const linked = (host: Host, dir = join(host.home, '.local', 'bin')) =>
    Effect.promise(() => readlink(join(dir, 'fabrica')))

  const nothingInstalled = (host: Host) =>
    Effect.gen(function* () {
      const bin = yield* Effect.promise(() =>
        readdir(join(host.home, '.local', 'bin')).catch(() => []),
      )
      const engines = yield* Effect.promise(() =>
        readdir(engineFolder(host)).catch(() => []),
      )
      expect(bin).toEqual([])
      expect(engines).toEqual([])
    })

  describe('installs', () => {
    it.effect(
      'the latest release under ~/.local/share/fabrica/engine, linked from ~/.local/bin',
      () =>
        Effect.gen(function* () {
          const host = yield* makeHost()
          const releases = yield* fixtureReleases([
            { tag: 'v0.1.0', targets: ['linux-x64', 'linux-arm64'] },
          ])
          const ran = yield* install({
            host,
            releases,
            machine: hosts['linux-x64'],
          })
          expect(ran.stderr).toBe('')
          expect(ran.code).toBe(0)
          const engine = join(engineFolder(host), '0.1.0')
          expect(yield* linked(host)).toBe(join(engine, 'bin', 'fabrica'))
          expect(ran.stdout).toContain(
            'Verified the signature of checksums.txt with the release key.',
          )
          expect(ran.stdout).toContain(
            `Installed the Fabrica engine v0.1.0 in ${engine}, linked from ${join(host.home, '.local', 'bin', 'fabrica')}.`,
          )
          expect(ran.stdout).toContain(
            `${join(host.home, '.local', 'bin')} isn't on your PATH. To add it:`,
          )
          // Its --version ran in the engine's own folder, not in /tmp, and nothing is left beside it.
          const [first, ...others] = yield* ranAt(host)
          expect(others).toEqual([])
          expect(first?.startsWith(`${engineFolder(host)}/.install-`)).toBe(
            true,
          )
          expect(
            yield* Effect.promise(() => readdir(engineFolder(host))),
          ).toEqual(['0.1.0'])
        }),
    )

    // fabrica engine update switches ~/.local/bin/fabrica and the login service runs it (§7.1, §9.2), so
    // FABRICA_INSTALL_DIR's link names that link, never the engine, and follows each update.
    it.effect(
      'the release FABRICA_VERSION names, linked from ~/.local/bin and from FABRICA_INSTALL_DIR to that',
      () =>
        Effect.gen(function* () {
          const host = yield* makeHost()
          const releases = yield* fixtureReleases([
            { tag: 'v0.1.0-rc.1', targets: ['linux-arm64'] },
            { tag: 'v0.2.0', targets: ['linux-arm64'] },
          ])
          const dir = join(host.root, 'bin')
          const bin = join(host.home, '.local', 'bin')
          // An earlier script's link straight to an engine is replaced.
          yield* Effect.promise(async () => {
            await mkdir(dir)
            await symlink(join(host.root, 'old-engine'), join(dir, 'fabrica'))
          })
          const ran = yield* install({
            host,
            releases,
            machine: hosts['linux-arm64'],
            vars: { FABRICA_VERSION: '0.1.0-rc.1', FABRICA_INSTALL_DIR: dir },
          })
          expect(ran.stderr).toBe('')
          expect(ran.code).toBe(0)
          expect(yield* linked(host)).toBe(
            join(engineFolder(host), '0.1.0-rc.1', 'bin', 'fabrica'),
          )
          expect(yield* linked(host, dir)).toBe(join(bin, 'fabrica'))
          expect(ran.stdout).toContain(
            `Linked ${join(dir, 'fabrica')} to ${join(bin, 'fabrica')}, which fabrica engine update switches to later releases.`,
          )
          expect(ran.stdout).toContain(`${dir} isn't on your PATH. To add it:`)
          expect(ran.stdout).not.toContain(`${bin} isn't on your PATH`)
          expect(yield* Effect.promise(() => readdir(dir))).toEqual(['fabrica'])
          expect(yield* Effect.promise(() => readdir(bin))).toEqual(['fabrica'])
        }),
    )

    it.effect(
      'with FABRICA_INSTALL_DIR naming ~/.local/bin another way, one link alone',
      () =>
        Effect.gen(function* () {
          const host = yield* makeHost()
          const releases = yield* fixtureReleases([
            { tag: 'v0.1.0', targets: ['linux-x64'] },
          ])
          const ran = yield* install({
            host,
            releases,
            machine: hosts['linux-x64'],
            vars: {
              FABRICA_INSTALL_DIR:
                join(host.home, '.local', 'share', '..', 'bin') + '/',
            },
          })
          expect(ran.stderr).toBe('')
          expect(ran.code).toBe(0)
          expect(yield* linked(host)).toBe(
            join(engineFolder(host), '0.1.0', 'bin', 'fabrica'),
          )
          expect(ran.stdout).not.toContain('Linked ')
          expect(
            yield* Effect.promise(() =>
              readdir(join(host.home, '.local', 'bin')),
            ),
          ).toEqual(['fabrica'])
        }),
    )

    it.effect('again over an earlier install, switching the link', () =>
      Effect.gen(function* () {
        const host = yield* makeHost()
        const releases = yield* fixtureReleases([
          { tag: 'v0.1.0', targets: ['linux-x64'] },
          { tag: 'v0.2.0', targets: ['linux-x64'] },
        ])
        const toolbox = yield* Toolbox
        const dir = join(host.home, '.local', 'bin')
        const onPath = { PATH: `${toolbox.bin}:${dir}` }
        const machine = hosts['linux-x64']
        const first = yield* install({
          host,
          releases,
          machine,
          vars: { ...onPath, FABRICA_VERSION: 'v0.1.0' },
        })
        expect(first.code).toBe(0)
        const second = yield* install({ host, releases, machine, vars: onPath })
        expect(second.code).toBe(0)
        expect(second.stdout).not.toContain('PATH')
        expect(yield* linked(host)).toBe(
          join(engineFolder(host), '0.2.0', 'bin', 'fabrica'),
        )
        const again = yield* install({ host, releases, machine, vars: onPath })
        expect(again.code).toBe(0)
        expect(
          (yield* Effect.promise(() => readdir(engineFolder(host)))).toSorted(),
        ).toEqual(['0.1.0', '0.2.0'])
      }),
    )

    it.effect('the arm64 build in a shell under Rosetta', () =>
      Effect.gen(function* () {
        const host = yield* makeHost()
        const releases = yield* fixtureReleases([
          { tag: 'v0.1.0', targets: ['darwin-arm64'] },
        ])
        const ran = yield* install({
          host,
          releases,
          machine: {
            ...hosts['darwin-x64'],
            FAKE_MACOS: '13.5',
            FAKE_SYSCTL_sysctl_proc_translated: '1',
            FAKE_SYSCTL_hw_optional_sse2: '',
          },
        })
        expect(ran.stderr).toBe('')
        expect(ran.code).toBe(0)
        expect(ran.stdout).toContain(
          'This shell runs under Rosetta on Apple Silicon: installing the darwin arm64 build, which runs natively.',
        )
        expect(ran.stdout).not.toContain("Couldn't tell")
        expect(ran.stdout).toContain('for darwin-arm64.')
        expect(yield* linked(host)).toBe(
          join(engineFolder(host), '0.1.0', 'bin', 'fabrica'),
        )
      }),
    )

    it.effect('the x64 build on an Intel Mac with SSE2', () =>
      Effect.gen(function* () {
        const host = yield* makeHost()
        const releases = yield* fixtureReleases([
          { tag: 'v0.1.0', targets: ['darwin-x64', 'darwin-arm64'] },
        ])
        const ran = yield* install({
          host,
          releases,
          machine: {
            ...hosts['darwin-x64'],
            FAKE_SYSCTL_sysctl_proc_translated: '0',
          },
        })
        expect(ran.code).toBe(0)
        expect(ran.stdout).toContain('for darwin-x64.')
        expect(ran.stdout).not.toContain('Rosetta')
      }),
    )

    it.effect("where the CPU's flags can't be read, saying so", () =>
      Effect.gen(function* () {
        const host = yield* makeHost()
        const releases = yield* fixtureReleases([
          { tag: 'v0.1.0', targets: ['linux-x64'] },
        ])
        const ran = yield* install({
          host,
          releases,
          machine: hosts['linux-x64'],
          vars: { FABRICA_TEST_CPUINFO: join(host.root, 'missing') },
        })
        expect(ran.code).toBe(0)
        expect(ran.stdout).toContain(
          "Couldn't tell whether this CPU has sse2, which Node needs; installing all the same.",
        )
      }),
    )
  })

  describe('refuses, installing nothing,', () => {
    it.effect('an x64 CPU without what the native inventory needs', () =>
      Effect.gen(function* () {
        const host = yield* makeHost({ cpuFlags: 'fpu vme de pse tsc mmx' })
        const releases = yield* fixtureReleases([
          { tag: 'v0.1.0', targets: ['linux-x64', 'darwin-x64'] },
        ])
        const linux = yield* install({
          host,
          releases,
          machine: hosts['linux-x64'],
        })
        expect(linux).toMatchObject({
          code: 1,
          stderr:
            'fabrica install: Node, in the engine, needs an x64 CPU with SSE2, and this one has none. Nothing was installed.\n',
        })
        const mac = yield* install({
          host,
          releases,
          machine: {
            ...hosts['darwin-x64'],
            FAKE_SYSCTL_hw_optional_sse2: '0',
          },
        })
        expect(mac.code).toBe(1)
        expect(mac.stderr).toContain('needs an x64 CPU with SSE2')
        yield* nothingInstalled(host)
        expect(yield* ranAt(host)).toEqual([])
      }),
    )

    it.effect("a host below the engine's floors", () =>
      Effect.gen(function* () {
        const host = yield* makeHost()
        const releases = yield* fixtureReleases([
          { tag: 'v0.1.0', targets: ['linux-x64', 'darwin-arm64'] },
        ])
        const refused = (
          machine: Readonly<Record<string, string>>,
          vars: Readonly<Record<string, string>> = {},
        ) =>
          install({ host, releases, machine, vars }).pipe(
            Effect.map(({ code, stderr }) => ({ code, stderr })),
          )
        expect(
          yield* refused({ ...hosts['darwin-arm64'], FAKE_MACOS: '13.4.1' }),
        ).toEqual({
          code: 1,
          stderr:
            'fabrica install: the engine needs macOS 13.5 or later, and this is macOS 13.4.1. Nothing was installed.\n',
        })
        expect(
          yield* refused({ ...hosts['linux-x64'], FAKE_GLIBC: '2.27' }),
        ).toEqual({
          code: 1,
          stderr:
            'fabrica install: the engine needs glibc 2.28 or later, and this system has glibc 2.27. Nothing was installed.\n',
        })
        const musl = yield* refused({
          ...hosts['linux-x64'],
          FAKE_GLIBC: '',
          FAKE_LDD: 'musl libc (x86_64)',
          FAKE_LDD_EXIT: '1',
        })
        expect(musl.code).toBe(1)
        expect(musl.stderr).toContain("this system's C library is musl")
        const glibcByLdd = yield* install({
          host: yield* makeHost({ libatomic: false }),
          releases,
          machine: {
            ...hosts['linux-x64'],
            FAKE_GLIBC: '',
            FAKE_LDD: 'ldd (Ubuntu GLIBC 2.39-0ubuntu8) 2.39',
          },
        })
        expect(glibcByLdd.code).toBe(1)
        expect(glibcByLdd.stderr).toContain(
          "the engine's Node needs libatomic.so.1, which isn't installed",
        )
        yield* nothingInstalled(host)
      }),
    )

    it.effect('a checksums.txt whose signature is not a release key’s', () =>
      Effect.gen(function* () {
        const host = yield* makeHost()
        const releases = yield* fixtureReleases(
          [{ tag: 'v0.1.0', targets: ['linux-x64'] }],
          keyPair(),
        )
        const ran = yield* install({
          host,
          releases,
          machine: hosts['linux-x64'],
        })
        expect(ran.code).toBe(1)
        expect(ran.stderr).toContain(
          "checksums.txt.sig doesn't verify checksums.txt with a release key",
        )
        yield* nothingInstalled(host)
      }),
    )

    it.effect('an archive whose SHA-256 is not checksums.txt’s', () =>
      Effect.gen(function* () {
        const host = yield* makeHost()
        const releases = yield* fixtureReleases([
          { tag: 'v0.1.0', targets: ['linux-x64'], tampered: true },
        ])
        const ran = yield* install({
          host,
          releases,
          machine: hosts['linux-x64'],
        })
        expect(ran.code).toBe(1)
        expect(ran.stderr).toMatch(
          /fabrica-0\.1\.0-linux-x64\.tar\.gz's SHA-256 is [0-9a-f]{64}, not checksums\.txt's [0-9a-f]{64}\. Nothing was installed\./,
        )
        yield* nothingInstalled(host)
      }),
    )

    it.effect('a release without an engine for the host', () =>
      Effect.gen(function* () {
        const host = yield* makeHost()
        const releases = yield* fixtureReleases([
          { tag: 'v0.1.0', targets: ['linux-arm64'] },
        ])
        const ran = yield* install({
          host,
          releases,
          machine: hosts['linux-x64'],
        })
        expect(ran.code).toBe(1)
        expect(ran.stderr).toContain(
          'checksums.txt has no sum for fabrica-0.1.0-linux-x64.tar.gz: release v0.1.0 has no engine for linux-x64',
        )
      }),
    )

    it.effect(
      "an engine whose --version isn't the release's, keeping the earlier one",
      () =>
        Effect.gen(function* () {
          const host = yield* makeHost()
          const machine = hosts['linux-x64']
          const good = yield* fixtureReleases([
            { tag: 'v0.1.0', targets: ['linux-x64'] },
          ])
          expect((yield* install({ host, releases: good, machine })).code).toBe(
            0,
          )
          const wrong = yield* fixtureReleases([
            {
              tag: 'v0.2.0',
              targets: ['linux-x64'],
              launcher: launcher('fabrica v9.9.9'),
            },
          ])
          const said = yield* install({ host, releases: wrong, machine })
          expect(said.code).toBe(1)
          expect(said.stderr).toBe(
            "fabrica install: the new engine's fabrica --version says 'fabrica v9.9.9', not fabrica v0.2.0\n",
          )
          const broken = yield* fixtureReleases([
            {
              tag: 'v0.2.0',
              targets: ['linux-x64'],
              launcher: launcher('', 3),
            },
          ])
          const failed = yield* install({ host, releases: broken, machine })
          expect(failed.stderr).toBe(
            "fabrica install: the new engine doesn't run: it exited 3: a warning on stderr\n",
          )
          expect(yield* linked(host)).toBe(
            join(engineFolder(host), '0.1.0', 'bin', 'fabrica'),
          )
          expect(
            yield* Effect.promise(() => readdir(engineFolder(host))),
          ).toEqual(['0.1.0'])
        }),
    )

    it.effect('everything while the script holds no release key', () =>
      Effect.gen(function* () {
        const host = yield* makeHost()
        const text = yield* Effect.promise(() => readFile(script, 'utf8'))
        const keyless = join(host.root, 'install.sh')
        yield* Effect.promise(() =>
          writeFile(
            keyless,
            text.replace(/^release_keys='[^']*'$/m, () => "release_keys=''"),
          ),
        )
        const ran = yield* install({
          host,
          releases: host.root,
          machine: hosts['linux-x64'],
          vars: { FABRICA_DOWNLOAD_URL: '', FABRICA_TEST_RELEASE_KEY: '' },
          path: keyless,
        })
        expect(ran).toEqual({
          code: 1,
          stdout: '',
          stderr:
            "fabrica install: this install script holds no release key yet, so it can't tell a release made by Fabrica's\nrelease workflow from another. Nothing was installed.\n",
        })
      }),
    )
  })

  describe('verifies the signature', () => {
    it.effect('with OpenSSL 3, passing over LibreSSL', () =>
      Effect.gen(function* () {
        const host = yield* makeHost()
        const asked = join(host.root, 'asked')
        const releases = yield* fixtureReleases([
          { tag: 'v0.1.0', targets: ['linux-x64'] },
        ])
        const ran = yield* install({
          host,
          releases,
          machine: hosts['linux-x64'],
          vars: {
            FABRICA_TEST_OPENSSL: 'missing-openssl libressl openssl-3',
            FAKE_OPENSSL_ASKED: asked,
          },
        })
        expect(ran.code).toBe(0)
        expect(ran.stdout).toContain(
          'Verified the signature of checksums.txt with the release key.',
        )
        const said = yield* Effect.promise(() => readFile(asked, 'utf8'))
        expect(said).toMatch(
          /^pkeyutl -verify -pubin -inkey \S+\/key1\.pem -rawin -in \S+\/checksums\.txt -sigfile \S+\/checksums\.txt\.sig\n$/,
        )
      }),
    )

    it.effect('with OpenSSL 3, refusing a bad signature', () =>
      Effect.gen(function* () {
        const host = yield* makeHost()
        const releases = yield* fixtureReleases(
          [{ tag: 'v0.1.0', targets: ['linux-x64'] }],
          keyPair(),
        )
        const ran = yield* install({
          host,
          releases,
          machine: hosts['linux-x64'],
          vars: {
            FABRICA_TEST_OPENSSL: 'openssl-3',
            FAKE_OPENSSL_ASKED: join(host.root, 'asked'),
          },
        })
        expect(ran.code).toBe(1)
        expect(ran.stderr).toContain("checksums.txt.sig doesn't verify")
      }),
    )

    it.effect(
      "or says it wasn't checked, with neither OpenSSL 3 nor Node",
      () =>
        Effect.gen(function* () {
          const toolbox = yield* Toolbox
          const host = yield* makeHost()
          const releases = yield* fixtureReleases([
            { tag: 'v0.1.0', targets: ['linux-x64'] },
          ])
          // The toolbox without Node; the fake sha256sum is given it by its path.
          const bin = join(host.root, 'bin-without-node')
          yield* Effect.promise(async () => {
            await mkdir(bin)
            for (const name of await readdir(toolbox.bin))
              if (name !== 'node')
                await symlink(join(toolbox.bin, name), join(bin, name))
          })
          const ran = yield* install({
            host,
            releases,
            machine: hosts['linux-x64'],
            vars: {
              PATH: bin,
              FABRICA_TEST_OPENSSL: 'libressl',
              FAKE_NODE: join(toolbox.bin, 'node'),
            },
          })
          expect(ran.code).toBe(0)
          expect(ran.stdout).toContain(
            "The signature of checksums.txt wasn't checked: that needs OpenSSL 3 or later, or Node, and neither",
          )
        }),
    )
  })
})
