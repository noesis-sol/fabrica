import { Clock, Duration, Effect, Option, Stream } from 'effect'

import {
  type ModelName,
  type ProviderName,
  type RunId,
  type TicketId,
  formatDurationMillis,
} from '@fabrica/contracts'

import { ProbeOutcome, ProxyEvent, Refusal } from '../proxy'
import { record } from '../run/records'
import type { RunLog } from '../runlog'
import type { SecretName } from '../secrets'
import { type HoldKey, type HoldsShape, isOn } from './state'
import { modelOn } from './usage'

// The credentials hold (spec §14.6, H69): a model call of the run refused for its credential once the
// run has begun (a key the provider now rejects, an account suspended, a sign-in that couldn't be
// refreshed), a worker's or an organ's, as the model proxy sees it first-hand, holds the run for that
// provider as the usage limit does: no new tickets, no permit for that provider (`heldProviders`, for
// the proxy's permits), its running workers waiting with their hand-back clocks stopped; workers on
// other providers go on. Nothing is deferred, set aside, triaged or counted toward the environment hold
// for it. The hold lifts on evidence: the proxy probes the provider every `CREDENTIALS_PROBE`, and once a
// probe goes through, after a new sign-in or key, the hold lifts and its waiting workers are told to
// carry on. Past `credentials_wait` the hold gives up and the run ends `CREDENTIALS` (exit 2), its
// workers kept for the carry-over.

/** How often the hold probes its provider: a new sign-in or key is taken within a minute. */
export const CREDENTIALS_PROBE = Duration.minutes(1)

/** A call refused for its credential, as the hold takes it. */
export interface CredentialRefused {
  readonly provider: ProviderName
  /** The credential's name, the account the call was made as; none where the engine couldn't say. */
  readonly account: Option.Option<SecretName>
  /** What was refused and why, as the provider or the proxy said. */
  readonly reason: string
  /** The model the hold's probe calls: the refused call's, else one of the run's on its provider. */
  readonly model: Option.Option<ModelName>
  /** The ticket whose worker made the call; none for an organ's or a probe's. */
  readonly ticket: Option.Option<TicketId>
}

/**
 * Why the run holds, as its banner says it: `anthropic's credential for anthropic-key was refused
 * (<reason>); sign in again or set a new key`.
 */
export const refusedWhy = (refused: {
  readonly provider: ProviderName
  readonly account: Option.Option<SecretName>
  readonly reason: string
}): string => {
  const whose = Option.match(refused.account, {
    onNone: () => `${refused.provider}'s credential`,
    onSome: account => `${refused.provider}'s credential for ${account}`,
  })
  return `${whose} was refused (${refused.reason}); sign in again or set a new key`
}

/** A refusal in words, for a probe that didn't go through. */
const refusalWords: (refusal: Refusal) => string = Refusal.$match({
  UsageLimited: () => 'refused for its usage limit',
  RateLimited: () => 'refused for its rate limit',
  StartFailed: ({ reason }) => `refused (${reason})`,
  CredentialRefused: ({ reason }) => `refused (${reason})`,
})

export interface CredentialsHoldShape {
  /** A call of the run refused for its credential: the run holds for its provider, its probes forked. */
  readonly refused: (refused: CredentialRefused) => Effect.Effect<void>
  /**
   * A worker's turn ended on its provider refusing the credential: completes once it may carry on, at
   * once where the hold its refusal raised has lifted since and a probe goes through.
   */
  readonly waitOut: (input: {
    readonly ticket: TicketId
    readonly provider: ProviderName
    readonly account: Option.Option<SecretName>
    readonly reason: string
  }) => Effect.Effect<void>
}

/**
 * The run's credentials hold, over its holds and its records, in the scope: `events` are the model
 * proxy's, `probe` its probe of a provider's model for the run, `modelFor` the model of the run's to
 * probe a provider on where the refused call named none of it; `every` how often it probes
 * (`CREDENTIALS_PROBE`), `wait` is `credentials_wait`.
 */
