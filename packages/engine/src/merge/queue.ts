import {
  Context,
  Effect,
  Layer,
  Option,
  PubSub,
  Queue,
  Ref,
  type Scope,
  Stream,
  SynchronizedRef,
} from 'effect'

import type { MergeStep, TicketId } from '@fabrica/contracts'

import type { Checks } from '../checks'
import type { Git, Worktree, Worktrees } from '../git'
import type { WorkGraph } from '../workgraph'
import { MergeOutcome, MergeUpdate } from './outcome'
import type { MergeSetup } from './setup'
import { makeMachine } from './steps'
import { makeTrain } from './train'
import type { MergeConfig, MergeTurn } from './turn'

// The merge queue (spec §13.7, H58): an Effect `Queue` with one consumer, which takes each finished
// ticket's turn through the merge's steps, one ticket at a time, in the order they came. The line (the
// ticket merging and those waiting) has one owner and changes only by atomic transitions. What the
// merges come to is published as a stream of tagged updates. The merge train checks the ticket waiting
// first beside the merge check, and hears how each turn ended.

/** The merge queue's line: the ticket merging, and those waiting, next first. */
export interface MergeLine {
  readonly merging: Option.Option<TicketId>
  readonly waiting: ReadonlyArray<TicketId>
}

export interface MergeQueueShape {
  /**
   * Puts a finished ticket's worktree in line, behind those waiting: true, or false when the ticket is
   * in line or merging already.
   */
  readonly enqueue: (worktree: Worktree) => Effect.Effect<boolean>
  /** The ticket merging and those waiting. */
  readonly line: Effect.Effect<MergeLine>
  /** Subscribes to the updates: once it returns, every update published is on the stream until the scope closes. */
  readonly updates: Effect.Effect<
    Stream.Stream<MergeUpdate>,
    never,
    Scope.Scope
  >
}

export class MergeQueue extends Context.Service<MergeQueue, MergeQueueShape>()(
  '@fabrica/engine/MergeQueue',
) {}

/** The ticket is in the line, merging or waiting. */
const inLine = (line: Held, ticket: TicketId) =>
  Option.contains(line.merging, ticket) ||
  line.waiting.some(waiting => waiting.ticket === ticket)

/** The line as the queue holds it: the worktrees waiting, for the train to take the first's. */
interface Held {
  readonly merging: Option.Option<TicketId>
  readonly waiting: ReadonlyArray<Worktree>
}

/** The queue for one run's merges; its consumer runs until the scope closes or merging stops. */
export const make = Effect.fn('MergeQueue.make')(function* (
  config: MergeConfig,
) {
  const entries = yield* Queue.unbounded<Worktree>()
  const published = yield* PubSub.unbounded<MergeUpdate>()
  const line = yield* SynchronizedRef.make<Held>({
    merging: Option.none(),
    waiting: [],
  })
  const train = yield* makeTrain({
    depth: config.train,
    next: Effect.map(SynchronizedRef.get(line), current =>
      Option.fromUndefinedOr(current.waiting[0]),
    ),
  })
  const machine = yield* makeMachine(train)

  const publish = (update: MergeUpdate) =>
    Effect.asVoid(PubSub.publish(published, update))

  const enqueue = (worktree: Worktree) =>
    SynchronizedRef.modifyEffect(line, current =>
      inLine(current, worktree.ticket)
        ? Effect.succeed([false, current] as const)
        : Effect.as(Queue.offer(entries, worktree), [
            true,
            { ...current, waiting: [...current.waiting, worktree] },
          ] as const),
    )

  /** A ticket's turn, from its step to its outcome; interrupted, it says at which step. */
  const turnOf = Effect.fnUntraced(function* (worktree: Worktree) {
    const turn: MergeTurn = { config, worktree, publish }
    const at = yield* Ref.make<MergeStep>('enter')
    return yield* machine
      .run(turn, step => Ref.set(at, step))
      .pipe(
        Effect.onInterrupt(() =>
          Effect.flatMap(Ref.get(at), step =>
            publish(MergeUpdate.Interrupted({ ticket: worktree.ticket, step })),
          ),
        ),
      )
  })

  /** Takes the next ticket's turn: whether merging goes on after it. */
  const next = Effect.gen(function* () {
    const worktree = yield* Queue.take(entries)
    const ticket = worktree.ticket
    yield* SynchronizedRef.update(line, current => ({
      merging: Option.some(ticket),
      waiting: current.waiting.filter(waiting => waiting.ticket !== ticket),
    }))
    const outcome = yield* turnOf(worktree)
    yield* train.settle(outcome)
    yield* SynchronizedRef.update(line, current => ({
      ...current,
      merging: Option.none(),
    }))
    yield* publish(outcome)
    return !MergeOutcome.$is('Stopped')(outcome)
  })

  yield* Effect.forkScoped(
    Effect.gen(function* () {
      let goesOn = true
      while (goesOn) goesOn = yield* next
    }),
  )

  return MergeQueue.of({
    enqueue,
    line: Effect.map(SynchronizedRef.get(line), ({ merging, waiting }) => ({
      merging,
      waiting: waiting.map(worktree => worktree.ticket),
    })),
    updates: Effect.map(PubSub.subscribe(published), Stream.fromSubscription),
  })
})

/** The merge queue for a run's merges, on the services it merges with. */
export const layer = (
  config: MergeConfig,
): Layer.Layer<
  MergeQueue,
  never,
  Git | Worktrees | Checks | WorkGraph | MergeSetup
> => Layer.effect(MergeQueue, make(config))
