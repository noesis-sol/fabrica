import {
  Data,
  DateTime,
  type Duration,
  Effect,
  Option,
  Queue,
  Ref,
  Schema,
  type Scope,
  Stream,
} from 'effect'

import {
  type ModelName,
  type Resume,
  type SessionId,
  Text,
  type TicketId,
  TranscriptEntry,
  type TranscriptItem,
  WorkerAction,
} from '@fabrica/contracts'

import {
  type Agent,
  type AgentSendFailed,
  type PiEvent,
  drawMessageId,
  makeTranscriptReader,
} from '../agent'
import { type TranscriptFeed, makeTranscriptFeed } from '../transcript-feed'

// A run's workers as the maintainer reaches them (spec §8.1, §8.3, §18.3, §18.4, H59): each worker from
// its dispatch, its session and model, its latest action read from its Pi events, its transcript (kept
// for a client that shows it, and sent only to one that does), and whether it is steered. A message
// steers the worker: into its running turn, or as its next turn; it is then steered, and the engine
// sends it nothing until it is released. A message to a worker whose ticket waits to merge or merges is
// held, never sent into a session (H59), and its worker takes it as its next turn begins, a hand-back's;
// so does any message that comes while no turn runs. An interrupt aborts the running turn and steers
// the worker. A worker's turns with its agent go through `converse`, which takes the maintainer's
// turns before the engine's prompt while the worker is steered, and after it until the worker settles
// its ticket or is released.

/** What the maintainer asks of a worker, in the order asked. */
type Steer = Data.TaggedEnum<{
  Message: { readonly text: string }
  Released: {}
}>
const Steer = Data.taggedEnum<Steer>()

/** A worker as the run view shows it. */
export interface WorkerLive {
  readonly ticket: TicketId
  readonly session: SessionId
  readonly model: ModelName
  readonly startedAt: DateTime.Utc
  readonly action: Option.Option<WorkerAction>
  readonly steered: boolean
}

interface Entry {
  readonly live: WorkerLive
  /** Its agent, during a turn's session. */
  readonly agent: Option.Option<Agent>
  /** A prompt's turn runs. */
  readonly turning: boolean
}

interface Slot {
  readonly entry: Ref.Ref<Entry>
  /** The maintainer's messages and release, until a turn takes them. */
  readonly inbox: Queue.Queue<Steer>
  readonly feed: TranscriptFeed
}

/** What a message did: sent into the running turn, or held for the worker's next turn. */
export type Delivered = Data.TaggedEnum<{
  Steered: {}
  Held: {}
}>
export const Delivered = Data.taggedEnum<Delivered>()

export interface WorkerDesk {
  /** The ticket's worker, from its dispatch: a second dispatch of the ticket keeps its row and transcript. */
  readonly enter: (input: {
    readonly ticket: TicketId
    readonly session: SessionId
    readonly model: ModelName
  }) => Effect.Effect<void>
  /**
   * The worker's turns with `agent` (§18.4): while it is steered, the maintainer's first; then
   * `prompt`, the engine's, unless `settled` says its ticket is settled; then the maintainer's while it
   * is steered and its ticket isn't settled, a release sending `released`. Its events are read for its
   * action and transcript until the scope closes.
   */
  readonly converse: (input: {
    readonly ticket: TicketId
    readonly agent: Agent
    readonly prompt: string
    readonly released: string
    readonly settled: Effect.Effect<boolean>
  }) => Effect.Effect<void, AgentSendFailed, Scope.Scope>
  /** The workers, in the order dispatched. */
  readonly current: Effect.Effect<ReadonlyArray<WorkerLive>>
  /** Messages the worker; `merging` (its ticket in the merge queue) holds it. None: no such worker. */
  readonly message: (input: {
    readonly ticket: TicketId
    readonly text: string
    readonly merging: boolean
  }) => Effect.Effect<Option.Option<Delivered>>
  /** Aborts the worker's running turn and steers it; false: no such worker. */
  readonly interrupt: (ticket: TicketId) => Effect.Effect<boolean>
  /** Hands the worker back to the engine; false: no such worker. */
  readonly release: (ticket: TicketId) => Effect.Effect<boolean>
  /** The worker's transcript, as a snapshot or the patches after `resume`; none: no such worker. */
  readonly watchTranscript: (
    ticket: TicketId,
    resume: Option.Option<Resume>,
  ) => Effect.Effect<Option.Option<Stream.Stream<TranscriptItem>>>
}