export const makeCredentialsHold = Effect.fn('CredentialsHold.make')(
  function* (input: {
    readonly holds: HoldsShape
    readonly log: RunLog['Service']
    readonly run: RunId
    readonly every?: Duration.Duration
    readonly wait: Duration.Duration
    readonly events: Stream.Stream<ProxyEvent>
    readonly probe: (call: {
      readonly provider: ProviderName
      readonly model: ModelName
    }) => Effect.Effect<ProbeOutcome>
    readonly modelFor: (provider: ProviderName) => Option.Option<ModelName>
  }) {
    const { holds, log } = input
    const scope = yield* Effect.scope
    const every = input.every ?? CREDENTIALS_PROBE
    const everyWords = formatDurationMillis(Duration.toMillis(every))
    const waitWords = formatDurationMillis(Duration.toMillis(input.wait))

    const probeOf = (
      provider: ProviderName,
      model: Option.Option<ModelName>,
    ): Effect.Effect<ProbeOutcome> =>
      Option.match(model, {
        onNone: () =>
          Effect.succeed(
            ProbeOutcome.Failed({
              reason: `the run has no model on ${provider} to probe`,
            }),
          ),
        onSome: model => input.probe({ provider, model }),
      })

    /** The hold lifts for `provider`: its probe went through. */
    const lift = (provider: ProviderName) =>
      Effect.gen(function* () {
        const why = `${provider} answered the model proxy's probe`
        yield* record(log, {
          kind: 'credentials_lifted',
          provider,
          text: `${provider}'s credential is taken again: ${why}`,
        })
        yield* holds.lift({ hold: 'CREDENTIALS', provider, why })
      })

    /** The hold's probes, from its raise until one goes through or it outlasts `credentials_wait`. */
    const probing = (refused: CredentialRefused) =>
      Effect.gen(function* () {
        const { provider } = refused
        const deadline =
          (yield* Clock.currentTimeMillis) + Duration.toMillis(input.wait)
        /** What the last probe that didn't go through came to, said once until it changes. */
        let said = Option.none<string>()
        while (true) {
          const now = yield* Clock.currentTimeMillis
          const at = now + Duration.toMillis(every)
          if (at >= deadline) {
            yield* Effect.sleep(Duration.millis(Math.max(0, deadline - now)))
            yield* holds.giveUp({
              kind: 'CREDENTIALS',
              ticket: refused.ticket,
              detail: `${provider}'s credential was still refused past credentials_wait, ${waitWords}`,
            })
            return
          }
          yield* Effect.sleep(every)
          const probed = yield* probeOf(provider, refused.model)
          const what = ProbeOutcome.$match(probed, {
            Passed: () => Option.none<string>(),
            Refused: ({ refusal }) => Option.some(refusalWords(refusal)),
            Failed: ({ reason }) => Option.some(`failed (${reason})`),
          })
          if (Option.isNone(what)) return yield* lift(provider)
          if (!Option.contains(said, what.value))
            yield* record(log, {
              kind: 'info',
              text: `CREDENTIALS: the model proxy's probe of ${provider} was ${what.value}; probing again every ${everyWords}`,
            })
          said = what
        }
      })

    const refused: CredentialsHoldShape['refused'] = refused =>
      Effect.gen(function* () {
        const { provider } = refused
        const why = refusedWhy(refused)
        const raised = yield* holds.raise({
          hold: 'CREDENTIALS',
          provider,
          why,
        })
        if (!raised) return
        const by = Option.match(refused.ticket, {
          onNone: () => 'a call of the run',
          onSome: ticket => `a call of ${ticket}'s`,
        })
        yield* record(log, {
          kind: 'credentials_hold',
          provider,
          ...Option.match(refused.account, {
            onNone: () => ({}),
            onSome: account => ({ account }),
          }),
          ...Option.match(refused.ticket, {
            onNone: () => ({}),
            onSome: ticket => ({ ticket }),
          }),
          detail: refused.reason,
          text: `CREDENTIALS: ${provider} refused ${by} for its credential; the model proxy probes ${provider} every ${everyWords}, and the run ends past credentials_wait, ${waitWords}`,
        })
        yield* Effect.forkIn(probing(refused), scope)
      })

    // The proxy's events for the run: a credential refused once a call to its provider went through
    // holds it (one refused before is a start that failed, §12.9).
    yield* input.events.pipe(
      Stream.filter(event => event.caller.run === input.run),
      Stream.runForEach(event =>
        ProxyEvent.$match(event, {
          Refused: ({ provider, caller, refusal }) =>
            Refusal.$is('CredentialRefused')(refusal)
              ? refused({
                  provider,
                  account: refusal.account,
                  reason: refusal.reason,
                  model: Option.orElse(modelOn(provider, caller.model), () =>
                    input.modelFor(provider),
                  ),
                  ticket: caller.ticket,
                })
              : Effect.void,
          Used: () => Effect.void,
          Windowed: () => Effect.void,
        }),
      ),
      Effect.forkIn(scope),
    )

    return {
      refused,
      waitOut: ({ ticket, provider, account, reason }) =>
        Effect.gen(function* () {
          const key: HoldKey = { hold: 'CREDENTIALS', provider }
          if (!isOn(yield* holds.current, key)) {
            // The hold its refusal raised may have lifted since: a probe that goes through says so.
            const model = input.modelFor(provider)
            if (ProbeOutcome.$is('Passed')(yield* probeOf(provider, model)))
              return
            // The proxy's event not yet taken: the worker's refusal raises the hold.
            yield* refused({
              provider,
              account,
              reason,
              model,
              ticket: Option.some(ticket),
            })
          }
          yield* holds.lifted(key)
        }),
    } satisfies CredentialsHoldShape
  },
)
