import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

// A stand-in for the `docker` and `podman` CLIs, at the process boundary (spec §12.7, §24): a shell script
// that notes each call's arguments, answers `info` and `version` from a file, refuses a subcommand where a
// `fail-<it>` file says to, and runs `exec`'s command on the host, in the CLI's working folder, its paths under the
// mounted distribution mapped to the fixture's. A shell script run once per test's hard link, so only the
// first run of the file waits on macOS's scan of a new executable.

const SCRIPT = `#!/bin/sh
state=$(dirname "$0")/..
self=$(basename "$0")
{
  printf '%s' "$self"
  for word in "$@"; do printf '\\037%s' "$word" | tr '\\n' '\\036'; done
  printf '\\n'
} >> "$state/calls"
if [ -e "$state/fail-$1" ]; then
  echo "refused $1" >&2
  exit 1
fi
case "$1" in
  info)
    cat "$state/info-$self" 2>/dev/null || exit 1
    ;;
  version)
    cat "$state/version-$self" 2>/dev/null || exit 1
    ;;
  image)
    [ -e "$state/held" ] || exit 1
    ;;
  inspect)
    cat "$state/inspected" 2>/dev/null || echo '[]'
    ;;
  exec)
    shift
    root=$(cat "$state/distribution-root")
    while [ $# -gt 0 ]; do
      case "$1" in
        --env)
          case "$2" in
            *=*) export "$2" ;;
          esac
          shift 2
          ;;
        --workdir|--user) shift 2 ;;
        --interactive) shift ;;
        *) break ;;
      esac
    done
    shift
    count=$#
    while [ "$count" -gt 0 ]; do
      word=$1
      shift
      case "$word" in
        /opt/fabrica/*) word="$root/\${word#/opt/fabrica/}" ;;
      esac
      set -- "$@" "$word"
      count=$((count - 1))
    done
    exec "$@"
    ;;
esac
`

/** Writes the script at `path`, for `installStub` to link. */
export const writeStubScript = (path: string) => {
  writeFileSync(path, SCRIPT)
  chmodSync(path, 0o755)
}

export interface StubCli {
  /** The folder that is the whole PATH: the stubs and the tools their script runs. */
  readonly bin: string
  /** What `info` answers for `cli`. */
  readonly answerInfo: (cli: string, info: unknown) => void
  /** What `version` answers for `cli`; it fails until this says. */
  readonly answerVersion: (cli: string, version: unknown) => void
  /** Each call so far, its CLI's name first. */
  readonly calls: () => ReadonlyArray<ReadonlyArray<string>>
  /** Makes `subcommand` fail. */
  readonly refuse: (subcommand: string) => void
  /** Says the host holds the images `image inspect` is asked about. */
  readonly holdImages: () => void
  /** What `inspect` says the container's environment is. */
  readonly answerInspect: (entries: ReadonlyArray<string>) => void
  /** Forgets the calls so far, and what was refused. */
  readonly reset: () => void
}

/** The tools the script runs: it keeps no other folder on the PATH, where a real docker or podman may be. */
const scriptTools = ['basename', 'cat', 'dirname', 'sh', 'tr']

/** Where `tool` is among the system's own folders, as the script's few tools are on every host. */
const systemTool = (tool: string): string => {
  const found = ['/usr/bin', '/bin']
    .map(folder => join(folder, tool))
    .find(path => existsSync(path))
  if (found === undefined) throw new Error(`no ${tool} in /usr/bin or /bin`)
  return found
}

/**
 * The CLIs named and the script's tools, in a new folder under `base` that is the whole PATH, with
 * `distribution` the folder `/opt/fabrica` maps to.
 */
export const installStub = ({
  script,
  base,
  clis,
  distribution,
}: {
  readonly script: string
  readonly base: string
  readonly clis: ReadonlyArray<string>
  readonly distribution: string
}): StubCli => {
  const bin = join(base, 'bin')
  mkdirSync(bin, { recursive: true })
  for (const cli of clis) linkSync(script, join(bin, cli))
  for (const tool of scriptTools) symlinkSync(systemTool(tool), join(bin, tool))
  const at = (name: string) => join(dirname(bin), name)
  const refused = new Set<string>()
  writeFileSync(at('distribution-root'), distribution)
  return {
    bin,
    answerInfo: (cli, info) =>
      writeFileSync(at(`info-${cli}`), JSON.stringify(info)),
    answerVersion: (cli, version) =>
      writeFileSync(at(`version-${cli}`), JSON.stringify(version)),
    calls: () => {
      const text = (() => {
        try {
          return readFileSync(at('calls'), 'utf8')
        } catch {
          return ''
        }
      })()
      return text
        .split('\n')
        .filter(line => line !== '')
        .map(line =>
          line.split('\u001f').map(word => word.replaceAll('\u001e', '\n')),
        )
    },
    refuse: subcommand => {
      refused.add(subcommand)
      writeFileSync(at(`fail-${subcommand}`), '')
    },
    holdImages: () => writeFileSync(at('held'), ''),
    answerInspect: entries =>
      writeFileSync(at('inspected'), JSON.stringify(entries)),
    reset: () => {
      writeFileSync(at('calls'), '')
      for (const subcommand of refused)
        rmSync(at(`fail-${subcommand}`), { force: true })
      refused.clear()
    },
  }
}

/** A distribution whose Node is the one running the tests and whose Pi is `cli`. */
export const stubDistribution = ({
  base,
  node,
  cli,
}: {
  readonly base: string
  readonly node: string
  readonly cli: string
}) => {
  const root = join(base, 'distribution')
  mkdirSync(root, { recursive: true })
  symlinkSync(node, join(root, 'node'))
  symlinkSync(cli, join(root, 'cli.mjs'))
  writeFileSync(join(root, 'extension.js'), 'export default function () {}\n')
  return { root, node: 'node', cli: 'cli.mjs', extension: 'extension.js' }
}

export const dockerRootless = {
  SecurityOptions: ['name=seccomp', 'name=rootless'],
}
export const dockerRootful = { SecurityOptions: ['name=seccomp'] }
export const podmanRootless = { host: { security: { rootless: true } } }
export const podmanRootful = { host: { security: { rootless: false } } }