/** The fields of a tool's input that say what it works on, the first one present taken. */
const mainFields = [
  'path',
  'file_path',
  'command',
  'pattern',
  'url',
  'query',
] as const

const ToolArgs = Schema.Record(Schema.String, Schema.Unknown)
const decodeArgs = Schema.decodeUnknownOption(ToolArgs)

/** The longest argument an action carries. */
const argumentLength = 200

/** A tool call's main argument: the first of `mainFields`, else its first text, on one line. */
export const mainArgument = (args: unknown): Option.Option<string> =>
  Option.flatMap(decodeArgs(args), fields => {
    const named = mainFields.map(name => fields[name])
    const texts = [...named, ...Object.values(fields)].filter(
      (value): value is string => typeof value === 'string',
    )
    return Option.filter(
      Option.fromUndefinedOr(
        texts
          .map(text => text.replace(/\s+/gu, ' ').trim())
          .find(text => text !== ''),
      ),
      Schema.is(Text),
    ).pipe(Option.map(text => text.slice(0, argumentLength)))
  })

/** The worker's action an event says it began, where it says one. */
export const actionOf = (
  event: PiEvent,
  at: DateTime.Utc,
): Option.Option<WorkerAction> =>
  event.type === 'tool_execution_start' && Schema.is(Text)(event.toolName)
    ? Option.some(
        new WorkerAction({
          tool: event.toolName,
          argument: mainArgument(event.args),
          at,
        }),
      )
    : Option.none()

