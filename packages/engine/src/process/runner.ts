import {
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Queue,
  Ref,
  Scope,
  Stream,
} from 'effect'
import { type ChildProcess, spawn } from 'node:child_process'
import { getPriority } from 'node:os'
import type { Readable } from 'node:stream'

import { Deadlines, type DeadlinesShape } from './deadlines'
import { commandEnvironment } from './environment'
import { type PipeHolders, hostHolders, pipeFd } from './holders'
import {
  CommandOutcome,
  ExitStatus,
  type OutputStream,
  StartFailed,
  StartFailure,
  StdinClosed,
} from './outcome'
import { findOnPath } from './path'
import {
  type PriorityControl,
  applyNice,
  effectiveNice,
  hostPriority,
} from './priority'
import {
  type ProcessRow,
  type TreeHost,
  endTree,
  groupHasMembers,
  listProcesses,
} from './tree'

// The engine's one module for starting external commands (spec §12.1, §20.2, H61, H73, H74, H85):
// git, checks, setups and agents all start theirs here. Each command is found on the PATH it will run
// with, gets the allowlisted environment, stdin from /dev/null unless it is an agent's pipe, a process
// group (and session) of its own, and its nice value; ending it ends its whole tree.

/** What `ProcessRunner.run` and `start` share: the command, and how it runs. */
interface Invocation {
  /** A name looked up on the command's own PATH, or a path holding a `/`, against `cwd`. */
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  /** Variables beyond the engine's allowlisted ones, over them (git's local variables are dropped). */
  readonly env?: Readonly<Record<string, string>>
  /** The nice value a worker's command runs at (`worker_nice`); without one, the engine's own. */
  readonly nice?: number
}

/** A command run to its end, its output collected. */
export interface Command extends Invocation {
  /** Counted by the runner's deadlines, from its start. */
  readonly timeLimit: Duration.Input
  /** The bytes each of stdout and stderr may hold before the command is cut; 32 MiB without one. */
  readonly outputLimit?: number
}

/** A command that runs alongside the engine, an agent's: its output streamed, its stdin a pipe. */
export interface StartCommand extends Invocation {
  /** `pipe` gives the command a pipe the caller writes; `null`, /dev/null. */
  readonly stdin: 'pipe' | 'null'
}

/** A command `start` started; its scope's end ends its whole tree. */
export interface Running {
  readonly pid: number
  /** Its stdout as written, until it closes; run once. */
  readonly stdout: Stream.Stream<Uint8Array>
  /** Its stderr as written, until it closes; run once. */
  readonly stderr: Stream.Stream<Uint8Array>
  readonly write: (
    data: string | Uint8Array,
  ) => Effect.Effect<void, StdinClosed>
  readonly closeStdin: Effect.Effect<void>
  /** Waits for it to exit. */
  readonly exit: Effect.Effect<ExitStatus>
  /** Ends its whole tree, once however often it is asked; later asks wait on the first. */
  readonly end: Effect.Effect<void>
}

export interface ProcessRunnerShape {
  readonly run: (command: Command) => Effect.Effect<CommandOutcome>
  readonly start: (
    command: StartCommand,
  ) => Effect.Effect<Running, StartFailed, Scope.Scope>
}

export class ProcessRunner extends Context.Service<
  ProcessRunner,
  ProcessRunnerShape
>()('@fabrica/engine/process/ProcessRunner') {}

/** The facts about its host a runner works from, each read once where the engine starts. */
export interface RunnerConfig {
  /** The engine's own environment, which only allowlisted names are taken from. */
  readonly hostEnvironment: Readonly<Record<string, string | undefined>>
  /** The engine's own nice value: a command is never set higher in priority than it. */
  readonly enginePriority: number
  readonly priority: PriorityControl
  readonly listProcesses: Effect.Effect<
    Option.Option<ReadonlyArray<ProcessRow>>
  >
  /** Finds the processes holding a command's pipes, those its tree no longer reaches. */
  readonly pipeHolders: PipeHolders
  /** The engine's own process ID. */
  readonly self: number
  /** How long a terminated tree has before what is left is killed. */
  readonly killGrace: Duration.Input
  /** How long output is read after a command exits (spec §12.1: 2 s). */
  readonly outputGrace: Duration.Input
}

