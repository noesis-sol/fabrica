import {
  Data,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Schedule,
} from 'effect'
import type { RpcClientError } from 'effect/rpc'
import { Socket } from 'effect/socket'
import { execFile, spawn } from 'node:child_process'

import { type WslDistro, WslSearch, windowsDriveWarning } from '../wsl-host'
import {
  type BridgeCommand,
  type BridgeEnd,
  bridgeBackOff,
  bridgeSocket,
} from './bridge'

// WSL2 as one more host (spec §7.6, H31), from the Windows app: the distribution to run the engine in,
// found in `wsl.exe --list --verbose` (the default one where it is WSL2, else the first WSL2 one that
// isn't a tool's own, as Docker Desktop's is), or `wsl.exe --install -d Ubuntu` offered where there is
// none; the bridge, `wsl.exe -d <distro> -- fabrica bridge`, whose stdin and stdout carry the protocol
// as ssh's do (`bridge.ts`); and what keeps the distribution running. WSL shuts a distribution down
// once no Windows process has it open, whatever runs inside it, systemd units included, so the app
// leaves a detached `wsl.exe` holding it for as long as its engine answers (fab-mgi.16): it asks the
// engine its status every half minute and ends once none answers, letting WSL idle out. The install's
// steps run through `wsl.exe -d <distro> --exec` (`install/shell.ts`). Every wsl.exe runs with
// `WSL_UTF8=1`, so its own messages are UTF-8 rather than UTF-16.

/** The `wsl.exe` to run, unless given. */
const WSL = 'wsl.exe'

/** `env` with wsl.exe's own messages in UTF-8. */
export const wslEnv = (
  env: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> => ({ ...env, WSL_UTF8: '1' })

/** wsl.exe's arguments that install Ubuntu, WSL itself included where it isn't there (§7.6). */
export const wslInstallArguments: ReadonlyArray<string> = [
  '--install',
  '-d',
  'Ubuntu',
]

/** wsl.exe's arguments that list its distributions, their state and WSL version. */
export const wslListArguments: ReadonlyArray<string> = ['--list', '--verbose']

/**
 * wsl.exe's output as text: UTF-16LE (its own messages, where `WSL_UTF8` isn't honoured) or UTF-8,
 * without a byte order mark or NULs.
 */
export const decodeWslText = (bytes: Uint8Array): string => {
  const wide =
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes.length >= 2 && bytes[1] === 0)
  const text = Buffer.from(bytes).toString(wide ? 'utf16le' : 'utf8')
  return text.replaceAll('﻿', '').replaceAll('\0', '')
}

/** A distribution wsl.exe lists. */
export interface WslDistribution {
  readonly name: WslDistro
  /** Its WSL version: only a WSL2 one runs the engine. */
  readonly version: 1 | 2
  /** Whether it is wsl.exe's default. */
  readonly default: boolean
}

const distroName = /^(?!-)[A-Za-z0-9._-]+$/u

/**
 * The distributions in `wsl.exe --list --verbose`'s words. Each row is the default's `*`, the name, its
 * state and its version; the header and the state are in the user's language, so a row is told by its
 * version, its last word.
 */
export const parseWslList = (text: string): ReadonlyArray<WslDistribution> =>
  text.split(/\r?\n/u).flatMap(line => {
    const marked = line.trimStart().startsWith('*')
    const words = line.trim().replace(/^\*/u, '').trim().split(/\s+/u)
    const [name] = words
    const version = words.at(-1)
    return words.length >= 3 &&
      name !== undefined &&
      distroName.test(name) &&
      (version === '1' || version === '2')
      ? [{ name, version: version === '1' ? 1 : 2, default: marked }]
      : []
  })

/** A distribution a tool keeps for itself, not one to install an engine in: Docker Desktop's, say. */
export const isToolDistribution = (name: string): boolean =>
  /^(?:docker-desktop|rancher-desktop|podman-machine)/u.test(name)

