import { Context, Effect, Layer, Scope } from 'effect'

// The engine's lifetimes (spec §7.1): everything with a lifetime is a scoped resource, held in one of
// three scopes under the engine's root scope. When the root scope ends (`fabrica engine stop`,
// SIGTERM, the service manager), it ends the runs first, so they wind down while their agents and the
// clients watching them are still there, then the agents, then the servers. Whatever a run, a ticket
// or a worker holds lives in a scope of its own inside these, released when it is done (H77).

export interface EngineScopesShape {
  /** Runs, and what each holds; ended first. */
  readonly runs: Scope.Scope
  /** Agents' processes (workers, organs, talks); ended once the runs are. */
  readonly agents: Scope.Scope
  /** The RPC server and every listener; ended last, so clients see the runs wind down. */
  readonly servers: Scope.Scope
}

export class EngineScopes extends Context.Service<
  EngineScopes,
  EngineScopesShape
>()('@fabrica/engine/EngineScopes') {}

/** The three scopes, ended in order (runs, agents, servers) as the scope the layer is built in ends. */
export const engineScopesLayer = Layer.effect(
  EngineScopes,
  Effect.gen(function* () {
    const [runs, agents, servers] = yield* Effect.all([
      Scope.make(),
      Scope.make(),
      Scope.make(),
    ])
    yield* Effect.addFinalizer(exit =>
      Scope.close(runs, exit).pipe(
        Effect.andThen(Scope.close(agents, exit)),
        Effect.andThen(Scope.close(servers, exit)),
      ),
    )
    return EngineScopes.of({ runs, agents, servers })
  }),
)
