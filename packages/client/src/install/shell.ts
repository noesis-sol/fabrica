import { Context, Data, Duration, Effect, Option } from 'effect'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import type { Readable } from 'node:stream'

import type { SshDestination } from '../destination'
import {
  SshFailed,
  SshPrompting,
  shQuote,
  sshArguments,
  sshEnded,
} from '../transports/ssh'

// The host an engine is installed on, as the installer reaches it (spec §9.2, §7.6): one interface,
// a command run there with its stdin, so the same steps install over SSH, in WSL2 through wsl.exe, and
// on this machine. A command is a list of words, never a line for a shell to split: ssh joins them for
// the user's login shell on the host, each quoted, so that whatever shell that is, it runs them as
// they are. A script is sent on the stdin of `sh -s`, never inside a quoted argument, which csh can't
// hold across lines; a file is sent on the stdin of `cat`.

/** What a command's stdin gets: a script's text, or a local file's bytes. */
export type ShellInput = Data.TaggedEnum<{
  Text: { readonly text: string }
  File: { readonly path: string }
}>
export const ShellInput = Data.taggedEnum<ShellInput>()

/** A command to run on the host. */
export interface ShellCommand {
  /** The command and its arguments, as words. */
  readonly argv: ReadonlyArray<string>
  readonly input: ShellInput
  readonly timeLimit: Duration.Input
}

/** A command that ran on the host to its exit code, and what it printed. */
export interface ShellRun {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** The command couldn't be run on the host, or didn't run to an exit code: why, in words. */
export class ShellFailed extends Data.TaggedError('ShellFailed')<{
  readonly host: string
  readonly reason: string
}> {
  override get message() {
    return `couldn't run the install's commands on ${this.host}: ${this.reason}`
  }
}

export interface HostShellShape {
  /** The host, as the user named it: an SSH destination, a WSL2 distribution, this machine. */
  readonly host: string
  /** Runs `command` on the host. */
  readonly exec: (command: ShellCommand) => Effect.Effect<ShellRun, ShellFailed>
}

export class HostShell extends Context.Service<HostShell, HostShellShape>()(
  '@fabrica/client/HostShell',
) {}

/** Runs the POSIX sh `script` on the host, with `args` as its `$1`…, the script on its stdin. */
export const runScript = ({
  script,
  args,
  timeLimit,
}: {
  readonly script: string
  readonly args: ReadonlyArray<string>
  readonly timeLimit: Duration.Input
}): Effect.Effect<ShellRun, ShellFailed, HostShell> =>
  HostShell.use(shell =>
    shell.exec({
      argv: ['sh', '-s', '--', ...args],
      input: ShellInput.Text({ text: script }),
      timeLimit,
    }),
  )

/** Sends the local file `file` to the host's `to`, which it makes or replaces. */
export const upload = ({
  file,
  to,
  timeLimit,
}: {
  readonly file: string
  readonly to: string
  readonly timeLimit: Duration.Input
}): Effect.Effect<ShellRun, ShellFailed, HostShell> =>
  HostShell.use(shell =>
    shell.exec({
      argv: ['sh', '-c', 'cat > "$1"', 'sh', to],
      input: ShellInput.File({ path: file }),
      timeLimit,
    }),
  )

/** The most of a command's stdout or stderr kept: the install's commands print a few lines. */
const outputCap = 1024 * 1024

/** How a local child is started for a host command: the program, its arguments, its environment. */
interface Spawn {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  /** What a run's end says about the host where it isn't the command's own: ssh's failure. */
  readonly failed: (run: ShellRun) => Option.Option<string>
}

const collect = (stream: Readable) => {
  const chunks: Array<Buffer> = []
  let size = 0
  stream.on('data', (chunk: Buffer) => {
    if (size < outputCap) {
      chunks.push(chunk)
      size += chunk.length
    }
  })
  return () => Buffer.concat(chunks).toString('utf8').slice(0, outputCap)
}

/** Runs `command` through the local child `spawned` makes, its stdin fed from `command.input`. */
const run = (host: string, made: Spawn, command: ShellCommand) =>
  Effect.callback<ShellRun, ShellFailed>(resume => {
    const failed = (reason: string) =>
      resume(Effect.fail(new ShellFailed({ host, reason })))
    const child = spawn(made.command, [...made.args], {
      env: made.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout = collect(child.stdout)
    const stderr = collect(child.stderr)
    let settled = false
    const timer = setTimeout(
      () => {
        settled = true
        child.kill('SIGKILL')
        failed(
          `it ran out of time (${Duration.format(Duration.fromInputUnsafe(command.timeLimit))})`,
        )
      },
      Duration.toMillis(Duration.fromInputUnsafe(command.timeLimit)),
    )
    child.on('error', error => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        failed(`${made.command} didn't start: ${error.message}`)
      }
    })
    // A child that exits without reading all its stdin closes the pipe: its exit says what happened.
    child.stdin.on('error', () => {})
    ShellInput.$match(command.input, {
      Text: ({ text }) => child.stdin.end(text),
      File: ({ path }) => {
        const file = createReadStream(path)
        file.on('error', error => {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            child.kill('SIGKILL')
            failed(`couldn't read ${path}: ${error.message}`)
          }
        })
        file.pipe(child.stdin)
      },
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === null) {
        failed(`it was ended by ${signal ?? 'a signal'}`)
        return
      }
      const ran: ShellRun = { code, stdout: stdout(), stderr: stderr() }
      Option.match(made.failed(ran), {
        onNone: () => resume(Effect.succeed(ran)),
        onSome: failed,
      })
    })
    return Effect.sync(() => {
      clearTimeout(timer)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
      }
    })
  })