export const DEFAULT_OUTPUT_LIMIT = 32 * 1024 * 1024

/** The engine's own host, read once. */
export const hostConfig = (): RunnerConfig => ({
  hostEnvironment: { ...process.env },
  enginePriority: getPriority(),
  priority: hostPriority,
  listProcesses,
  pipeHolders: hostHolders({ platform: process.platform, self: process.pid }),
  self: process.pid,
  killGrace: Duration.seconds(5),
  outputGrace: Duration.seconds(2),
})

/** A child the system started, and its exit as it comes. */
interface Spawned {
  readonly child: ChildProcess
  readonly pid: number
  readonly stdout: Readable
  readonly stderr: Readable
  readonly exited: Deferred.Deferred<ExitStatus>
  /** What names the far ends of its pipes, read as it started, where the host needs it. */
  readonly ends: ReadonlyArray<string>
}

const spawnChild = ({
  file,
  invocation,
  environment,
  stdin,
  holders,
}: {
  readonly file: string
  readonly invocation: Invocation
  readonly environment: Readonly<Record<string, string>>
  readonly stdin: 'pipe' | 'null'
  readonly holders: PipeHolders
}): Effect.Effect<Spawned, StartFailure> =>
  Effect.callback<Spawned, StartFailure>(resume => {
    const failed = (message: string): void =>
      resume(
        Effect.fail(
          StartFailure.SpawnFailed({ command: invocation.command, message }),
        ),
      )
    let child: ChildProcess
    try {
      // `detached` makes the child the leader of a process group and a session of its own, so a
      // terminal's or a service manager's signals reach the engine alone, and its tree can be ended.
      child = spawn(file, invocation.args, {
        cwd: invocation.cwd,
        env: environment,
        detached: true,
        stdio: [stdin === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      failed(String(error))
      return
    }
    const exited = Deferred.makeUnsafe<ExitStatus>()
    child.once('exit', (code, signal) => {
      Deferred.doneUnsafe(
        exited,
        Effect.succeed(
          code === null
            ? ExitStatus.Signal({ signal: String(signal) })
            : ExitStatus.Code({ code }),
        ),
      )
    })
    const onError = (error: Error): void => failed(error.message)
    child.once('error', onError)
    child.once('spawn', () => {
      child.off('error', onError)
      // Errors after the start (a signal to a reaped child, a closed pipe) are the outcome's to say.
      child.on('error', () => {})
      child.stdin?.on('error', () => {})
      const { pid, stdout, stderr } = child
      if (pid === undefined || stdout === null || stderr === null) {
        failed('the child has no process ID or no output pipes')
        return
      }
      // Read at once, in the tick the child's exec was reported, before it can have moved its fds.
      const ends = holders.ends(pid)
      resume(Effect.succeed({ child, pid, stdout, stderr, exited, ends }))
    })
  })

/** A stream's output as `run` collects it, up to the size cap. */
interface Collected {
  readonly chunks: Array<Buffer>
  size: number
  readonly closed: Deferred.Deferred<void>
}

const collect = ({
  readable,
  stream,
  limit,
  cut,
}: {
  readonly readable: Readable
  readonly stream: OutputStream
  readonly limit: number
  readonly cut: Deferred.Deferred<OutputStream>
}): Collected => {
  const collected: Collected = {
    chunks: [],
    size: 0,
    closed: Deferred.makeUnsafe<void>(),
  }
  readable.on('data', (chunk: Buffer) => {
    collected.size += chunk.length
    if (collected.size > limit) Deferred.doneUnsafe(cut, Effect.succeed(stream))
    else collected.chunks.push(chunk)
  })
  readable.once('close', () =>
    Deferred.doneUnsafe(collected.closed, Effect.void),
  )
  return collected
}

const text = (collected: Collected): string =>
  Buffer.concat(collected.chunks).toString('utf8')

const streamOf = (readable: Readable): Stream.Stream<Uint8Array> =>
  Stream.callback<Uint8Array>(queue => {
    const onData = (chunk: Buffer): void => {
      Queue.offerUnsafe(queue, chunk)
    }
    const onClose = (): void => {
      Queue.endUnsafe(queue)
    }
    // A consumer that stops early leaves the rest in the pipe, as the command's backpressure.
    return Effect.acquireRelease(
      Effect.sync(() => {
        readable.on('data', onData)
        readable.once('close', onClose)
        if (readable.destroyed) onClose()
      }),
      () =>
        Effect.sync(() => {
          readable.off('data', onData)
          readable.off('close', onClose)
          readable.pause()
        }),
    )
  })

const destroyPipes = (spawned: Spawned): void => {
  spawned.child.stdin?.destroy()
  spawned.stdout.destroy()
  spawned.stderr.destroy()
}

/** How `run`'s command first ended: it exited, its limit ran out, or its output passed the cap. */
type FirstEnd = 'exited' | CommandOutcome

export const make = Effect.fn('ProcessRunner.make')(function* (
  config: RunnerConfig,
) {
  const deadlines: DeadlinesShape = yield* Deadlines
  const warned = yield* Ref.make(false)
  const tree: TreeHost = {
    listProcesses: config.listProcesses,
    deadlines,
    self: config.self,
  }
  /**
   * Ends a spawned command's tree, unless it has exited, its pipes have closed and nothing is left in
   * its group; then closes the engine's ends of its pipes.
   */
  const endSpawned = (spawned: Spawned) =>
    Effect.gen(function* () {
      const open = [spawned.stdout, spawned.stderr].flatMap(readable =>
        Option.toArray(pipeFd(readable)),
      )
      const exited = Deferred.isDoneUnsafe(spawned.exited)
      if (exited && open.length === 0 && !groupHasMembers(spawned.pid)) return
      const holders = yield* config.pipeHolders.find({
        fds: open,
        ends: spawned.ends,
      })
      yield* endTree({
        host: tree,
        pid: spawned.pid,
        holders,
        grace: config.killGrace,
      })
    }).pipe(Effect.ensuring(Effect.sync(() => destroyPipes(spawned))))

  /** The environment and file of an invocation, or why it can't start. */
  const resolve = Effect.fnUntraced(function* (invocation: Invocation) {
    const environment = commandEnvironment({
      host: config.hostEnvironment,
      extra: invocation.env ?? {},
    })
    const path = environment['PATH'] ?? ''
    const file = yield* findOnPath({
      command: invocation.command,
      path,
      cwd: invocation.cwd,
    })
    if (Option.isNone(file)) {
      return yield* Effect.fail(
        StartFailure.NotOnPath({ command: invocation.command, path }),
      )
    }
    return { environment, file: file.value }
  })

  const prioritize = (invocation: Invocation, pid: number) =>
    Option.match(
      effectiveNice({
        nice: Option.fromUndefinedOr(invocation.nice),
        engine: config.enginePriority,
      }),
      {
        onNone: () => Effect.void,
        onSome: nice =>
          applyNice({ control: config.priority, pid, nice, warned }),
      },
    )

  const run = Effect.fn('ProcessRunner.run')(
    function* (command: Command) {
      const { environment, file } = yield* resolve(command)
      const spawned = yield* Effect.acquireRelease(
        spawnChild({
          file,
          invocation: command,
          environment,
          stdin: 'null',
          holders: config.pipeHolders,
        }),
        endSpawned,
      )
      const limit = command.outputLimit ?? DEFAULT_OUTPUT_LIMIT
      const cut = Deferred.makeUnsafe<OutputStream>()
      const stdout = collect({
        readable: spawned.stdout,
        stream: 'stdout',
        limit,
        cut,
      })
      const stderr = collect({
        readable: spawned.stderr,
        stream: 'stderr',
        limit,
        cut,
      })
      const cutOff = Effect.map(Deferred.await(cut), stream =>
        CommandOutcome.Cut({ stream, limit }),
      )
      yield* prioritize(command, spawned.pid)
      const first: FirstEnd = yield* Effect.raceAll<Effect.Effect<FirstEnd>>([
        Effect.as(Deferred.await(spawned.exited), 'exited'),
        Effect.map(deadlines.sleep(command.timeLimit), () =>
          CommandOutcome.TimedOut({
            stdout: text(stdout),
            stderr: text(stderr),
          }),
        ),
        cutOff,
      ])
      if (first !== 'exited') return first
      const status = yield* Deferred.await(spawned.exited)
      // Output is read until the command exits and then for at most the grace, so a descendant
      // holding the pipes open can't hold the caller (H61); what it left in its group is ended.
      return yield* Effect.raceAll<Effect.Effect<CommandOutcome>>([
        Effect.map(
          Effect.all([
            Deferred.await(stdout.closed),
            Deferred.await(stderr.closed),
          ]),
          () =>
            CommandOutcome.Exited({
              status,
              stdout: text(stdout),
              stderr: text(stderr),
            }),
        ),
        Effect.map(deadlines.sleep(config.outputGrace), () =>
          CommandOutcome.Exited({
            status,
            stdout: text(stdout),
            stderr: text(stderr),
          }),
        ),
        cutOff,
      ])
    },
    Effect.scoped,
    Effect.catch((reason: StartFailure) =>
      Effect.succeed(CommandOutcome.FailedToStart({ reason })),
    ),
  )

  const start = Effect.fn('ProcessRunner.start')(function* (
    command: StartCommand,
  ) {
    const { environment, file } = yield* Effect.mapError(
      resolve(command),
      reason => new StartFailed({ reason }),
    )
    const ended = Deferred.makeUnsafe<void>()
    const begun = { ending: false }
    const endOf = (spawned: Spawned) =>
      Effect.uninterruptible(
        Effect.suspend(() => {
          if (begun.ending) return Deferred.await(ended)
          begun.ending = true
          return Effect.ensuring(
            endSpawned(spawned),
            Deferred.done(ended, Exit.void),
          )
        }),
      )
    const spawned = yield* Effect.acquireRelease(
      Effect.mapError(
        spawnChild({
          file,
          invocation: command,
          environment,
          stdin: command.stdin,
          holders: config.pipeHolders,
        }),
        reason => new StartFailed({ reason }),
      ),
      endOf,
    )
    const end = endOf(spawned)
    yield* prioritize(command, spawned.pid)
    const stdin = spawned.child.stdin
    const running: Running = {
      pid: spawned.pid,
      stdout: streamOf(spawned.stdout),
      stderr: streamOf(spawned.stderr),
      write: data =>
        Effect.callback<void, StdinClosed>(resume => {
          const closed = () =>
            resume(Effect.fail(new StdinClosed({ pid: spawned.pid })))
          if (stdin === null || !stdin.writable) {
            closed()
            return
          }
          stdin.write(data, error => (error ? closed() : resume(Effect.void)))
        }),
      closeStdin: Effect.sync(() => {
        stdin?.end()
      }),
      exit: Deferred.await(spawned.exited),
      end,
    }
    return running
  })

  return ProcessRunner.of({ run, start })
})

/** A runner over the given host facts. */
export const layer = (
  config: RunnerConfig,
): Layer.Layer<ProcessRunner, never, Deadlines> =>
  Layer.effect(ProcessRunner, make(config))

/** A runner over the engine's own host, its facts read once as the layer is built. */
export const layerHost: Layer.Layer<ProcessRunner, never, Deadlines> =
  Layer.effect(
    ProcessRunner,
    Effect.suspend(() => make(hostConfig())),
  )
