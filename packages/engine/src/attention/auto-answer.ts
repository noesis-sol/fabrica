import { Duration, Effect, Exit, Fiber, Option, Scope, Semaphore } from 'effect'

import {
  type Actor,
  AutoAnswer,
  type LabelName,
  type ProjectId,
  type QuestionOption,
  type Ticket,
  type TicketId,
} from '@fabrica/contracts'

import type { AttentionShape, AutoAnswered } from '../control/ports'
import type { Deadline, Wake } from '../time'
import type { StoreFailed, WorkGraphShape } from '../workgraph'
import { isConsequential } from './consequential'

// Unattended answers (spec §15.2, H82): `--auto-answer`, or the engine's `auto_answer`, answers a run's
// questions while the maintainer is away, at once or after a wait in time awake, so one who is there
// answers first. It takes a question filed during the run, with options, neither consequential (H53)
// nor `maintainer_only`, and answers it with its recommended option, through the attention requests as
// any answer goes, so the first answer wins; a question open before the run and every permission
// request are left to the maintainer. The run looks through its questions as it looks at its tickets,
// and a question waiting to be answered keeps it from ending.

/** The label on a question `--auto-answer` answered. */
export const autoAnsweredLabel: LabelName = 'auto-answered'

/** Who the question's answer says chose it. */
export const autoAnswerer = '--auto-answer'

/** The words of an answer by `--auto-answer`, which say who chose it. */
export const autoAnswerText = (label: string): string =>
  `${label} (the recommended option, chosen by ${autoAnswerer}, not by the maintainer)`

/** The option `--auto-answer` answers the question with; none where the question is the maintainer's. */
export const optionToAnswer = (ticket: Ticket): Option.Option<QuestionOption> =>
  Option.flatMap(ticket.question, question =>
    question.maintainerOnly || isConsequential(question)
      ? Option.none()
      : Option.flatMap(question.choices, ({ options, recommended }) =>
          Option.fromUndefinedOr(options[recommended]),
        ),
  )

/** The `start` record's word on it: the wait, in ms, 0 for at once (§15.2). */
export const autoAnswerFields = (
  setting: AutoAnswer,
): { readonly auto_answer?: number } =>
  AutoAnswer.match(setting, {
    Off: () => ({}),
    AtOnce: () => ({ auto_answer: 0 }),
    After: ({ wait }) => ({ auto_answer: Math.round(Duration.toMillis(wait)) }),
  })

export interface AutoAnswers {
  /** Before a read of the ready set: takes up the questions filed since the last, and lets go of those no longer to answer. */
  readonly sweep: Effect.Effect<void, StoreFailed>
  /** Whether a question waits to be answered, or one answered since the last sweep frees what that read didn't see. */
  readonly awaited: Effect.Effect<boolean, StoreFailed>
  /** No more answers: one being given ends first. */
  readonly stop: Effect.Effect<void>
}

const off: AutoAnswers = {
  sweep: Effect.void,
  awaited: Effect.succeed(false),
  stop: Effect.void,
}

/** A run's unattended answers, as `setting` says, from the questions the work graph has now on. */
export const makeAutoAnswers = Effect.fn('AutoAnswers.make')(function* (input: {
  readonly setting: AutoAnswer
  readonly project: ProjectId
  readonly actor: Actor
  readonly graph: WorkGraphShape
  readonly attention: AttentionShape
  readonly wake: Wake['Service']
  /** Says the answer: its record. */
  readonly answered: (answered: AutoAnswered) => Effect.Effect<void>
  /** Wakes the run: an answer of its own moves the ready set without waking it. */
  readonly woken: Effect.Effect<void>
  /** Keeps a defect in giving an answer from going unseen. */
  readonly guarded: (answering: Effect.Effect<void>) => Effect.Effect<void>
}) {
  const wait = AutoAnswer.match(input.setting, {
    Off: () => Option.none<Option.Option<Duration.Duration>>(),
    AtOnce: () => Option.some(Option.none<Duration.Duration>()),
    After: ({ wait: after }) => Option.some(Option.some(after)),
  })
  if (Option.isNone(wait)) return off
  const { graph } = input
  const scope = yield* Scope.fork(yield* Effect.scope)
  // Every question there now was filed before the run; one closed now and reopened later too.
  const before = yield* graph.list({ types: ['question'] })
  /** The questions looked at, or filed before the run: each is taken up then or never, and answered once at most. */
  const seen = new Set<TicketId>(before.map(({ id }) => id))
  /** The questions waiting to be answered, each its fiber. */
  const waiting = new Map<TicketId, Fiber.Fiber<void>>()
  let answeredSince = false
  /** Guards `seen`, `waiting` and `answeredSince`. */
  const lock = yield* Semaphore.make(1)

  const answerWhenDue = (
    question: TicketId,
    due: Option.Option<Deadline>,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (Option.isSome(due)) yield* input.wake.waitUntil(due.value)
      // Once begun it ends, so a stop never leaves an answer given and not said.
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const given = yield* input.attention.autoAnswer({
            project: input.project,
            ticket: question,
            actor: input.actor,
          })
          if (Option.isSome(given)) yield* input.answered(given.value)
          // Off the list before the wake, so the look it wakes doesn't count it as waiting.
          yield* lock.withPermit(
            Effect.sync(() => {
              waiting.delete(question)
              answeredSince = true
            }),
          )
          yield* input.woken
        }),
      )
    }).pipe(input.guarded)

  /** Takes up the questions new to it, and lets go of those no longer to answer. */
  const takeUp: AutoAnswers['sweep'] = Effect.gen(function* () {
    const open = yield* graph.list({
      statuses: ['open', 'in_progress'],
      types: ['question'],
    })
    const toAnswer = new Set(
      open
        .filter(ticket => Option.isSome(optionToAnswer(ticket)))
        .map(({ id }) => id),
    )
    const dropped = yield* lock.withPermit(
      Effect.gen(function* () {
        const gone = [...waiting].filter(([id]) => !toAnswer.has(id))
        for (const [id] of gone) waiting.delete(id)
        for (const { id } of open) {
          if (seen.has(id)) continue
          // Whether it is taken is settled here: options drafted on it later leave it the maintainer's.
          seen.add(id)
          if (!toAnswer.has(id)) continue
          const due = yield* Option.match(wait.value, {
            onNone: () => Effect.succeed(Option.none<Deadline>()),
            onSome: after => Effect.asSome(input.wake.deadline(after)),
          })
          waiting.set(
            id,
            yield* answerWhenDue(id, due).pipe(Effect.forkIn(scope)),
          )
        }
        return gone.map(([, fiber]) => fiber)
      }),
    )
    // Outside the lock: an answer being given ends under it.
    yield* Fiber.interruptAll(dropped)
  })

  return {
    // Before the read: what it answered by now, the read sees. One answered after wakes the run again.
    sweep: Effect.andThen(
      lock.withPermit(
        Effect.sync(() => {
          answeredSince = false
        }),
      ),
      takeUp,
    ),
    awaited: Effect.andThen(
      takeUp,
      lock.withPermit(Effect.sync(() => answeredSince || waiting.size > 0)),
    ),
    stop: Scope.close(scope, Exit.void),
  } satisfies AutoAnswers
})