/** The distribution to run the engine in, of those listed: the default where it is WSL2, else the first. */
export const chooseDistribution = (
  listed: ReadonlyArray<WslDistribution>,
): WslSearch => {
  const usable = listed.filter(found => !isToolDistribution(found.name))
  const wsl2 = usable.filter(found => found.version === 2)
  const chosen = wsl2.find(found => found.default) ?? wsl2[0]
  return chosen === undefined
    ? WslSearch.cases.None.make({
        wsl1: usable
          .filter(found => found.version === 1)
          .map(({ name }) => name),
      })
    : WslSearch.cases.Found.make({ distro: chosen.name })
}

/** How long wsl.exe has to answer a question: its service may be starting. */
const ASK_TIME = Duration.seconds(30)

/** wsl.exe couldn't be run, or didn't answer in time. */
export class WslUnavailable extends Data.TaggedError('WslUnavailable')<{
  readonly reason: string
}> {
  override get message() {
    return `couldn't run wsl.exe: ${this.reason}`
  }
}

/** Where to find wsl.exe and what it runs with. */
export interface WslRunner {
  /** wsl.exe's environment, the user's. */
  readonly env: Readonly<Record<string, string>>
  /** The wsl.exe to run: a path, or a name found on `env`'s PATH; `wsl.exe` unless given. */
  readonly wsl?: string
}

/** A run of wsl.exe to its exit: its code, and what it printed, as text. */
interface WslRan {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Runs wsl.exe with `args` to its exit, its stdin empty. */
const askWsl = (runner: WslRunner, args: ReadonlyArray<string>) =>
  Effect.callback<WslRan, WslUnavailable>(resume => {
    const command = runner.wsl ?? WSL
    const child = execFile(
      command,
      [...args],
      {
        env: wslEnv(runner.env),
        encoding: 'buffer',
        timeout: Duration.toMillis(ASK_TIME),
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const said = {
          stdout: decodeWslText(stdout),
          stderr: decodeWslText(stderr),
        }
        if (error === null) {
          resume(Effect.succeed({ code: 0, ...said }))
        } else if (typeof error.code === 'number') {
          resume(Effect.succeed({ code: error.code, ...said }))
        } else if (error.killed) {
          resume(
            Effect.fail(
              new WslUnavailable({
                reason: `${command} didn't answer within ${Duration.format(ASK_TIME)}`,
              }),
            ),
          )
        } else {
          resume(Effect.fail(new WslUnavailable({ reason: error.message })))
        }
      },
    )
    child.stdin?.end()
  })

/** Looks for the WSL2 distribution to run the engine in. */
export const findDistribution = Effect.fn('Wsl.findDistribution')(function* (
  runner: WslRunner,
) {
  return yield* askWsl(runner, wslListArguments).pipe(
    Effect.map(ran => chooseDistribution(parseWslList(ran.stdout))),
    Effect.catch(unavailable =>
      Effect.succeed(
        WslSearch.cases.Unavailable.make({ reason: unavailable.reason }),
      ),
    ),
  )
})

/** Where a checkout is in the distribution: `path` with its links resolved there, as `pwd -P` gives it. */
const resolveScript = 'cd -- "$1" 2>/dev/null && pwd -P'

/**
 * The warning about a checkout at `path` in `distro` on a Windows drive (§7.6), its links resolved
 * there first; none where it is in the distribution's own file system, or isn't there to resolve.
 */
export const checkoutWarning = Effect.fn('Wsl.checkoutWarning')(function* ({
  distro,
  path,
  ...runner
}: WslRunner & { readonly distro: WslDistro; readonly path: string }) {
  const ran = yield* askWsl(runner, [
    '-d',
    distro,
    '--exec',
    'sh',
    '-c',
    resolveScript,
    'sh',
    path,
  ])
  const resolved = ran.code === 0 ? ran.stdout.trim() : ''
  return Option.orElse(windowsDriveWarning(path), () =>
    resolved === '' ? Option.none() : windowsDriveWarning(resolved),
  )
})

// The bridge.

export interface WslOptions extends WslRunner {
  readonly distro: WslDistro
  /** The command run in the distribution: `fabrica bridge` unless given. */
  readonly remote?: ReadonlyArray<string>
}

/** Why wsl.exe ended a connection, from its exit and stderr. Every one but `Lost` is a refusal. */
export type WslFailure = Data.TaggedEnum<{
  /** WSL has no distribution of that name. */
  DistroMissing: { readonly detail: string }
  /** The distribution has no `fabrica` on its PATH. */
  BridgeMissing: { readonly detail: string }
  /** The distribution stopped, or the bridge failed: it is tried again. */
  Lost: { readonly detail: string }
}>
export const WslFailure = Data.taggedEnum<WslFailure>()

/** A connection to the engine in `distro` that wsl.exe ended, and why: the cause of its socket's error. */
export class WslFailed extends Data.TaggedError('WslFailed')<{
  readonly distro: string
  readonly failure: WslFailure
}> {
  /** Whether trying again would end the same way. */
  get refused(): boolean {
    return !WslFailure.$is('Lost')(this.failure)
  }

  override get message() {
    const at = this.distro
    return WslFailure.$match(this.failure, {
      DistroMissing: () =>
        `WSL has no distribution named ${at}: install it, or choose another`,
      BridgeMissing: () =>
        `the WSL distribution ${at} has no fabrica on its PATH: install the engine there`,
      Lost: ({ detail }) => `the connection to WSL ${at} failed: ${detail}`,
    })
  }
}

/** The WslFailed a connection's error carries, if wsl.exe ended it. */
export const wslFailed = (
  error: Socket.SocketError | RpcClientError.RpcClientError,
): Option.Option<WslFailed> => {
  const { reason } = error
  return Predicate.hasProperty(reason, 'cause') &&
    reason.cause instanceof WslFailed
    ? Option.some(reason.cause)
    : Option.none()
}

/** The client's reconnect schedule through wsl.exe: `base` (Effect's back-off unless given), until it refuses. */
export const wslReconnect = (
  base: Schedule.Schedule<unknown, Socket.SocketError> = bridgeBackOff,
): Schedule.Schedule<unknown, Socket.SocketError> =>
  Schedule.while(base, ({ input }) =>
    Option.match(wslFailed(input), {
      onNone: () => true,
      onSome: failed => !failed.refused,
    }),
  )

/** wsl.exe's last few lines of stderr, joined: what it said last. */
const lastWords = (stderr: string): string =>
  stderr
    .replaceAll('\0', '')
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line !== '')
    .slice(-3)
    .join(' ')

