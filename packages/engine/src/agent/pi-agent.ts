import {
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Scope,
  type Stream,
} from 'effect'

import { type ProjectId, SessionId, type TicketId } from '@fabrica/contracts'

import {
  Deadlines,
  type DeadlinesShape,
  type ExitStatus,
  ProcessRunner,
  type Running,
} from '../process'
import { type ModelChoice, PiCommand, commandName } from './commands'
import {
  type Connection,
  type SkipLog,
  answerData,
  connect,
} from './connection'
import {
  AgentSendFailed,
  AgentStartFailed,
  AgentStartFailure,
  SendFailure,
} from './errors'
import {
  type ProviderEntry,
  configFolder,
  makeSessionFolder,
  piArguments,
  piEnvironment,
  sessionFolder,
} from './launch'
import { reaperArguments } from './reaper'
import {
  type Disposition,
  type Forked,
  PiDisposition,
  type PiEvent,
  PiForked,
  PiSessionStats,
  PiState,
  PiSwitched,
  type SessionStats,
} from './records'

// `PiAgent` (spec §12.1, H61, H74, H75): each worker is a Pi process in RPC mode, owned by the engine
// as a scoped resource. Acquire is spawn and handshake; release is abort, terminate and reap, each
// within a limit, so no caller waits on an agent that doesn't answer. A ticket has one session at a
// time (Starting, Open, Closing): a start waits for a closing session's process to exit, and a
// command sent to a closing session fails. Pi's Promise and RPC surface never leaves this module.

/** What starting a ticket's agent takes. */
export interface AgentStart {
  readonly ticket: TicketId
  readonly project: ProjectId
  /** The ticket's worktree, Pi's working folder. */
  readonly worktree: string
  /** Each provider pointed at the model proxy (spec §12.9). */
  readonly providers: ReadonlyArray<ProviderEntry>
  /** The agent's token for the model proxy, in place of every provider's key. */
  readonly token: string
  readonly model: Option.Option<ModelChoice>
  /** A session file to resume with `switch_session`; none starts a new session. */
  readonly resume: Option.Option<string>
  /** Variables beyond the allowlisted ones: the control socket's path and token. */
  readonly env: Readonly<Record<string, string>>
  /** The nice value the agent runs at (`worker_nice`). */
  readonly nice: Option.Option<number>
}

/** The session an agent opened, saved for the carry-over only once it has started. */
export interface AgentSession {
  readonly id: SessionId
  readonly file: Option.Option<string>
}

/** How a prompt's turn settled. */
export interface Settled {
  readonly disposition: Disposition
  /** The turn was aborted rather than run to its end. */
  readonly aborted: boolean
}

/** A ticket's started agent. Its scope's end closes it, as `close` does. */
export interface Agent {
  readonly ticket: TicketId
  readonly pid: number
  readonly session: AgentSession
  /**
   * Subscribes in the scope: the stream holds every event Pi writes from the subscription on, none
   * lost however late it is read, and ends when Pi exits.
   */
  readonly events: Effect.Effect<Stream.Stream<PiEvent>, never, Scope.Scope>
  /**
   * Sends a prompt (the first, or a hand-back) and waits for its turn to settle; interrupted, it
   * aborts the turn. A prompt an extension handled runs no turn, and returns at once.
   */
  readonly prompt: (message: string) => Effect.Effect<Settled, AgentSendFailed>
  /** Sends a maintainer's message into the running turn. */
  readonly steer: (
    message: string,
  ) => Effect.Effect<Disposition, AgentSendFailed>
  readonly abort: Effect.Effect<void, AgentSendFailed>
  readonly setModel: (
    model: ModelChoice,
  ) => Effect.Effect<void, AgentSendFailed>
  /** Switches to another session file; false when an extension cancelled it. */
  readonly switchSession: (
    sessionPath: string,
  ) => Effect.Effect<boolean, AgentSendFailed>
  readonly fork: (entryId: string) => Effect.Effect<Forked, AgentSendFailed>
  readonly sessionStats: Effect.Effect<SessionStats, AgentSendFailed>
  /** Waits for Pi to exit. */
  readonly exit: Effect.Effect<ExitStatus>
  /** Aborts, terminates and reaps it, each within its limit; later calls wait on the first. */
  readonly close: Effect.Effect<void>
}

