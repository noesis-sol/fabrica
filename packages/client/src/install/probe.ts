import { Data, Option, Result, Schema } from 'effect'

import { ReleaseVersion } from '@fabrica/contracts'
import {
  type EngineTarget,
  targetOf,
  versionLine,
} from '@fabrica/engine/update'

import { HostRefusal } from './failure'

// The check of a host before an engine is installed there (spec §9.2, §22.4): one script, run on the
// host, saying what it is (its system and CPU, macOS's version or the C library, libatomic.so.1, the
// tools the install runs) and the engine `~/.local/bin/fabrica` is there, by its `--version`, stdout
// alone read; then the host judged by the floors the install script holds it to (scripts/install.sh):
// macOS 13.5 or later, glibc 2.28 or later with libatomic.so.1, and an x64 CPU with SSE2. Under Rosetta
// on Apple Silicon the darwin arm64 engine is the one, as it runs natively. What the script can't tell
// is noted and the install goes on, as the install script does.

/**
 * The probe. Each fact is one `name=value` line; a value is its command's first line. It runs no
 * command that reads its stdin, which carries the script itself.
 */
export const probeScript = String.raw`set -u
say() { printf '%s=%s\n' "$1" "$(printf '%s\n' "$2" | head -n 1 | tr -d '\r')"; }
found() { command -v "$1" >/dev/null 2>&1; }
kernel="$(uname -s 2>/dev/null </dev/null || true)"
machine="$(uname -m 2>/dev/null </dev/null || true)"
say kernel "$kernel"
say machine "$machine"
say home "$HOME"
case "$kernel" in
Darwin)
  say macos "$(sw_vers -productVersion 2>/dev/null </dev/null || /usr/bin/sw_vers -productVersion 2>/dev/null </dev/null || true)"
  sysctl=sysctl
  found sysctl || sysctl=/usr/sbin/sysctl
  say translated "$("$sysctl" -n sysctl.proc_translated 2>/dev/null </dev/null || true)"
  say sse2 "$("$sysctl" -n hw.optional.sse2 2>/dev/null </dev/null || true)"
  ;;
Linux)
  libc="$(getconf GNU_LIBC_VERSION 2>/dev/null </dev/null || true)"
  case "$libc" in
  "glibc "[0-9]*) say glibc "$(printf '%s\n' "$libc" | sed 's/^glibc //')" ;;
  *)
    said="$(ldd --version 2>&1 </dev/null || true)"
    case "$said" in
    *musl*) say libc musl ;;
    *"GNU libc"* | *GLIBC* | *glibc*) say glibc "$(printf '%s\n' "$said" | awk 'NR == 1 { print $NF }')" ;;
    esac
    ;;
  esac
  atomic=no
  for ldconfig in ldconfig /sbin/ldconfig /usr/sbin/ldconfig; do
    if found "$ldconfig" && "$ldconfig" -p 2>/dev/null </dev/null | grep -q 'libatomic\.so\.1 '; then
      atomic=yes
      break
    fi
  done
  if [ "$atomic" = no ]; then
    for folder in /lib /lib64 /usr/lib /usr/lib64 "/lib/$machine-linux-gnu" "/usr/lib/$machine-linux-gnu"; do
      [ ! -e "$folder/libatomic.so.1" ] || atomic=yes
    done
  fi
  say libatomic "$atomic"
  if [ -r /proc/cpuinfo ]; then
    say sse2 "$(awk '/^flags[ \t]*:/ { flags = 1; for (i = 1; i <= NF; i++) if ($i == "sse2") hit = 1 }
      END { if (hit) print 1; else if (flags) print 0 }' /proc/cpuinfo 2>/dev/null </dev/null || true)"
  fi
  ;;
esac
if found curl; then say downloader curl; elif found wget; then say downloader wget; else say downloader none; fi
if found sha256sum; then say sha256 sha256sum; elif found shasum; then say sha256 shasum; else say sha256 none; fi
if found tar; then say tar yes; else say tar no; fi
link="$HOME/.local/bin/fabrica"
if [ -x "$link" ]; then say engine "$("$link" --version 2>/dev/null </dev/null || true)"; fi
`

