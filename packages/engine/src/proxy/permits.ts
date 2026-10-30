import {
  Context,
  Deferred,
  Effect,
  Layer,
  type Option,
  type Scope,
  Stream,
} from 'effect'

import type {
  ModelName,
  ProviderName,
  RunId,
  SessionId,
  TicketId,
} from '@fabrica/contracts'

// The model proxy's permits (spec §12.9): every model call takes one before the proxy reaches the
// provider, and holds it until the call's response has been read. The holds fill it in: the
// usage-limit hold (§14.2) and the credentials hold (§14.6) grant none for a held provider, the
// per-provider caps make a call wait its turn, budgets (§14.4) stop a run's calls. Taking a permit
// waits; it never refuses a call.
//
// The usage and credentials parts (§14.2, §14.6, H20, H69): each run gives the permits the providers
// its holds hold, a usage limit's or a refused credential's, as they change, for as long as it runs; a
// call of that run to a held provider waits for its permit until the provider is no longer held, or the
// run's holds are gone, so no agent of the run (a worker or an organ) spends a call finding a limit or a
// refused credential the proxy has seen already. Calls to the run's other providers, calls of other
// runs, and the proxy's probes, which take no permit, go on: a probe is how a held provider lifts.

/** Who a model call is counted to: its run, its ticket and its agent's session where it has them, and its model. */
export interface Caller {
  readonly run: RunId
  /** None for an organ's call or a probe (§16, §13.1). */
  readonly ticket: Option.Option<TicketId>
  /** None for a probe, which the proxy makes itself. */
  readonly session: Option.Option<SessionId>
  readonly model: ModelName
}

/** A model call asking for a permit. */
export interface ModelCall {
  readonly provider: ProviderName
  readonly caller: Caller
}

export interface PermitsShape {
  /** Waits for the call's permit, held until the scope closes. */
  readonly take: (call: ModelCall) => Effect.Effect<void, never, Scope.Scope>
  /**
   * For as long as the scope is open, `run`'s calls to a provider in `held`'s latest value wait for
   * their permit; `held` gives its value now, then each change.
   */
  readonly hold: (input: {
    readonly run: RunId
    readonly held: Stream.Stream<ReadonlySet<ProviderName>>
  }) => Effect.Effect<void, never, Scope.Scope>
}

export class Permits extends Context.Service<Permits, PermitsShape>()(
  '@fabrica/engine/proxy/Permits',
) {}

/** Permits for every call at once: no hold, no cap, no budget. */
export const layerOpen: Layer.Layer<Permits> = Layer.succeed(Permits)(
  Permits.of({ take: () => Effect.void, hold: () => Effect.void }),
)

/** A run's held providers, and its holds' going. */
interface Gate {
  readonly held: Stream.Stream<ReadonlySet<ProviderName>>
  readonly gone: Deferred.Deferred<void>
}

/**
 * The permits: a run's calls to a provider its holds hold (a usage limit, a refused credential) wait
 * until it isn't held.
 */
export const makePermits: Effect.Effect<PermitsShape> = Effect.sync(() => {
  const gates = new Map<RunId, Gate>()
  return {
    take: ({ provider, caller }) =>
      Effect.suspend(() => {
        const gate = gates.get(caller.run)
        if (gate === undefined) return Effect.void
        return Effect.raceFirst(
          gate.held.pipe(
            Stream.filter(held => !held.has(provider)),
            Stream.runHead,
            Effect.asVoid,
          ),
          Deferred.await(gate.gone),
        )
      }),
    hold: ({ run, held }) =>
      Effect.acquireRelease(
        Effect.map(Deferred.make<void>(), gone => {
          const gate: Gate = { held, gone }
          gates.set(run, gate)
          return gate
        }),
        gate =>
          Effect.andThen(
            Effect.sync(() => {
              if (gates.get(run) === gate) gates.delete(run)
            }),
            Deferred.succeed(gate.gone, undefined),
          ),
      ).pipe(Effect.asVoid),
  } satisfies PermitsShape
})

/** The permits of the engine's runs, as their holds give them. */
export const layerHeld: Layer.Layer<Permits> = Layer.effect(Permits)(
  Effect.map(makePermits, Permits.of),
)
