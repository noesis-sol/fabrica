import { Data, Duration, Effect, Option, Redacted, Ref, Stream } from 'effect'

import {
  type HoldKind,
  type ProviderName,
  type RunId,
  SessionId,
  TicketId,
  formatDurationMillis,
} from '@fabrica/contracts'

import { type ModelChoice, PiAgent } from '../agent'
import {
  ENV_PROBE,
  type EnvironmentCount,
  EnvironmentProbe,
  type HoldsShape,
  type HoldsSnapshot,
  ProbeOutcome,
  Settle,
  type Tripped,
  type UsageHoldShape,
  anyOn,
  clockHeld,
  counted,
  noCount,
  tripped,
} from '../holds'
import type { HandBackClockShape } from '../merge/handbacks'
import { ModelProxy, ProxyEvent } from '../proxy'
import type { RunLog } from '../runlog'
import { drawBase36 } from '../workgraph/ids'
import type { RunConfig } from './config'
import { record } from './records'
import type { SupervisorHolds } from './supervisor'
import { WorkerEnd } from './worker'

// The run's side of its holds (spec §14, §14.1, H58): whether the run may take work, one snapshot of
// plain values read once per look; the hand-backs' and workers' clock, stopped while the holds say so;
// the supervisor's trouble routed to the holds; and the environment hold, counting each ticket's turn,
// holding the run when a series trips, putting its tickets back to wait for the probe, and after
// `env_probe` probing the machine with a minimal agent: `PROBE_OK` lifts the environment hold alone,
// a failed probe gives up, and the run stops `ENVIRONMENT` (exit 7). The probe runs apart from the
// question whether the run may take work, which has no side effects.

export type MayTake = Data.TaggedEnum<{
  Yes: {}
  /** A hold: no new tickets until it lifts. */
  Held: { readonly hold: HoldKind; readonly why: string }
}>
export const MayTake = Data.taggedEnum<MayTake>()

/** What a look reads once to decide whether the run may take work. */
export interface TakeSnapshot {
  readonly holds: HoldsSnapshot
  readonly draining: boolean
}

/** Whether the run may dispatch, as its holds and its drain stand: the first hold raised says why not. */
export const mayTake = (snapshot: TakeSnapshot): MayTake => {
  const [first] = snapshot.holds.on
  if (first !== undefined)
    return MayTake.Held({ hold: first.hold, why: first.why })
  if (snapshot.draining)
    return MayTake.Held({
      hold: 'DRAIN',
      why: 'no new tickets; the running ones finish and merge',
    })
  return MayTake.Yes()
}

/** Whether the run waits on a hold that can lift, rather than ending with nothing in progress. */
export const waitsOnHold = (holds: HoldsSnapshot): boolean =>
  holds.on.length > 0 && Option.isNone(holds.gaveUp)

/** The clock of the run's hand-backs and workers: `sleep`'s, held while the holds stop it (§13.7). */
export const heldClock = (
  holds: HoldsShape,
  sleep: HandBackClockShape['sleep'],
): HandBackClockShape => ({
  sleep,
  held: holds.changes.pipe(Stream.map(clockHeld), Stream.changes),
})

/**
 * How a ticket's turn, ended as `end`, counts for the environment hold (§14.1): `quick` when it ended
 * within minutes of its dispatch, `changed` when its branch or worktree has changes, `providerHeld`
 * while a usage limit or a refused credential holds the run. A start failure is the supervisor's to
 * count, once no model is left; a wait for another ticket (a closed-but-unmerged blocker among them)
 * and a tool's defect in the engine aren't counted.
 */
export const settleOf = (input: {
  readonly ticket: TicketId
  readonly end: WorkerEnd
  readonly quick: boolean
  readonly changed: boolean
  readonly providerHeld: boolean
}): Settle =>
  WorkerEnd.$match(input.end, {
    Finished: () => Settle.Worked(),
    Deferred: () => Settle.Worked(),
    Asked: () => Settle.Worked(),
    SetAside: () => Settle.Worked(),
    WaitsFor: () => Settle.Uncounted(),
    ToolFailed: () => Settle.Uncounted(),
    NotStarted: () => Settle.Uncounted(),
    Failed: () => Settle.Uncounted(),
    SetupFailed: () => Settle.SetupFailed({ ticket: input.ticket }),
    Unfinished: () =>
      input.providerHeld
        ? Settle.Uncounted()
        : input.quick && !input.changed
          ? Settle.Idle({
              ticket: input.ticket,
              why: 'its worker settled with no outcome and no change',
            })
          : Settle.Worked(),
  })