/** The host's C library, on Linux. */
export type Libc = Data.TaggedEnum<{
  Glibc: { readonly version: string }
  Musl: {}
  Unknown: {}
}>
export const Libc = Data.taggedEnum<Libc>()

/** How the host downloads a file: with curl, with wget, or not at all. */
export const Downloader = Schema.Literals(['curl', 'wget', 'none'])
export type Downloader = typeof Downloader.Type

/** What the probe found on the host. */
export interface HostFacts {
  /** `uname -s`'s and `uname -m`'s words. */
  readonly kernel: string
  readonly machine: string
  /** The home folder the engine is installed under. */
  readonly home: string
  /** macOS's version, where the host is a Mac and said it. */
  readonly macos: Option.Option<string>
  /** Whether the probe ran under Rosetta on Apple Silicon. */
  readonly translated: boolean
  readonly libc: Libc
  /** Whether libatomic.so.1 is there, on Linux. */
  readonly libatomic: Option.Option<boolean>
  /** Whether the CPU has SSE2, where the host could tell. */
  readonly sse2: Option.Option<boolean>
  readonly downloader: Downloader
  /** Whether the host has sha256sum or shasum, and tar. */
  readonly sha256: boolean
  readonly tar: boolean
  /** What `~/.local/bin/fabrica --version` printed, where there is one. */
  readonly engine: Option.Option<string>
}

const decodeDownloader = Schema.decodeUnknownOption(Downloader)
const decodeRelease = Schema.decodeUnknownOption(ReleaseVersion)

/** The probe's `name=value` lines as facts; none where the script didn't run to its end. */
export const parseProbe = (stdout: string): Option.Option<HostFacts> => {
  const lines = new Map(
    stdout.split('\n').flatMap(line => {
      const equals = line.indexOf('=')
      return equals <= 0
        ? []
        : [[line.slice(0, equals), line.slice(equals + 1)] as const]
    }),
  )
  const fact = (name: string): Option.Option<string> =>
    Option.filter(
      Option.fromUndefinedOr(lines.get(name)),
      value => value !== '',
    )
  const flag = (name: string): Option.Option<boolean> =>
    Option.flatMap(fact(name), value =>
      value === '1' || value === 'yes'
        ? Option.some(true)
        : value === '0' || value === 'no'
          ? Option.some(false)
          : Option.none(),
    )
  return Option.map(
    Option.all({
      kernel: fact('kernel'),
      machine: fact('machine'),
      home: fact('home'),
      downloader: Option.flatMap(fact('downloader'), decodeDownloader),
      sha256: fact('sha256'),
      tar: flag('tar'),
    }),
    found => ({
      kernel: found.kernel,
      machine: found.machine,
      home: found.home,
      macos: fact('macos'),
      translated: Option.contains(flag('translated'), true),
      libc: Option.match(fact('glibc'), {
        onSome: version => Libc.Glibc({ version }),
        onNone: () =>
          Option.contains(fact('libc'), 'musl') ? Libc.Musl() : Libc.Unknown(),
      }),
      libatomic: flag('libatomic'),
      sse2: flag('sse2'),
      downloader: found.downloader,
      sha256: found.sha256 !== 'none',
      tar: found.tar,
      engine: fact('engine'),
    }),
  )
}

/** Whether the dotted version `have` (such as 13.5.2) is `want` (such as 13.5) or later. */
export const atLeast = (have: string, want: string): boolean => {
  const left = have.split('.').map(Number)
  const right = want.split('.').map(Number)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const order = (left[i] ?? 0) - (right[i] ?? 0)
    if (order !== 0) return order > 0
  }
  return true
}

const numbered = /^\d+(?:\.\d+)*$/u

