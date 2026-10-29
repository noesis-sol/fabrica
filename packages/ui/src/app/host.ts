import { Context, Effect, Option, Schema } from 'effect'

import {
  CheckAnswer,
  type EngineHost,
  InstallAnswer,
  type InstallConsent,
} from '@fabrica/client'

// What the renderer may ask of the app around it (spec §7.1, §9.2, §20.1): installing the local engine
// as a login service, which main does through the bundled `fabrica service install` when the user
// chooses; and checking a host, this machine or one over SSH, for an engine, then installing or
// updating it there with the user's consent (`@fabrica/client/install`). The preload's API answers
// them in the desktop app; the renderer alone in a browser has no app around it. What crosses is
// decoded, here and in the preload, with the schemas below and the client's.

/** What installing the login service came to. */
export const ServiceInstall = Schema.TaggedUnion({
  Installed: {},
  Failed: { reason: Schema.String },
})
export type ServiceInstall = typeof ServiceInstall.Type

/** The app around the renderer, as Commands reach it. */
export interface AppHostShape {
  /** Installs the local engine's login service: none where no app is around the renderer. */
  readonly installLoginService: Option.Option<Effect.Effect<ServiceInstall>>
  /** Checks a host for an engine, and what installing the app's would do: none where no app is around. */
  readonly checkEngine: Option.Option<
    (host: EngineHost) => Effect.Effect<CheckAnswer>
  >
  /** Installs or updates the engine on a host, as the user agreed: none where no app is around. */
  readonly installEngine: Option.Option<
    (request: {
      readonly host: EngineHost
      readonly consent: InstallConsent
    }) => Effect.Effect<InstallAnswer>
  >
}

export class AppHost extends Context.Service<AppHost, AppHostShape>()(
  '@fabrica/ui/AppHost',
) {}

/** The renderer alone, in a browser: no app around it. */
export const noAppHost: AppHostShape = {
  installLoginService: Option.none(),
  checkEngine: Option.none(),
  installEngine: Option.none(),
}

const decodeInstall = Schema.decodeUnknownEffect(ServiceInstall)
const decodeCheckAnswer = Schema.decodeUnknownEffect(CheckAnswer)
const decodeInstallAnswer = Schema.decodeUnknownEffect(InstallAnswer)

/** The `window.fabrica` method the preload exposes for the login service, by name. */
export const installLoginServiceMethod = 'installLoginService'

/** The `window.fabrica` methods the preload exposes for checking a host and installing its engine. */
export const checkEngineMethod = 'checkEngine'
export const installEngineMethod = 'installEngine'

const failureWords = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * `api`'s method `name`, where it has one, as an Effect calling it with `args` and decoding its answer
 * with `decode`; one that rejects, or answers what doesn't decode, fails with its words.
 */
const methodOf = <A>(
  api: unknown,
  name: string,
  decode: (answer: unknown) => Effect.Effect<A, Schema.SchemaError>,
): Option.Option<
  (args: ReadonlyArray<unknown>) => Effect.Effect<A, string>
> => {
  const method: unknown =
    typeof api === 'object' && api !== null ? Reflect.get(api, name) : undefined
  return typeof method === 'function'
    ? Option.some(args =>
        Effect.tryPromise({
          try: () => Promise.resolve(Reflect.apply(method, api, [...args])),
          catch: failureWords,
        }).pipe(
          Effect.flatMap(answer =>
            decode(answer).pipe(Effect.mapError(error => error.message)),
          ),
        ),
      )
    : Option.none()
}

/**
 * The app around `target` (the window), through what its preload exposes as `window.fabrica`; its
 * answers are decoded, and one that doesn't decode, or a call that rejects, is a failure in words.
 */
export const appHostOf = (target: object): AppHostShape => {
  const api: unknown = Reflect.get(target, 'fabrica')
  const install = methodOf(api, installLoginServiceMethod, decodeInstall)
  const check = methodOf(api, checkEngineMethod, decodeCheckAnswer)
  const installEngine = methodOf(api, installEngineMethod, decodeInstallAnswer)
  return {
    installLoginService: Option.map(install, call =>
      call([]).pipe(
        Effect.catch(reason =>
          Effect.succeed(ServiceInstall.cases.Failed.make({ reason })),
        ),
      ),
    ),
    checkEngine: Option.map(
      check,
      call => (host: EngineHost) =>
        call([host]).pipe(
          Effect.catch(reason =>
            Effect.succeed(CheckAnswer.cases.Failed.make({ reason })),
          ),
        ),
    ),
    installEngine: Option.map(
      installEngine,
      call =>
        ({
          host,
          consent,
        }: {
          readonly host: EngineHost
          readonly consent: InstallConsent
        }) =>
          call([host, consent]).pipe(
            Effect.catch(reason =>
              Effect.succeed(InstallAnswer.cases.Failed.make({ reason })),
            ),
          ),
    ),
  }
}
