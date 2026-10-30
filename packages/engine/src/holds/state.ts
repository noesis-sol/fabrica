import { Clock, Effect, Option, Stream, SubscriptionRef } from 'effect'

import type {
  HoldKind,
  ProviderName,
  StopKind,
  TicketId,
} from '@fabrica/contracts'

import { record } from '../run/records'
import { type RunLog, holdLiftedLine, holdLine } from '../runlog'

// The holds as one state (spec §14, H58): every reason the run takes no new tickets, each keyed by its
// kind and, where it holds for one provider, that provider, with one owner and changed only through
// atomic transitions applied to its current value. Raising one adds its key and lifting one removes its
// key alone, so lifting one never lifts another; each transition writes its `hold` record while it holds
// the state, so the stream gives raises and lifts in the order they were taken. A hold that gives up
// (the environment probe failing, a wait outlasted) is the run's stopping, kept here beside the holds.
// The banners, whether the run may take work, whether the hand-backs' clocks stop and the run's stopping
// are each derived from one snapshot of it, never kept apart.

/** One hold on: what it is, the provider it holds for, why in words and since when. */
export interface HoldOn {
  readonly hold: HoldKind
  /** The provider it holds for: the usage limit's or a refused credential's (§14.2, §14.6). */
  readonly provider: Option.Option<ProviderName>
  readonly why: string
  /** Epoch milliseconds. */
  readonly since: number
}

/** A hold that gave up: the run stops as `kind` (§13.11). */
export interface GaveUp {
  readonly kind: StopKind
  readonly ticket: Option.Option<TicketId>
  readonly detail: string
}

/** The holds as one value. */
export interface HoldsSnapshot {
  /** The holds on, in the order they were raised. */
  readonly on: ReadonlyArray<HoldOn>
  /** The first hold to give up; the run stops for it. */
  readonly gaveUp: Option.Option<GaveUp>
}

/** Which hold a raise or a lift is about: its kind and, for a provider's hold, the provider. */
export interface HoldKey {
  readonly hold: HoldKind
  readonly provider?: ProviderName
}

const sameKey = (on: HoldOn, key: HoldKey): boolean =>
  on.hold === key.hold && Option.getOrUndefined(on.provider) === key.provider

/** Whether `key`'s hold is on. */
export const isOn = (snapshot: HoldsSnapshot, key: HoldKey): boolean =>
  snapshot.on.some(on => sameKey(on, key))

/** Whether a hold of `hold`'s kind is on, for any provider. */
export const anyOn = (snapshot: HoldsSnapshot, hold: HoldKind): boolean =>
  snapshot.on.some(on => on.hold === hold)

/** The words a hold's banner names it by: `USAGE_LIMIT (anthropic)` for a provider's. */
const named = (on: HoldOn): string =>
  Option.match(on.provider, {
    onNone: () => on.hold,
    onSome: provider => `${on.hold} (${provider})`,
  })

/** The banners of the holds on, one per hold: `HOLD: ENVIRONMENT: <why>`. */
export const banners = (snapshot: HoldsSnapshot): ReadonlyArray<string> =>
  snapshot.on.map(on => `HOLD: ${named(on)}: ${on.why}`)

/**
 * Whether the hand-backs' and the workers' clocks stop (§13.7, §14.2, §14.6): while the run holds for
 * the usage limit, a refused credential or the machine's load.
 */
export const clockHeld = (snapshot: HoldsSnapshot): boolean =>
  snapshot.on.some(
    on =>
      on.hold === 'USAGE_LIMIT' ||
      on.hold === 'CREDENTIALS' ||
      on.hold === 'MACHINE',
  )

/**
 * The providers the run's holds hold (§14.2, §14.6): a usage limit's and a refused credential's. The
 * proxy grants their calls no permit.
 */
export const heldProviders = (
  snapshot: HoldsSnapshot,
): ReadonlySet<ProviderName> =>
  new Set(
    snapshot.on.flatMap(on =>
      on.hold === 'USAGE_LIMIT' || on.hold === 'CREDENTIALS'
        ? Option.toArray(on.provider)
        : [],
    ),
  )

/** The run's stopping, as the holds have it: the hold that gave up, if one did. */
export const stopping = (snapshot: HoldsSnapshot): Option.Option<GaveUp> =>
  snapshot.gaveUp

export interface HoldsShape {
  readonly current: Effect.Effect<HoldsSnapshot>
  /** The holds' value now, then each change. */
  readonly changes: Stream.Stream<HoldsSnapshot>
  /** Raises `key`'s hold for `why`, its record written: false where it was on already, unchanged. */
  readonly raise: (
    input: HoldKey & { readonly why: string },
  ) => Effect.Effect<boolean>
  /** Lifts `key`'s hold alone, its record written: false where it wasn't on. */
  readonly lift: (
    input: HoldKey & { readonly why: string },
  ) => Effect.Effect<boolean>
  /** The hold gave up: the run stops as `kind`. The first to give up stands; false for a later one. */
  readonly giveUp: (gaveUp: GaveUp) => Effect.Effect<boolean>
  /** Completes once `key`'s hold is off, or a hold has given up. */
  readonly lifted: (key: HoldKey) => Effect.Effect<void>
}

/**
 * The run's holds, none on, their records written through `log`; `running` counts the tickets whose
 * workers run on through a hold, for its line.
 */
export const makeHolds = Effect.fn('Holds.make')(function* (input: {
  readonly log: RunLog['Service']
  readonly running: Effect.Effect<number>
}) {
  const { log } = input
  const state = yield* SubscriptionRef.make<HoldsSnapshot>({
    on: [],
    gaveUp: Option.none(),
  })

  const raise: HoldsShape['raise'] = ({ why, ...key }) =>
    SubscriptionRef.modifyEffect(state, current =>
      isOn(current, key)
        ? Effect.succeed([false, current] as const)
        : Effect.gen(function* () {
            const on: HoldOn = {
              hold: key.hold,
              provider: Option.fromUndefinedOr(key.provider),
              why,
              since: yield* Clock.currentTimeMillis,
            }
            const running = yield* input.running
            yield* record(log, {
              kind: 'hold',
              hold: key.hold,
              ...(key.provider === undefined ? {} : { provider: key.provider }),
              text: holdLine({ hold: key.hold, why, running }),
            })
            return [true, { ...current, on: [...current.on, on] }] as const
          }),
    )

  const lift: HoldsShape['lift'] = ({ why, ...key }) =>
    SubscriptionRef.modifyEffect(state, current =>
      !isOn(current, key)
        ? Effect.succeed([false, current] as const)
        : Effect.as(
            record(log, {
              kind: 'hold',
              hold: key.hold,
              lifted: true,
              ...(key.provider === undefined ? {} : { provider: key.provider }),
              text: holdLiftedLine({ hold: key.hold, why }),
            }),
            [
              true,
              { ...current, on: current.on.filter(on => !sameKey(on, key)) },
            ] as const,
          ),
    )

  const giveUp: HoldsShape['giveUp'] = gaveUp =>
    SubscriptionRef.modify(state, current =>
      Option.isSome(current.gaveUp)
        ? [false, current]
        : [true, { ...current, gaveUp: Option.some(gaveUp) }],
    )

  const changes = SubscriptionRef.changes(state)

  return {
    current: SubscriptionRef.get(state),
    changes,
    raise,
    lift,
    giveUp,
    lifted: key =>
      changes.pipe(
        Stream.filter(
          snapshot => !isOn(snapshot, key) || Option.isSome(snapshot.gaveUp),
        ),
        Stream.runHead,
        Effect.asVoid,
      ),
  } satisfies HoldsShape
})
