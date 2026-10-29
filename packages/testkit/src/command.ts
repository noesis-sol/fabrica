import { Effect } from 'effect'
import { spawn } from 'node:child_process'

import { CommandFailed } from './errors'

export interface CommandOptions {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  /** The command's whole environment: `airtightEnv`'s. The command is found on its PATH. */
  readonly env: Readonly<Record<string, string>>
}

/** How a command ended: its exit code and what it printed. */
export interface CommandExit {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

const failed = (options: CommandOptions, stderr: string) =>
  new CommandFailed({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    stderr,
  })

/** Runs a command to its end, whatever its exit code; fails where it couldn't start or was killed. */
export const runCommandExit = (
  options: CommandOptions,
): Effect.Effect<CommandExit, CommandFailed> =>
  Effect.callback<CommandExit, CommandFailed>((resume, signal) => {
    const stdout: Array<Buffer> = []
    const stderr: Array<Buffer> = []
    // A command that can't start reports an error, then may close too: the first ends it.
    let ended = false
    const end = (result: Effect.Effect<CommandExit, CommandFailed>) => {
      if (ended) return
      ended = true
      resume(result)
    }
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    })
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', error => end(Effect.fail(failed(options, error.message))))
    child.on('close', (code, killedBy) =>
      end(
        code === null
          ? Effect.fail(failed(options, `killed by ${killedBy ?? 'a signal'}`))
          : Effect.succeed({
              code,
              stdout: Buffer.concat(stdout).toString('utf8'),
              stderr: Buffer.concat(stderr).toString('utf8'),
            }),
      ),
    )
  })

/** Runs a command to its end; what it printed on its standard output. Fails on an exit code but 0. */
export const runCommand = (
  options: CommandOptions,
): Effect.Effect<string, CommandFailed> =>
  Effect.flatMap(runCommandExit(options), ({ code, stdout, stderr }) =>
    code === 0
      ? Effect.succeed(stdout)
      : Effect.fail(
          failed(options, stderr === '' ? `exit code ${code}` : stderr),
        ),
  )