export interface PiAgentShape {
  /**
   * Starts the ticket's agent, or resumes its session: waits for a closing session of the ticket to
   * exit, then spawns Pi and shakes hands. A failed or interrupted start leaves nothing behind.
   */
  readonly start: (
    options: AgentStart,
  ) => Effect.Effect<Agent, AgentStartFailed, Scope.Scope>
  /** Closes the ticket's session, whatever its state; a starting one is cancelled. */
  readonly close: (ticket: TicketId) => Effect.Effect<void>
}

export class PiAgent extends Context.Service<PiAgent, PiAgentShape>()(
  '@fabrica/engine/agent/PiAgent',
) {}

/** Each wait's limit (H61). */
export interface AgentLimits {
  /** For Pi to answer the handshake, and the resume. */
  readonly handshake: Duration.Input
  /** For Pi to answer a command. */
  readonly answer: Duration.Input
  /** For Pi to answer an abort, at a release or an interruption. */
  readonly abort: Duration.Input
  /** For Pi to exit once its tree was ended. */
  readonly reap: Duration.Input
}

/** What the service works from, read once where the engine starts. */
export interface PiAgentConfig {
  /** The engine distribution's Node, which runs Pi and the reapers. */
  readonly node: string
  /** Pi's CLI script. */
  readonly cli: string
  /** The first-party extension. */
  readonly extension: string
  /** The engine's data folder (spec §7.2). */
  readonly data: string
  /** Where each agent's configuration folder is made, and removed at its end. */
  readonly configRoot: string
  readonly limits: AgentLimits
  /** How often a reaper lists its agent's tree. */
  readonly reaperPoll: Duration.Input
  /** How long a reaper's terminated tree has before it is killed. */
  readonly reaperGrace: Duration.Input
}

export const DEFAULT_LIMITS: AgentLimits = {
  handshake: Duration.seconds(30),
  answer: Duration.seconds(30),
  abort: Duration.seconds(10),
  reap: Duration.seconds(10),
}

/** A ticket's session, as its one lifecycle has it (H75). */
type Slot = Data.TaggedEnum<{
  Starting: {
    /** Completed when the slot is given up: the start failed, or its agent has closed. */
    readonly freed: Deferred.Deferred<void>
    /** Completed by a close during the start, which cancels it. */
    readonly cancel: Deferred.Deferred<void>
  }
  Open: {
    readonly freed: Deferred.Deferred<void>
    readonly close: Effect.Effect<void>
  }
  Closing: { readonly freed: Deferred.Deferred<void> }
}>
const Slot = Data.taggedEnum<Slot>()

/** What `reserve` found in a ticket's slot. */
type Reserved = Data.TaggedEnum<{
  Reserved: {
    readonly freed: Deferred.Deferred<void>
    readonly cancel: Deferred.Deferred<void>
  }
  Wait: { readonly freed: Deferred.Deferred<void> }
  Busy: {}
}>
const Reserved = Data.taggedEnum<Reserved>()

/** What `close` found in a ticket's slot. */
type Closed = Data.TaggedEnum<{
  Close: { readonly freed: Deferred.Deferred<void> }
  Wait: { readonly freed: Deferred.Deferred<void> }
  Gone: {}
}>
const Closed = Data.taggedEnum<Closed>()

/** One agent's process, its reaper and its connection, in the agent's own scope. */
interface Launched {
  readonly running: Running
  readonly connection: Connection
}

