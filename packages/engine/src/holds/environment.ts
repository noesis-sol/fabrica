import { Context, Data, Duration, Effect, Option } from 'effect'

import type { TicketId } from '@fabrica/contracts'

// The environment hold's count (spec §14.1, orchestra's): when several tickets in a row settle within
// minutes without claiming or changing anything, their sessions not starting among them (tutti-13bh),
// or their setups fail one after another, the run holds (`HOLD: ENVIRONMENT`), probes the machine with
// a minimal agent after `env_probe`, and goes on (`PROBE_OK`) or ends (exit 7). Each ticket's turn is
// one settle; a turn that did something ends both series, and one stopped by a closed-but-unmerged
// blocker or a refused credential (§14.6) is neither counted nor ends them. The count is a plain value,
// each settle a pure step of it; the probe is a port, so a test gives its answer.

/** Tickets in a row, idle or failing their setup, that hold the run. */
export const ENV_STRIKES = 3

/** A turn ending within this, without claiming or changing anything, is idle. */
export const QUICK_SETTLE = Duration.minutes(5)

/** `env_probe`: how long the hold waits before it probes the machine. */
export const ENV_PROBE = Duration.minutes(10)

/** How one ticket's turn counts for the environment hold. */
export type Settle = Data.TaggedEnum<{
  /** It settled within minutes without claiming or changing anything, or its session didn't start. */
  Idle: { readonly ticket: TicketId; readonly why: string }
  /** Its setup failed. */
  SetupFailed: { readonly ticket: TicketId }
  /** It did something: both series end. */
  Worked: {}
  /** A closed-but-unmerged blocker, a refused credential: neither counted nor ending a series. */
  Uncounted: {}
}>
export const Settle = Data.taggedEnum<Settle>()

/** The two series as they stand: the tickets in each, oldest first. */
export interface EnvironmentCount {
  readonly idle: ReadonlyArray<{
    readonly ticket: TicketId
    readonly why: string
  }>
  readonly setups: ReadonlyArray<TicketId>
}

export const noCount: EnvironmentCount = { idle: [], setups: [] }

/** The count after one settle. */
export const counted = (
  count: EnvironmentCount,
  settle: Settle,
): EnvironmentCount =>
  Settle.$match(settle, {
    Idle: ({ ticket, why }) => ({
      ...count,
      idle: [...count.idle, { ticket, why }],
    }),
    SetupFailed: ({ ticket }) => ({
      ...count,
      setups: [...count.setups, ticket],
    }),
    Worked: () => noCount,
    Uncounted: () => count,
  })

/** A series long enough to hold the run: why, in words, and its tickets. */
export interface Tripped {
  readonly why: string
  readonly tickets: ReadonlyArray<TicketId>
}

/** The series that holds the run, once one reaches `strikes`. */
export const tripped = (
  count: EnvironmentCount,
  strikes: number = ENV_STRIKES,
): Option.Option<Tripped> => {
  if (count.idle.length >= strikes) {
    const last = count.idle[count.idle.length - 1]
    return Option.some({
      why: `${count.idle.length} tickets in a row settled within minutes without changing anything (the last, ${last?.ticket}: ${last?.why})`,
      tickets: count.idle.map(({ ticket }) => ticket),
    })
  }
  if (count.setups.length >= strikes)
    return Option.some({
      why: `${count.setups.length} tickets' setups failed one after another`,
      tickets: count.setups,
    })
  return Option.none()
}

/** What the environment probe came to. */
export type ProbeOutcome = Data.TaggedEnum<{
  /** The minimal agent started and its model answered: `PROBE_OK`. */
  Passed: {}
  /** It didn't: the run ends, exit 7. */
  Failed: { readonly reason: string }
}>
export const ProbeOutcome = Data.taggedEnum<ProbeOutcome>()

/** The environment probe: given the run's minimal agent, what the probe came to. */
export interface EnvironmentProbeShape {
  readonly probe: (input: {
    /** The run's minimal agent: started on the project's model with one small prompt. */
    readonly agent: Effect.Effect<ProbeOutcome>
  }) => Effect.Effect<ProbeOutcome>
}

/** The environment probe: the run's minimal agent, as it is; a test gives its own answer. */
export const EnvironmentProbe = Context.Reference<EnvironmentProbeShape>(
  '@fabrica/engine/holds/EnvironmentProbe',
  { defaultValue: () => ({ probe: ({ agent }) => agent }) },
)