/** Why wsl.exe ended, from its exit and what it printed; none for a clean end. */
export const wslEnded = (end: BridgeEnd): Option.Option<WslFailure> => {
  if (end.code === 0) {
    return Option.none()
  }
  const detail = lastWords(end.stderr)
  if (
    /WSL_E_DISTRO_NOT_FOUND|no distribution with the supplied name/iu.test(
      end.stderr.replaceAll('\0', ''),
    )
  ) {
    return Option.some(WslFailure.DistroMissing({ detail }))
  }
  // The distribution's shell found no such command.
  if (end.code === 127) {
    return Option.some(WslFailure.BridgeMissing({ detail }))
  }
  return Option.some(
    WslFailure.Lost({
      detail:
        detail === ''
          ? end.code === null
            ? `wsl.exe was stopped by ${end.signal ?? 'a signal'}`
            : `wsl.exe exited with ${end.code}`
          : detail,
    }),
  )
}

/** wsl.exe's arguments for the bridge: `-d <distro> -- fabrica bridge`, run by the distribution's shell. */
export const wslBridgeArguments = (
  options: Pick<WslOptions, 'distro' | 'remote'>,
): ReadonlyArray<string> => [
  '-d',
  options.distro,
  '--',
  ...(options.remote ?? ['fabrica', 'bridge']),
]