const shellOf = (
  host: string,
  spawnFor: (argv: ReadonlyArray<string>) => Spawn,
): HostShellShape => ({
  host,
  exec: command => run(host, spawnFor(command.argv), command),
})

/** This machine: each command run directly, with `env` as its whole environment. */
export const localShell = ({
  env,
}: {
  readonly env: Readonly<Record<string, string>>
}): HostShellShape =>
  shellOf('this machine', ([command = 'sh', ...args]) => ({
    command,
    args,
    env,
    failed: () => Option.none(),
  }))

/** ssh exits 255 where it, not the command it ran, failed. */
const sshExit = 255

/**
 * The host at `destination` through the system's ssh, with the user's own config, keys and agent in
 * `env`, asking nothing (`BatchMode`): a host `known_hosts` knows, and keys ssh-agent holds.
 */
export const sshShell = ({
  destination,
  env,
  ssh,
}: {
  readonly destination: SshDestination
  readonly env: Readonly<Record<string, string>>
  /** The ssh to run: a path, or a name found on `env`'s PATH; `ssh` unless given. */
  readonly ssh?: string
}): HostShellShape =>
  shellOf(destination, argv => ({
    command: ssh ?? 'ssh',
    args: sshArguments({
      destination,
      env,
      prompting: SshPrompting.None(),
      remote: [argv.map(shQuote).join(' ')],
    }),
    env,
    failed: ran =>
      ran.code === sshExit
        ? Option.map(
            sshEnded({ code: ran.code, signal: null, stderr: ran.stderr }),
            failure => new SshFailed({ destination, failure }).message,
          )
        : Option.none(),
  }))

/** A WSL2 distribution through wsl.exe (§7.6), each command run there without a shell between. */
export const wslShell = ({
  distro,
  env,
  wsl,
}: {
  readonly distro: string
  readonly env: Readonly<Record<string, string>>
  /** The wsl.exe to run; `wsl.exe` unless given. */
  readonly wsl?: string
}): HostShellShape =>
  shellOf(`WSL ${distro}`, argv => ({
    command: wsl ?? 'wsl.exe',
    args: ['-d', distro, '--exec', ...argv],
    env,
    failed: () => Option.none(),
  }))