/** A run's workers, none yet; transcripts cross once per `flush` (`stream_flush`), waiting in `scope`. */
export const makeWorkerDesk = Effect.fn('WorkerDesk.make')(function* (options: {
  readonly flush: Duration.Duration
  readonly scope: Scope.Scope
}) {
  const slots = yield* Ref.make<ReadonlyMap<TicketId, Slot>>(new Map())

  const slotOf = (ticket: TicketId) =>
    Effect.map(Ref.get(slots), all => Option.fromUndefinedOr(all.get(ticket)))

  /** Writes `text` into the worker's transcript as `role`'s message, sent at once. */
  const said = (slot: Slot, role: 'user' | 'engine', text: string) =>
    Effect.gen(function* () {
      yield* slot.feed.write([
        TranscriptEntry.cases.message.make({
          id: yield* drawMessageId,
          role,
          text,
          at: yield* DateTime.now,
        }),
      ])
      yield* slot.feed.flush
    })

  const steered = (slot: Slot, to: boolean) =>
    Ref.update(slot.entry, entry => ({
      ...entry,
      live: { ...entry.live, steered: to },
    }))

  const enter = Effect.fn('WorkerDesk.enter')(function* (input: {
    readonly ticket: TicketId
    readonly session: SessionId
    readonly model: ModelName
  }) {
    if (Option.isSome(yield* slotOf(input.ticket))) return
    const slot: Slot = {
      entry: yield* Ref.make<Entry>({
        live: {
          ticket: input.ticket,
          session: input.session,
          model: input.model,
          startedAt: yield* DateTime.now,
          action: Option.none(),
          steered: false,
        },
        agent: Option.none(),
        turning: false,
      }),
      inbox: yield* Queue.unbounded<Steer>(),
      feed: yield* makeTranscriptFeed({
        name: 'worker',
        flush: options.flush,
        scope: options.scope,
      }),
    }
    yield* Ref.update(slots, all => new Map(all).set(input.ticket, slot))
  })

  /** Reads the agent's events into the worker's action and transcript, in the scope. */
  const read = (slot: Slot, agent: Agent) =>
    Effect.gen(function* () {
      const events = yield* agent.events
      const reader = yield* makeTranscriptReader()
      yield* events.pipe(
        Stream.runForEach(event =>
          Effect.gen(function* () {
            const action = actionOf(event, yield* DateTime.now)
            if (Option.isSome(action))
              yield* Ref.update(slot.entry, entry => ({
                ...entry,
                live: { ...entry.live, action },
              }))
            const entries = yield* reader.read(event)
            yield* slot.feed.write(entries)
            if (entries.some(TranscriptEntry.guards.turn_end))
              yield* slot.feed.flush
          }),
        ),
        Effect.forkScoped,
      )
    })

  /** One turn of the agent on `text`. */
  const turn = (slot: Slot, agent: Agent, text: string) =>
    Effect.acquireUseRelease(
      Ref.update(slot.entry, entry => ({ ...entry, turning: true })),
      () => agent.prompt(text),
      () => Ref.update(slot.entry, entry => ({ ...entry, turning: false })),
    )

  /** Whether the maintainer has the worker: steered, or with a message waiting. */
  const theirs = (slot: Slot) =>
    Effect.gen(function* () {
      const { live } = yield* Ref.get(slot.entry)
      return live.steered || (yield* Queue.size(slot.inbox)) > 0
    })

  const converse = Effect.fn('WorkerDesk.converse')(function* (input: {
    readonly ticket: TicketId
    readonly agent: Agent
    readonly prompt: string
    readonly released: string
    readonly settled: Effect.Effect<boolean>
  }) {
    const found = yield* slotOf(input.ticket)
    if (Option.isNone(found)) {
      yield* input.agent.prompt(input.prompt)
      return
    }
    const slot = found.value
    const { agent } = input
    yield* read(slot, agent)
    yield* Effect.acquireRelease(
      Ref.update(slot.entry, entry => ({
        ...entry,
        agent: Option.some(agent),
      })),
      () =>
        Ref.update(slot.entry, entry => ({
          ...entry,
          agent: Option.none(),
          turning: false,
        })),
    )
    const open = Effect.map(input.settled, settled => !settled)
    /** The maintainer's turns while the worker is theirs; a release, `onRelease`. */
    const theirTurns = (onRelease: Effect.Effect<void, AgentSendFailed>) =>
      Effect.gen(function* () {
        while ((yield* open) && (yield* theirs(slot))) {
          const next = yield* Queue.take(slot.inbox)
          yield* Steer.$match(next, {
            Message: ({ text }) => Effect.asVoid(turn(slot, agent, text)),
            Released: () => onRelease,
          })
        }
      })
    yield* theirTurns(Effect.void)
    if (!(yield* open)) return
    yield* said(slot, 'engine', input.prompt)
    yield* turn(slot, agent, input.prompt)
    yield* theirTurns(
      Effect.gen(function* () {
        if (!(yield* open)) return
        yield* said(slot, 'engine', input.released)
        yield* turn(slot, agent, input.released)
      }),
    )
  })

  const current = Effect.flatMap(Ref.get(slots), all =>
    Effect.forEach([...all.values()], slot =>
      Effect.map(Ref.get(slot.entry), ({ live }) => live),
    ),
  )

  const message = Effect.fn('WorkerDesk.message')(function* (input: {
    readonly ticket: TicketId
    readonly text: string
    readonly merging: boolean
  }) {
    const found = yield* slotOf(input.ticket)
    if (Option.isNone(found)) return Option.none<Delivered>()
    const slot = found.value
    yield* said(slot, 'user', input.text)
    yield* steered(slot, true)
    const { agent, turning } = yield* Ref.get(slot.entry)
    if (!input.merging && turning && Option.isSome(agent)) {
      const sent = yield* agent.value.steer(input.text).pipe(
        Effect.as(true),
        Effect.catch(error =>
          Effect.as(
            Effect.logWarning(
              `the maintainer's message to ${input.ticket}'s worker waits for its next turn: ${error.message}`,
            ),
            false,
          ),
        ),
      )
      if (sent) return Option.some(Delivered.Steered())
    }
    yield* Queue.offer(slot.inbox, Steer.Message({ text: input.text }))
    return Option.some(Delivered.Held())
  })

  const interrupt = Effect.fn('WorkerDesk.interrupt')(function* (
    ticket: TicketId,
  ) {
    const found = yield* slotOf(ticket)
    if (Option.isNone(found)) return false
    const slot = found.value
    yield* steered(slot, true)
    const { agent, turning } = yield* Ref.get(slot.entry)
    if (turning && Option.isSome(agent))
      yield* agent.value.abort.pipe(
        Effect.catch(error =>
          Effect.logWarning(
            `${ticket}'s worker couldn't be interrupted: ${error.message}`,
          ),
        ),
      )
    return true
  })

  const release = Effect.fn('WorkerDesk.release')(function* (ticket: TicketId) {
    const found = yield* slotOf(ticket)
    if (Option.isNone(found)) return false
    const slot = found.value
    const was = (yield* Ref.get(slot.entry)).live.steered
    if (was) {
      yield* steered(slot, false)
      yield* Queue.offer(slot.inbox, Steer.Released())
    }
    return true
  })

  const watchTranscript = (ticket: TicketId, resume: Option.Option<Resume>) =>
    Effect.map(
      slotOf(ticket),
      Option.map(slot => slot.feed.watch(resume)),
    )

  return {
    enter,
    converse,
    current,
    message,
    interrupt,
    release,
    watchTranscript,
  } satisfies WorkerDesk
})