/** The engine's floors (spec §4, §22.4), as the install script has them. */
const MACOS_FLOOR = '13.5'
const GLIBC_FLOOR = '2.28'

/** The host judged: the engine target it runs, and what couldn't be told; or why it can't run one. */
export interface Judged {
  readonly target: EngineTarget
  /** The host's system, in words. */
  readonly description: string
  readonly notes: ReadonlyArray<string>
}

/** The engine target the host runs, from `uname`'s words, or none. */
const platformOf = (facts: HostFacts) => {
  const platform =
    facts.kernel === 'Darwin'
      ? 'darwin'
      : facts.kernel === 'Linux'
        ? 'linux'
        : facts.kernel
  const machine =
    facts.machine === 'x86_64' || facts.machine === 'amd64'
      ? 'x64'
      : facts.machine === 'aarch64'
        ? 'arm64'
        : facts.machine
  // Under Rosetta the arm64 build, which runs natively.
  const arch =
    platform === 'darwin' && machine === 'x64' && facts.translated
      ? 'arm64'
      : machine
  return targetOf({ platform, arch })
}

/** Judges the host the probe found. */
export const judgeHost = (
  facts: HostFacts,
): Result.Result<Judged, HostRefusal> => {
  const notes: Array<string> = []
  const refuse = (refusal: HostRefusal) => Result.fail(refusal)
  const target = platformOf(facts)
  if (Option.isNone(target)) {
    return refuse(
      HostRefusal.NoTarget({ kernel: facts.kernel, machine: facts.machine }),
    )
  }
  let description = `${facts.kernel} ${facts.machine}`
  if (target.value.startsWith('darwin')) {
    const version = Option.filter(facts.macos, value => numbered.test(value))
    if (Option.isSome(version)) {
      if (!atLeast(version.value, MACOS_FLOOR)) {
        return refuse(HostRefusal.MacosTooOld({ version: version.value }))
      }
      description += `, macOS ${version.value}`
    } else {
      notes.push(
        `Couldn't tell the macOS version, which must be ${MACOS_FLOOR} or later.`,
      )
    }
    if (facts.translated) {
      notes.push(
        'The check ran under Rosetta on Apple Silicon: the darwin arm64 engine runs natively there.',
      )
    }
  } else {
    const libc = facts.libc
    if (Libc.$is('Musl')(libc)) {
      return refuse(HostRefusal.Musl())
    }
    if (Libc.$is('Glibc')(libc) && numbered.test(libc.version)) {
      if (!atLeast(libc.version, GLIBC_FLOOR)) {
        return refuse(HostRefusal.GlibcTooOld({ version: libc.version }))
      }
      description += `, glibc ${libc.version}`
    } else {
      notes.push(
        `Couldn't tell the glibc version, which must be ${GLIBC_FLOOR} or later.`,
      )
    }
    if (Option.contains(facts.libatomic, false)) {
      return refuse(HostRefusal.NoLibatomic())
    }
  }
  if (target.value.endsWith('-x64')) {
    if (Option.contains(facts.sse2, false)) {
      return refuse(HostRefusal.CpuLacks({ component: 'Node', flag: 'sse2' }))
    }
    if (Option.isNone(facts.sse2)) {
      notes.push("Couldn't tell whether the CPU has SSE2, which Node needs.")
    }
  }
  if (!facts.tar) {
    return refuse(HostRefusal.NoTool({ tool: 'tar' }))
  }
  if (!facts.sha256) {
    return refuse(HostRefusal.NoTool({ tool: 'sha256sum or shasum' }))
  }
  return Result.succeed({ target: target.value, description, notes })
}

/** The release an engine's `fabrica --version` names, where it names one: its last word, less the tag's `v`. */
export const engineRelease = (said: string): Option.Option<ReleaseVersion> => {
  const line = said.trim()
  const last = line.split(' ').at(-1) ?? ''
  return Option.filter(
    decodeRelease(last.replace(/^v/u, '')),
    version => versionLine(version) === line,
  )
}
