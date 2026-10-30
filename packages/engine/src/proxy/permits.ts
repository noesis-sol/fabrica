import { Context, Effect, Layer, type Option, type Scope } from 'effect'

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
}

export class Permits extends Context.Service<Permits, PermitsShape>()(
  '@fabrica/engine/proxy/Permits',
) {}

/** Permits for every call at once: no hold, no cap, no budget. */
export const layerOpen: Layer.Layer<Permits> = Layer.succeed(Permits)(
  Permits.of({ take: () => Effect.void }),
)
