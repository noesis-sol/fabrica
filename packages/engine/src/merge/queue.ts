import {
  Context,
  Effect,
  FiberSet,
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
import { Git, type Worktree, type Worktrees } from '../git'
import { WorkGraph } from '../workgraph'
import {
  Awaiting,
  Followed,
  HandBackClock,
  HandBackWorker,
  follow,
  makeHandBackBook,
} from './handbacks'
import { MergeOutcome, MergeUpdate } from './outcome'
import type { MergeSetup } from './setup'
import { makeMachine } from './steps'
import { makeTrain } from './train'
import type { MergeConfig, MergeTurn } from './turn'

// The merge queue (spec §13.7, H58): an Effect `Queue` with one consumer, which takes each finished
// ticket's turn through the merge's steps, one ticket at a time, in the order they came. The line (the
// ticket merging and those waiting) has one owner and changes only by atomic transitions. What the
// merges come to is published as a stream of tagged updates. The merge train checks the ticket waiting
// first beside the merge check, and hears how each turn ended. A turn that hands its ticket back ends
// there: the hand-back follows beside the queue, which goes on with the tickets behind it, and puts the
// ticket back in line once its worker's work is taken; each merge puts the tickets set aside to be
// checked once more back in line too (`RECHECK`).

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
  const book = yield* makeHandBackBook
  const machine = yield* makeMachine(train, book)
  const git = yield* Git
  const graph = yield* WorkGraph
  const worker = yield* HandBackWorker
  const clock = yield* HandBackClock
  const handBacks = yield* FiberSet.make<void>()

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

  /** Back in line, said first so that the run hears it before the ticket's next step. */
  const requeue = (
    worktree: Worktree,
    awaiting: Awaiting,
    update: MergeUpdate,
  ) =>
    Effect.gen(function* () {
      yield* book.expect(worktree.ticket, awaiting)
      yield* publish(update)
      yield* enqueue(worktree)
    })

  /** The ticket's hand-back, given beside the queue: back in line once its work is taken, else set aside. */
  const handBack = (worktree: Worktree) =>
    Effect.gen(function* () {
      const job = yield* book.take(worktree.ticket)
      if (Option.isNone(job)) return
      const followed = yield* follow({ job: job.value, git, worker, clock })
      yield* Followed.$match(followed, {
        Requeue: ({ awaiting, detail }) =>
          requeue(
            worktree,
            awaiting,
            MergeUpdate.Requeued({
              ticket: worktree.ticket,
              for: 'hand_back',
              detail,
            }),
          ),
        SetAside: ({ reason, detail }) =>
          Effect.gen(function* () {
            const outcome = MergeOutcome.SetAside({
              ticket: worktree.ticket,
              reason,
              detail,
            })
            yield* machine
              .settle(job.value.turn, outcome)
              .pipe(
                Effect.catch(error =>
                  Effect.logWarning(
                    `Couldn't set ${worktree.ticket} aside after its hand-back`,
                    error,
                  ),
                ),
              )
            yield* publish(outcome)
          }),
      })
    })

  /** Base moved on: each ticket set aside to be checked once more goes back in line, undeferred, once in the run. */
  const recheck = Effect.gen(function* () {
    const kept = yield* book.rechecks
    yield* Effect.forEach(
      kept,
      worktree =>
        Effect.gen(function* () {
          yield* graph
            .undefer({ id: worktree.ticket, actor: config.actor })
            .pipe(
              Effect.catch(error =>
                Effect.logWarning(
                  `Couldn't undefer ${worktree.ticket} to check it once more`,
                  error,
                ),
              ),
            )
          yield* requeue(
            worktree,
            Awaiting.Recheck(),
            MergeUpdate.Requeued({
              ticket: worktree.ticket,
              for: 'recheck',
              detail: `RECHECK: ${worktree.ticket} is checked once more, as ${config.base} moved on`,
            }),
          )
        }),
      { discard: true },
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
    yield* book.turnEnded(ticket)
    yield* train.settle(outcome)
    yield* SynchronizedRef.update(line, current => ({
      ...current,
      merging: Option.none(),
    }))
    // The rechecks are said before the merge, so the run never takes their tickets for done.
    if (MergeOutcome.$is('Merged')(outcome)) yield* recheck
    yield* publish(outcome)
    if (MergeOutcome.$is('HandedBack')(outcome))
      yield* FiberSet.run(handBacks, handBack(worktree))
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
