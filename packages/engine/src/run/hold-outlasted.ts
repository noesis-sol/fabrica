import { Effect, Option, Ref, Stream } from 'effect'

import type { ProviderName } from '@fabrica/contracts'

import type { ModelChoice, PiEvent } from '../agent'

// A turn a hold outlasts (spec §12.9, §14.2, §14.6): a hold raised on another caller's refusal keeps a
// model call at the proxy's permit with no response head, Pi's own timeout ends the call, its retries run
// out, and its turn settles on the error with no refusal of its session's. Such a turn's last model call
// failed with its provider held during the turn; a worker's supervision and the verifier tell it by this,
// and wait for the lift to carry on. The real Pi's side of it is held in `pi-extension`'s contract suite.

/** Whether an agent's last model call ended on an error, after `event`; Pi's retries are its own to tell. */
export const callFailedAfter = (failed: boolean, event: PiEvent): boolean =>
  event.type === 'message_end' && event.message.role === 'assistant'
    ? event.message.stopReason === 'error'
    : failed

/** A provider `model`'s calls wait on among those held; any of them for Pi's own model, which isn't known. */
const heldFor = (
  model: Option.Option<ModelChoice>,
  held: ReadonlySet<ProviderName>,
): Option.Option<ProviderName> =>
  Option.fromUndefinedOr(
    [...held].find(provider =>
      Option.match(model, {
        onNone: () => true,
        onSome: choice => choice.provider === provider,
      }),
    ),
  )

/**
 * Watches `held`, the run's held providers now and each change, for as long as the scope lasts, which is
 * a turn's: the read of the provider `model`'s calls found held meanwhile, the last of them.
 */
export const watchHeldInTurn = (
  model: Option.Option<ModelChoice>,
  held: Stream.Stream<ReadonlySet<ProviderName>>,
) =>
  Effect.gen(function* () {
    const heldInTurn = yield* Ref.make(Option.none<ProviderName>())
    yield* held.pipe(
      Stream.runForEach(providers =>
        Option.match(heldFor(model, providers), {
          onNone: () => Effect.void,
          onSome: provider => Ref.set(heldInTurn, Option.some(provider)),
        }),
      ),
      Effect.forkScoped,
    )
    return Ref.get(heldInTurn)
  })

/** The held provider that outlasted a turn, from whether its last call failed and the turn's watch. */
export const outlastedBy = (
  callFailed: boolean,
  heldInTurn: Effect.Effect<Option.Option<ProviderName>>,
): Effect.Effect<Option.Option<ProviderName>> =>
  callFailed ? heldInTurn : Effect.succeedNone

/** A hold on `provider` has lifted, or wasn't on. */
export const liftOf = (
  held: Stream.Stream<ReadonlySet<ProviderName>>,
  provider: ProviderName,
): Effect.Effect<void> =>
  held.pipe(
    Stream.filter(providers => !providers.has(provider)),
    Stream.runHead,
    Effect.asVoid,
  )
