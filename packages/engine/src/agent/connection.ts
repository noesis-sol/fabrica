import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Option,
  PubSub,
  Schema,
  Scope,
  Stream,
} from 'effect'

import type { DeadlinesShape, Running } from '../process'
import { type PiCommand, cancelDialogLine, commandLine } from './commands'
import { SendFailure } from './errors'
import { splitRecords } from './framing'
import {
  DIALOG_METHODS,
  type PiEvent,
  PiRecord,
  type PiResponse,
  type SkipReason,
  readRecord,
} from './records'

// One RPC connection to a running Pi (spec §12.1, H61): commands written as JSON lines on its stdin
// and matched to their answers by `id`, every line of its stdout decoded, its events published to
// every subscriber, losing none after it subscribes. Pi's stderr is drained, so a full pipe never
// stalls it, and its end kept for a start that fails.

/** How much of the end of Pi's stderr is kept. */
const STDERR_TAIL = 8 * 1024

/** Says a skipped record, once for each kind and reason across every agent of the engine. */
export type SkipLog = (skip: {
  readonly kind: string
  readonly reason: SkipReason
}) => Effect.Effect<void>

export interface Connection {
  /** Sends a command and waits up to `limit` for its answer; a failed answer is `Refused`. */
  readonly request: (
    command: PiCommand,
    limit: Duration.Input,
  ) => Effect.Effect<PiResponse, SendFailure>
  /** Subscribes in the scope: every event Pi writes from then on, ending when Pi's stdout closes. */
  readonly events: Effect.Effect<Stream.Stream<PiEvent>, never, Scope.Scope>
  /** A subscription to the events, in the scope; `None` once Pi's stdout has closed. */
  readonly subscribe: Effect.Effect<
    Effect.Effect<Option.Option<PiEvent>>,
    never,
    Scope.Scope
  >
  /** The end of what Pi wrote on stderr. */
  readonly stderr: () => string
}

/** The fields of an answer's `data` the engine reads, or `Unreadable`. */
export const answerData = <A>(
  schema: Schema.ConstraintDecoder<A>,
  response: PiResponse,
): Effect.Effect<A, SendFailure> =>
  Exit.match(Schema.decodeUnknownExit(schema)(response.data), {
    onSuccess: data => Effect.succeed(data),
    onFailure: () => Effect.fail(SendFailure.Unreadable()),
  })

/** Connects to a started Pi; its readers run in `scope`. */
export const connect = Effect.fnUntraced(function* ({
  running,
  deadlines,
  skipped,
  scope,
}: {
  readonly running: Running
  readonly deadlines: DeadlinesShape
  readonly skipped: SkipLog
  readonly scope: Scope.Scope
}) {
  const pending = new Map<string, Deferred.Deferred<PiResponse, SendFailure>>()
  const published = yield* PubSub.unbounded<Option.Option<PiEvent>>()
  const state = { ended: false, next: 0, stderr: '' }

  const write = (line: string) =>
    Effect.mapError(running.write(line), () => SendFailure.Exited())

  const handle = (record: PiRecord): Effect.Effect<void> =>
    PiRecord.$match(record, {
      Response: ({ response }) =>
        Effect.sync(() => {
          const answer =
            response.id === undefined ? undefined : pending.get(response.id)
          if (answer !== undefined)
            Deferred.doneUnsafe(answer, Exit.succeed(response))
        }),
      UiRequest: ({ request }) =>
        DIALOG_METHODS.has(request.method)
          ? Effect.ignore(write(cancelDialogLine(request.id)))
          : Effect.void,
      Event: ({ event }) => PubSub.publish(published, Option.some(event)),
      Skipped: ({ kind, reason }) => skipped({ kind, reason }),
    })

  const ended = Effect.gen(function* () {
    state.ended = true
    for (const answer of pending.values())
      Deferred.doneUnsafe(answer, Exit.fail(SendFailure.Exited()))
    yield* PubSub.publish(published, Option.none())
  })

  yield* running.stdout.pipe(
    splitRecords,
    Stream.runForEach(line => handle(readRecord(line))),
    Effect.ensuring(ended),
    Effect.forkIn(scope),
  )
  yield* running.stderr.pipe(
    Stream.runForEach(chunk =>
      Effect.sync(() => {
        state.stderr = (
          state.stderr + Buffer.from(chunk).toString('utf8')
        ).slice(-STDERR_TAIL)
      }),
    ),
    Effect.forkIn(scope),
  )

  const request = (command: PiCommand, limit: Duration.Input) =>
    Effect.suspend(() => {
      if (state.ended) return Effect.fail(SendFailure.Exited())
      state.next += 1
      const id = String(state.next)
      const answer = Deferred.makeUnsafe<PiResponse, SendFailure>()
      pending.set(id, answer)
      const noAnswer = Effect.andThen(
        deadlines.sleep(limit),
        Effect.fail(
          SendFailure.NoAnswer({ limit: Duration.fromInputUnsafe(limit) }),
        ),
      )
      return write(commandLine({ id, command })).pipe(
        Effect.andThen(Effect.raceFirst(Deferred.await(answer), noAnswer)),
        Effect.flatMap(response =>
          response.success
            ? Effect.succeed(response)
            : Effect.fail(SendFailure.Refused({ error: response.error ?? '' })),
        ),
        Effect.ensuring(Effect.sync(() => pending.delete(id))),
      )
    })

  const subscribe = Effect.gen(function* () {
    const subscription = yield* PubSub.subscribe(published)
    // Subscribed first and then read, so an end published after this is in the subscription.
    if (state.ended) return Effect.succeed(Option.none<PiEvent>())
    return PubSub.take(subscription)
  })

  const events = Effect.map(subscribe, take =>
    Stream.fromEffectRepeat(take).pipe(
      Stream.takeWhile(Option.isSome),
      Stream.map(event => event.value),
    ),
  )

  const connection: Connection = {
    request,
    events,
    subscribe,
    stderr: () => state.stderr,
  }
  return connection
})