/** Whether the holds hold the run for a provider's trouble: a usage limit or a refused credential. */
export const providerHeld = (holds: HoldsSnapshot): boolean =>
  anyOn(holds, 'USAGE_LIMIT') || anyOn(holds, 'CREDENTIALS')

/** The environment hold, as the run counts its tickets' turns into it. */
export interface EnvironmentHoldShape {
  /** One ticket's turn, counted; where a series trips, the run holds and its probe is forked. */
  readonly settled: (settle: Settle) => Effect.Effect<void>
}

/**
 * The run's environment hold (§14.1), its probe forked in the scope: `reopen` puts a series' tickets
 * back to wait for the probe; `probed` frees the tickets waiting for it once it passes.
 */
export const makeEnvironmentHold = Effect.fn('EnvironmentHold.make')(
  function* (input: {
    readonly holds: HoldsShape
    readonly log: RunLog['Service']
    /** Waits in time awake, as the hand-backs' clock does. */
    readonly sleep: (duration: Duration.Duration) => Effect.Effect<void>
    /** The run's minimal agent. */
    readonly agent: Effect.Effect<ProbeOutcome>
    readonly reopen: (tickets: ReadonlyArray<TicketId>) => Effect.Effect<void>
    readonly probed: Effect.Effect<void>
    readonly probeAfter?: Duration.Duration
  }) {
    const { holds, log } = input
    const probeAfter = input.probeAfter ?? ENV_PROBE
    const probe = yield* EnvironmentProbe
    const count = yield* Ref.make<EnvironmentCount>(noCount)
    const scope = yield* Effect.scope

    const probing = Effect.gen(function* () {
      yield* input.sleep(probeAfter)
      const outcome = yield* probe.probe({ agent: input.agent })
      yield* ProbeOutcome.$match(outcome, {
        Passed: () =>
          Effect.gen(function* () {
            yield* record(log, { kind: 'probed', text: 'PROBE_OK' })
            // Its tickets are freed while it still holds, so the run never sees it lifted with none.
            yield* input.probed
            yield* holds.lift({
              hold: 'ENVIRONMENT',
              why: "PROBE_OK: the probe's agent started and its model answered",
            })
          }),
        Failed: ({ reason }) =>
          Effect.asVoid(
            holds.giveUp({
              kind: 'ENVIRONMENT',
              ticket: Option.none(),
              detail: `the environment probe failed: ${reason}`,
            }),
          ),
      })
    })

    /** The series tripped: the run holds, its tickets wait for the probe, which runs after `env_probe`. */
    const hold = (trip: Tripped) =>
      Effect.gen(function* () {
        const raised = yield* holds.raise({
          hold: 'ENVIRONMENT',
          why: `${trip.why}; probing the machine in ${formatDurationMillis(Duration.toMillis(probeAfter))}`,
        })
        yield* input.reopen(trip.tickets)
        if (raised) yield* Effect.forkIn(probing, scope)
      })

    return {
      settled: settle =>
        Effect.gen(function* () {
          const on = anyOn(yield* holds.current, 'ENVIRONMENT')
          // While it holds, an idle ticket waits for the probe too, and nothing is counted.
          if (on)
            return yield* Settle.$is('Idle')(settle)
              ? input.reopen([settle.ticket])
              : Effect.void
          const trip = yield* Ref.modify(count, current => {
            const after = counted(current, settle)
            const found = tripped(after)
            return [found, Option.isSome(found) ? noCount : after]
          })
          if (Option.isSome(trip)) yield* hold(trip.value)
        }),
    } satisfies EnvironmentHoldShape
  },
)

/**
 * The supervisor's trouble routed to the holds (§14.1, §14.2, §14.6): a usage limit waits on the usage
 * hold for its provider (`usage`), which lifts on the model proxy's probe; a refused credential holds
 * the run for its provider for `retry`, each worker waiting until its hold lifts; a session that didn't
 * start is counted for the environment hold. The credentials' lift on the proxy's probe comes with its
 * hold (fab-mgi.4.13).
 */
