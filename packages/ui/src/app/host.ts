import { Context, Effect, Option, Schema } from 'effect'

// What the renderer may ask of the app around it (spec §7.1, §20.1): installing the local engine as a
// login service, which main does through the bundled `fabrica service install` when the user chooses.
// The preload's API answers it in the desktop app; the renderer alone in a browser has no app around
// it. What crosses is decoded, here and in the preload, with the one schema below.

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
}

export class AppHost extends Context.Service<AppHost, AppHostShape>()(
  '@fabrica/ui/AppHost',
) {}

/** The renderer alone, in a browser: no app around it. */
export const noAppHost: AppHostShape = {
  installLoginService: Option.none(),
}

const decodeInstall = Schema.decodeUnknownEffect(ServiceInstall)

/** The `window.fabrica` method the preload exposes for the login service, by name. */
export const installLoginServiceMethod = 'installLoginService'

/**
 * The app around `target` (the window), through what its preload exposes as `window.fabrica`; its
 * answers are decoded, and one that doesn't decode, or a call that rejects, is a failure in words.
 */
export const appHostOf = (target: object): AppHostShape => {
  const api: unknown = Reflect.get(target, 'fabrica')
  const install: unknown =
    typeof api === 'object' && api !== null
      ? Reflect.get(api, installLoginServiceMethod)
      : undefined
  return typeof install === 'function'
    ? {
        installLoginService: Option.some(
          Effect.tryPromise({
            try: () => Promise.resolve(Reflect.apply(install, api, [])),
            catch: error =>
              error instanceof Error ? error.message : String(error),
          }).pipe(
            Effect.flatMap(answer =>
              decodeInstall(answer).pipe(
                Effect.mapError(error => error.message),
              ),
            ),
            Effect.catch(reason =>
              Effect.succeed(ServiceInstall.cases.Failed.make({ reason })),
            ),
          ),
        ),
      }
    : noAppHost
}