export const make = Effect.fn('PiAgent.make')(function* (
  config: PiAgentConfig,
) {
  const runner = yield* ProcessRunner
  const deadlines: DeadlinesShape = yield* Deadlines
  const slots = yield* Ref.make<ReadonlyMap<TicketId, Slot>>(new Map())
  const logged = new Set<string>()

  const skipped: SkipLog = ({ kind, reason }) =>
    Effect.suspend(() => {
      const key = `${reason}: ${kind}`
      if (logged.has(key)) return Effect.void
      logged.add(key)
      return Effect.logWarning(`Pi record skipped: ${kind} (${reason})`)
    })

  const setSlot = (ticket: TicketId, slot: Option.Option<Slot>) =>
    Ref.update(slots, current => {
      const next = new Map(current)
      if (Option.isSome(slot)) next.set(ticket, slot.value)
      else next.delete(ticket)
      return next
    })

  /** Waits up to `limit` for `effect`, as the deadlines count time; `None` past it. */
  const within = <A, E>(effect: Effect.Effect<A, E>, limit: Duration.Input) =>
    Effect.raceFirst(
      Effect.map(effect, Option.some),
      Effect.as(deadlines.sleep(limit), Option.none<A>()),
    )

  /**
   * Reserves the ticket's slot, waiting for a closing session's process to exit (H75; tutti-j3w).
   * Run uninterruptibly, the wait alone given to `restore`, so an interruption never leaves the slot
   * reserved.
   */
  const reserve = (
    ticket: TicketId,
    restore: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>,
  ): Effect.Effect<
    {
      readonly freed: Deferred.Deferred<void>
      readonly cancel: Deferred.Deferred<void>
    },
    AgentStartFailed
  > =>
    Effect.gen(function* () {
      for (;;) {
        const found = yield* Ref.modify(
          slots,
          (current): [Reserved, ReadonlyMap<TicketId, Slot>] => {
            const slot = current.get(ticket)
            if (slot === undefined) {
              const freed = Deferred.makeUnsafe<void>()
              const cancel = Deferred.makeUnsafe<void>()
              return [
                Reserved.Reserved({ freed, cancel }),
                new Map(current).set(ticket, Slot.Starting({ freed, cancel })),
              ]
            }
            return [
              Slot.$match(slot, {
                Closing: ({ freed }) => Reserved.Wait({ freed }),
                Starting: () => Reserved.Busy(),
                Open: () => Reserved.Busy(),
              }),
              current,
            ]
          },
        )
        if (Reserved.$is('Reserved')(found)) return found
        if (Reserved.$is('Busy')(found))
          return yield* new AgentStartFailed({
            ticket,
            reason: AgentStartFailure.Busy(),
          })
        yield* restore(Deferred.await(found.freed))
      }
    })

  /** Spawns Pi and its reaper in `scope`, and connects to Pi. */
  const launch = (options: AgentStart, scope: Scope.Scope) =>
    Effect.gen(function* () {
      const fail = (reason: AgentStartFailure) =>
        new AgentStartFailed({ ticket: options.ticket, reason })
      const sessions = sessionFolder({
        data: config.data,
        project: options.project,
        ticket: options.ticket,
      })
      yield* Effect.mapError(makeSessionFolder(sessions), message =>
        fail(AgentStartFailure.Folders({ message })),
      )
      const folder = yield* configFolder({
        root: config.configRoot,
        providers: options.providers,
        token: options.token,
      }).pipe(
        Effect.mapError(message =>
          fail(AgentStartFailure.Folders({ message })),
        ),
        Scope.provide(scope),
      )
      const running = yield* runner
        .start({
          command: config.node,
          args: piArguments({
            cli: config.cli,
            extension: config.extension,
            sessions,
            model: options.model,
          }),
          cwd: options.worktree,
          env: piEnvironment({ config: folder, extra: options.env }),
          stdin: 'pipe',
          ...Option.match(options.nice, {
            onNone: () => ({}),
            onSome: nice => ({ nice }),
          }),
        })
        .pipe(
          Effect.mapError(error =>
            fail(AgentStartFailure.Spawn({ reason: error.reason })),
          ),
          Scope.provide(scope),
        )
      // The reaper's stdin is a pipe only the engine holds: its end is the engine's death.
      yield* runner
        .start({
          command: config.node,
          args: reaperArguments({
            agent: running.pid,
            poll: config.reaperPoll,
            grace: config.reaperGrace,
          }),
          cwd: options.worktree,
          stdin: 'pipe',
        })
        .pipe(
          Effect.mapError(error =>
            fail(AgentStartFailure.Spawn({ reason: error.reason })),
          ),
          Scope.provide(scope),
        )
      const connection = yield* connect({ running, deadlines, skipped, scope })
      const launched: Launched = { running, connection }
      return launched
    })

  /** The handshake: the resume where there is one, then the session Pi opened. */
  const handshake = (options: AgentStart, { running, connection }: Launched) =>
    Effect.gen(function* () {
      const refused = (command: PiCommand) => (reason: SendFailure) =>
        Effect.gen(function* () {
          if (SendFailure.$is('Exited')(reason)) {
            const status = yield* within(running.exit, config.limits.reap)
            if (Option.isSome(status))
              return yield* new AgentStartFailed({
                ticket: options.ticket,
                reason: AgentStartFailure.Exited({
                  status: status.value,
                  stderr: connection.stderr(),
                }),
              })
          }
          return yield* new AgentStartFailed({
            ticket: options.ticket,
            reason: AgentStartFailure.Handshake({
              command: commandName(command),
              reason,
            }),
          })
        })
      const ask = <A>(
        command: PiCommand,
        read: (
          response: Parameters<typeof answerData>[1],
        ) => Effect.Effect<A, SendFailure>,
      ) =>
        connection
          .request(command, config.limits.handshake)
          .pipe(Effect.flatMap(read), Effect.catch(refused(command)))
      if (Option.isSome(options.resume)) {
        const command = PiCommand.SwitchSession({
          sessionPath: options.resume.value,
        })
        const switched = yield* ask(command, response =>
          answerData(PiSwitched, response),
        )
        if (switched.cancelled)
          yield* refused(command)(
            SendFailure.Refused({ error: 'the switch was cancelled' }),
          )
      }
      const command = PiCommand.GetState()
      const state = yield* ask(command, response =>
        answerData(PiState, response),
      )
      const id = yield* Effect.mapError(
        SessionId.makeEffect(state.sessionId),
        () =>
          new AgentStartFailed({
            ticket: options.ticket,
            reason: AgentStartFailure.Handshake({
              command: commandName(command),
              reason: SendFailure.Unreadable(),
            }),
          }),
      )
      const session: AgentSession = {
        id,
        file: Option.fromUndefinedOr(state.sessionFile),
      }
      return session
    })

  /** Ends an agent's tree and waits for its exit, each within its limit, then its scope. */
  const terminate = (running: Running, scope: Scope.Closeable) =>
    Effect.gen(function* () {
      yield* running.end
      yield* within(running.exit, config.limits.reap)
      yield* Scope.close(scope, Exit.void)
    })

  /** The agent of a started session. */
  const agentOf = ({
    options,
    launched,
    session,
    scope,
    freed,
  }: {
    readonly options: AgentStart
    readonly launched: Launched
    readonly session: AgentSession
    readonly scope: Scope.Closeable
    readonly freed: Deferred.Deferred<void>
  }): Agent => {
    const { ticket } = options
    const { running, connection } = launched
    const phase = { closing: false }

    const send = (
      command: PiCommand,
      limit: Duration.Input = config.limits.answer,
    ) =>
      Effect.suspend(() =>
        phase.closing
          ? Effect.fail(SendFailure.Closing())
          : connection.request(command, limit),
      ).pipe(
        Effect.mapError(
          reason =>
            new AgentSendFailed({
              ticket,
              command: commandName(command),
              reason,
            }),
        ),
      )

    const read = <A>(
      command: PiCommand,
      schema: Parameters<typeof answerData<A>>[0],
    ) =>
      send(command).pipe(
        Effect.flatMap(response =>
          Effect.mapError(
            answerData(schema, response),
            reason =>
              new AgentSendFailed({
                ticket,
                command: commandName(command),
                reason,
              }),
          ),
        ),
      )

    /** An abort that waits up to its limit and says nothing of how it went. */
    const abortQuietly = Effect.ignore(
      connection.request(PiCommand.Abort(), config.limits.abort),
    )

    const prompt = (message: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const take = yield* connection.subscribe
          const { disposition } = yield* read(
            PiCommand.Prompt({ message }),
            PiDisposition,
          )
          // An extension handled it: no turn runs, so none settles (Pi's own RPC client waits on none).
          if (disposition === 'handled') {
            const handled: Settled = { disposition, aborted: false }
            return handled
          }
          for (;;) {
            const next = yield* take
            if (Option.isNone(next))
              return yield* new AgentSendFailed({
                ticket,
                command: 'prompt',
                reason: SendFailure.Exited(),
              })
            if (next.value.type === 'agent_settled') {
              const settled: Settled = {
                disposition,
                aborted: next.value.aborted,
              }
              return settled
            }
          }
        }),
      ).pipe(Effect.onInterrupt(() => abortQuietly))

    const close = Effect.uninterruptible(
      Effect.gen(function* () {
        const found = yield* Ref.modify(
          slots,
          (current): [Closed, ReadonlyMap<TicketId, Slot>] => {
            const slot = current.get(ticket)
            if (slot === undefined || slot.freed !== freed)
              return [Closed.Gone(), current]
            if (Slot.$is('Closing')(slot))
              return [Closed.Wait({ freed }), current]
            return [
              Closed.Close({ freed }),
              new Map(current).set(ticket, Slot.Closing({ freed })),
            ]
          },
        )
        phase.closing = true
        if (Closed.$is('Gone')(found)) return
        if (Closed.$is('Wait')(found)) return yield* Deferred.await(found.freed)
        yield* abortQuietly
        yield* terminate(running, scope)
        yield* setSlot(ticket, Option.none())
        yield* Deferred.done(freed, Exit.void)
      }),
    ).pipe(Effect.withSpan('PiAgent.close'))

    return {
      ticket,
      pid: running.pid,
      session,
      events: connection.events,
      prompt,
      steer: message =>
        Effect.map(
          read(PiCommand.Steer({ message }), PiDisposition),
          data => data.disposition,
        ),
      abort: Effect.asVoid(send(PiCommand.Abort(), config.limits.abort)),
      setModel: model => Effect.asVoid(send(PiCommand.SetModel({ model }))),
      switchSession: sessionPath =>
        Effect.map(
          read(PiCommand.SwitchSession({ sessionPath }), PiSwitched),
          data => !data.cancelled,
        ),
      fork: entryId => read(PiCommand.Fork({ entryId }), PiForked),
      sessionStats: read(PiCommand.GetSessionStats(), PiSessionStats),
      exit: running.exit,
      close,
    }
  }

  const start = Effect.fn('PiAgent.start')(function* (options: AgentStart) {
    const caller = yield* Scope.Scope
    const cancelled = (cancel: Deferred.Deferred<void>) =>
      Effect.andThen(
        Deferred.await(cancel),
        Effect.fail(
          new AgentStartFailed({
            ticket: options.ticket,
            reason: AgentStartFailure.Cancelled(),
          }),
        ),
      )
    // Reserving, spawning and closing on interruption are one uninterruptible step, so an
    // interrupted start leaves nothing reserved (tutti-0k95); only the waits are interruptible.
    return yield* Effect.uninterruptibleMask(restore =>
      Effect.gen(function* () {
        const { freed, cancel } = yield* reserve(options.ticket, restore)
        const free = Effect.andThen(
          setSlot(options.ticket, Option.none()),
          Deferred.done(freed, Exit.void),
        )
        const scope = yield* Scope.make()
        const launched = yield* Effect.exit(launch(options, scope))
        if (Exit.isFailure(launched)) {
          yield* Scope.close(scope, Exit.void)
          yield* free
          return yield* Effect.failCause(launched.cause)
        }
        const session = yield* Effect.exit(
          restore(
            Effect.raceFirst(
              handshake(options, launched.value),
              cancelled(cancel),
            ),
          ),
        )
        const agent = Exit.map(session, opened =>
          agentOf({
            options,
            launched: launched.value,
            session: opened,
            scope,
            freed,
          }),
        )
        // The check for a close and the change to Open are one step, so a close either cancels the
        // start, even one whose handshake has just ended, or finds the agent open.
        const open = Exit.isSuccess(agent)
          ? yield* Ref.modify(
              slots,
              (current): [boolean, ReadonlyMap<TicketId, Slot>] =>
                Deferred.isDoneUnsafe(cancel)
                  ? [false, current]
                  : [
                      true,
                      new Map(current).set(
                        options.ticket,
                        Slot.Open({ freed, close: agent.value.close }),
                      ),
                    ],
            )
          : false
        if (!open || Exit.isFailure(agent)) {
          // Interruption maps to Pi's abort.
          if (Exit.hasInterrupts(session))
            yield* Effect.ignore(
              launched.value.connection.request(
                PiCommand.Abort(),
                config.limits.abort,
              ),
            )
          yield* terminate(launched.value.running, scope)
          yield* free
          return yield* Exit.isFailure(session)
            ? Effect.failCause(session.cause)
            : new AgentStartFailed({
                ticket: options.ticket,
                reason: AgentStartFailure.Cancelled(),
              })
        }
        yield* Scope.addFinalizer(caller, agent.value.close)
        return agent.value
      }),
    )
  })

  const close = Effect.fn('PiAgent.close')(function* (ticket: TicketId) {
    // Read and acted on in one step: a start is cancelled while it is still starting, or its agent
    // found open.
    const closing = yield* Ref.modify(
      slots,
      (current): [Effect.Effect<void>, ReadonlyMap<TicketId, Slot>] => {
        const slot = current.get(ticket)
        if (slot === undefined) return [Effect.void, current]
        return [
          Slot.$match(slot, {
            Starting: ({ cancel, freed }) => {
              Deferred.doneUnsafe(cancel, Exit.void)
              return Deferred.await(freed)
            },
            Open: ({ close: closeAgent }) => closeAgent,
            Closing: ({ freed }) => Deferred.await(freed),
          }),
          current,
        ]
      },
    )
    yield* closing
  })

  return PiAgent.of({ start, close })
})

/** The service over the given configuration, on the process runner and the deadlines. */
export const layer = (
  config: PiAgentConfig,
): Layer.Layer<PiAgent, never, ProcessRunner | Deadlines> =>
  Layer.effect(PiAgent, make(config))