export const supervisorHolds = (input: {
  readonly holds: HoldsShape
  readonly environment: EnvironmentHoldShape
  readonly usage: UsageHoldShape
  readonly retry: Duration.Duration
  readonly sleep: (duration: Duration.Duration) => Effect.Effect<void>
  /** Where the timed lifts run: the run's scope. */
  readonly fork: (effect: Effect.Effect<void>) => Effect.Effect<void>
}): SupervisorHolds => {
  const { holds } = input
  const waitOn = (hold: {
    readonly hold: HoldKind
    readonly provider: ProviderName
    readonly why: string
    readonly until: Duration.Duration
    readonly lifted: string
  }) =>
    Effect.gen(function* () {
      const key = { hold: hold.hold, provider: hold.provider }
      const raised = yield* holds.raise({ ...key, why: hold.why })
      if (raised)
        yield* input.fork(
          Effect.andThen(
            input.sleep(hold.until),
            holds.lift({ ...key, why: hold.lifted }),
          ),
        )
      yield* holds.lifted(key)
    })
  return {
    usageLimited: input.usage.waitOut,
    credentialRefused: ({ provider, reason }) =>
      waitOn({
        hold: 'CREDENTIALS',
        provider,
        why: `${provider}'s credential was refused (${reason})`,
        until: input.retry,
        lifted: `${formatDurationMillis(Duration.toMillis(input.retry))} waited on ${provider}'s credential`,
      }),
    startFailed: ({ ticket, reason }) =>
      input.environment.settled(
        Settle.Idle({ ticket, why: `its session didn't start: ${reason}` }),
      ),
  }
}

/** The most the minimal agent may take to start and answer. */
export const PROBE_LIMIT = Duration.minutes(2)

/** The minimal agent's one prompt. */
const PROBE_PROMPT =
  'This is a check that the machine can run an agent: reply with the single word OK, using no tools.'

/**
 * The run's minimal agent (§14.1): Pi started in the checkout on the project's model with one tool
 * and no control channel, given one small prompt. It passes once its turn settles with a call of its
 * session through the model proxy and no refusal since; within `PROBE_LIMIT`.
 */
export const minimalAgent = (input: {
  readonly config: RunConfig
  readonly run: RunId
  readonly model: Option.Option<ModelChoice>
}): Effect.Effect<ProbeOutcome, never, PiAgent | ModelProxy> =>
  Effect.gen(function* () {
    const proxy = yield* ModelProxy
    const agents = yield* PiAgent
    const random = yield* drawBase36(12)
    const ticket = TicketId.make(`probe-${random}`)
    const session = SessionId.make(`probe-${random}`)
    const answered = yield* Ref.make<Option.Option<string>>(
      Option.some('its model call never went through'),
    )
    yield* (yield* proxy.events).pipe(
      Stream.filter(event => Option.contains(event.caller.session, session)),
      Stream.runForEach(event =>
        ProxyEvent.$match(event, {
          Used: () => Ref.set(answered, Option.none()),
          Windowed: () => Effect.void,
          Refused: ({ provider, refusal }) =>
            Ref.set(
              answered,
              Option.some(`${provider} refused its call: ${refusal._tag}`),
            ),
        }),
      ),
      Effect.forkScoped,
    )
    const granted = yield* proxy.grant({
      run: input.run,
      ticket: Option.none(),
      session: Option.some(session),
      model: Option.match(input.model, {
        onNone: () => 'none',
        onSome: ({ provider, modelId }) => `${provider}/${modelId}`,
      }),
    })
    const agent = yield* agents.start({
      ticket,
      project: input.config.project,
      worktree: input.config.checkout,
      providers: Object.entries(granted.baseUrls).map(
        ([provider, baseUrl]) => ({
          provider,
          baseUrl,
        }),
      ),
      token: Redacted.value(granted.token),
      model: input.model,
      tools: Option.some(['read']),
      resume: Option.none(),
      env: {},
      projectTrusted: false,
      nice: input.config.nice,
    })
    const settled = yield* agent.prompt(PROBE_PROMPT)
    if (settled.aborted)
      return ProbeOutcome.Failed({ reason: "its agent's turn was aborted" })
    return Option.match(yield* Ref.get(answered), {
      onNone: () => ProbeOutcome.Passed(),
      onSome: reason => ProbeOutcome.Failed({ reason }),
    })
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(PROBE_LIMIT),
    Effect.map(
      Option.getOrElse(() =>
        ProbeOutcome.Failed({
          reason: `its agent didn't answer within ${formatDurationMillis(Duration.toMillis(PROBE_LIMIT))}`,
        }),
      ),
    ),
    Effect.catch(error =>
      Effect.succeed(ProbeOutcome.Failed({ reason: error.message })),
    ),
  )