/** A socket through wsl.exe to the engine in `options.distro`: each connection runs wsl.exe anew. */
export const wslSocket = (options: WslOptions): Effect.Effect<Socket.Socket> =>
  bridgeSocket(
    Effect.succeed<BridgeCommand>({
      command: options.wsl ?? WSL,
      args: wslBridgeArguments(options),
      env: wslEnv(options.env),
      ended: end =>
        Option.map(
          wslEnded(end),
          failure => new WslFailed({ distro: options.distro, failure }),
        ),
    }),
  )

/** The WSL2 bridge's `Socket`. Give the client `wslReconnect`, so it stops at a refusal. */
export const layerWsl = (options: WslOptions): Layer.Layer<Socket.Socket> =>
  Layer.effect(Socket.Socket, wslSocket(options))

// The keep-alive.

/** Seconds between the keep-alive's questions to the engine, unless given. */
const HOLD_EVERY = 30

/** Seconds the keep-alive waits for the engine's first answer, unless given: the bridge may be starting it. */
const HOLD_WAIT = 60

/**
 * The keep-alive, run by sh in the distribution with the seconds between questions as $1 and the
 * seconds to wait for a first answer as $2: it asks the engine `~/.local/bin/fabrica` links to for its
 * status, a second apart until it first answers, then every $1 seconds until it doesn't. Where flock
 * is there, one holds the distribution at a time: a second finds the lock taken and ends.
 */
export const holdScript =
  'set -u; engine="$HOME/.local/bin/fabrica"; ' +
  'answers() { "$engine" engine status </dev/null >/dev/null 2>&1; }; ' +
  'if command -v flock >/dev/null 2>&1; then ' +
  'folder="${XDG_DATA_HOME:-$HOME/.local/share}/fabrica"; mkdir -p "$folder" || exit 1; ' +
  'exec 9>>"$folder/wsl-hold.lock"; flock -n 9 || exit 0; fi; ' +
  'waited=0; until answers; do [ "$waited" -lt "$2" ] || exit 0; sleep 1; waited=$((waited + 1)); done; ' +
  'while answers; do sleep "$1"; done'

/** wsl.exe's arguments for the keep-alive of `distro`. */
export const holdArguments = ({
  distro,
  every = HOLD_EVERY,
  wait = HOLD_WAIT,
}: {
  readonly distro: WslDistro
  readonly every?: number
  readonly wait?: number
}): ReadonlyArray<string> => [
  '-d',
  distro,
  '--exec',
  'sh',
  '-c',
  holdScript,
  'sh',
  String(every),
  String(wait),
]

/** How a keep-alive ended: its exit code or the signal that stopped it. */
export interface HoldEnd {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

/** A keep-alive started: its process outlives the app; its end, while the app runs. */
export interface Held {
  readonly ended: Effect.Effect<HoldEnd>
}

/**
 * Starts the keep-alive of `distro`, detached, so it holds the distribution after the app has gone, for
 * as long as the engine there answers. Start it as the app connects: it waits a while for the bridge
 * to start the engine, and ends where none answers by then.
 */
export const holdDistribution = Effect.fn('Wsl.holdDistribution')(function* ({
  distro,
  every,
  wait,
  ...runner
}: WslRunner & {
  readonly distro: WslDistro
  readonly every?: number
  readonly wait?: number
}) {
  return yield* Effect.callback<Held, WslUnavailable>(resume => {
    const child = spawn(
      runner.wsl ?? WSL,
      [
        ...holdArguments({
          distro,
          ...(every === undefined ? {} : { every }),
          ...(wait === undefined ? {} : { wait }),
        }),
      ],
      {
        env: wslEnv(runner.env),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      },
    )
    const ended = new Promise<HoldEnd>(resolve =>
      child.once('exit', (code, signal) => resolve({ code, signal })),
    )
    child.once('error', error =>
      resume(Effect.fail(new WslUnavailable({ reason: error.message }))),
    )
    child.once('spawn', () => {
      child.unref()
      resume(Effect.succeed({ ended: Effect.promise(() => ended) }))
    })
  })
})
