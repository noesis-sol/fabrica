import { Context, Effect, Option, Schema } from 'effect'

import {
  CheckAnswer,
  type EngineAddress,
  type EngineHost,
  FingerprintAnswer,
  InstallAnswer,
  type InstallConsent,
  KeepAnswer,
  type KnownEngine,
  KnownEnginesAnswer,
  PairAnswer,
  PairRequest,
  type TlsEndpoint,
  UbuntuInstall,
  WslSearch,
} from '@fabrica/client'

import type { EnginePortRequest } from './port'

// What the renderer may ask of the app around it (spec §7.1, §9.2, §20.1): installing the local engine
// as a login service, which main does through the bundled `fabrica service install` when the user
// chooses; checking a host, this machine, one over SSH or a WSL2 distribution, for an engine, then
// installing or updating it there with the user's consent (`@fabrica/client/install`); and, on
// Windows, finding the WSL2 distribution to run it in, or installing Ubuntu. The preload's API answers
// them in the desktop app; the renderer alone in a browser has no app around it. The app keeps the
// engines it knows (§9.1): the renderer reads them, has one kept once it reached it, and asks for a
// port to each at each attempt to connect. An engine over TLS is paired with (§9.3): the app reads the
// fingerprint its certificate presents, and takes the pairing the user agreed to, its token with it.
// What crosses is decoded, here and in the preload, with the
// schemas below and the client's.

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
  /** Looks for the WSL2 distribution to run the engine in: none where no app is around. */
  readonly findWsl: Option.Option<Effect.Effect<WslSearch>>
  /** Installs Ubuntu in WSL, as the user agreed: none where no app is around. */
  readonly installUbuntu: Option.Option<Effect.Effect<UbuntuInstall>>
  /** The engines the app knows, from its state: none where no app is around. */
  readonly knownEngines: Option.Option<Effect.Effect<KnownEnginesAnswer>>
  /** Keeps an engine among the app's known engines: none where no app is around. */
  readonly keepEngine: Option.Option<
    (engine: KnownEngine) => Effect.Effect<KeepAnswer>
  >
  /** A new port to the known engine at an address, through the connection process: none where no app is around. */
  readonly enginePort: Option.Option<
    (address: EngineAddress) => Effect.Effect<MessagePort>
  >
  /** The fingerprint the engine at an endpoint presents over TLS: none where no app is around. */
  readonly readFingerprint: Option.Option<
    (endpoint: TlsEndpoint) => Effect.Effect<FingerprintAnswer>
  >
  /** Has the app take the pairing the user agreed to: none where no app is around. */
  readonly pairEngine: Option.Option<
    (request: PairRequest) => Effect.Effect<PairAnswer>
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
  findWsl: Option.none(),
  installUbuntu: Option.none(),
  knownEngines: Option.none(),
  keepEngine: Option.none(),
  enginePort: Option.none(),
  readFingerprint: Option.none(),
  pairEngine: Option.none(),
}

const decodeInstall = Schema.decodeUnknownEffect(ServiceInstall)
const decodeCheckAnswer = Schema.decodeUnknownEffect(CheckAnswer)
const decodeInstallAnswer = Schema.decodeUnknownEffect(InstallAnswer)
const decodeWslSearch = Schema.decodeUnknownEffect(WslSearch)
const decodeUbuntuInstall = Schema.decodeUnknownEffect(UbuntuInstall)
const decodeKnownEngines = Schema.decodeUnknownEffect(KnownEnginesAnswer)
const decodeKeepAnswer = Schema.decodeUnknownEffect(KeepAnswer)
const decodeFingerprintAnswer = Schema.decodeUnknownEffect(FingerprintAnswer)
const decodePairAnswer = Schema.decodeUnknownEffect(PairAnswer)
// The pairing crosses encoded, its token as text: a Redacted doesn't survive the context bridge.
const encodePairRequest = Schema.encodeSync(PairRequest)

/** The `window.fabrica` method the preload exposes for the login service, by name. */
export const installLoginServiceMethod = 'installLoginService'

/** The `window.fabrica` methods the preload exposes for checking a host and installing its engine. */
export const checkEngineMethod = 'checkEngine'
export const installEngineMethod = 'installEngine'

/** The `window.fabrica` methods the preload exposes for finding a WSL2 distribution and installing Ubuntu. */
export const findWslMethod = 'findWsl'
export const installUbuntuMethod = 'installUbuntu'

/** The `window.fabrica` methods the preload exposes for the known engines and their ports. */
export const knownEnginesMethod = 'knownEngines'
export const keepEngineMethod = 'keepEngine'
export const connectEngineMethod = 'connectEngine'

/** The `window.fabrica` methods the preload exposes for pairing with an engine over TLS. */
export const readFingerprintMethod = 'readFingerprint'
export const pairEngineMethod = 'pairEngine'

/** Calls its listener with each known engine's port and the number of the request it answers; the function returned stops it. */
export type RemoteEnginePorts = (
  listener: (request: number, port: MessagePort) => void,
) => () => void

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
 * A new port to the known engine at an address, through `connect` (the preload's method): each request
 * numbered, its port taken from `ports` as the message carrying its number comes.
 */
const enginePortOf = (
  connect: (request: EnginePortRequest) => void,
  ports: RemoteEnginePorts,
) => {
  let requests = 0
  return (address: EngineAddress): Effect.Effect<MessagePort> =>
    Effect.callback<MessagePort>(resume => {
      requests += 1
      const asked = requests
      const stop = ports((request, port) => {
        if (request === asked) {
          stop()
          resume(Effect.succeed(port))
        }
      })
      connect({ request: asked, address })
      return Effect.sync(stop)
    })
}

/**
 * The app around `target` (the window), through what its preload exposes as `window.fabrica`; its
 * answers are decoded, and one that doesn't decode, or a call that rejects, is a failure in words. A
 * known engine's port comes from `ports`, the window's messages, where the page listens for them.
 */
export const appHostOf = (
  target: object,
  ports: Option.Option<RemoteEnginePorts> = Option.none(),
): AppHostShape => {
  const api: unknown = Reflect.get(target, 'fabrica')
  const install = methodOf(api, installLoginServiceMethod, decodeInstall)
  const check = methodOf(api, checkEngineMethod, decodeCheckAnswer)
  const installEngine = methodOf(api, installEngineMethod, decodeInstallAnswer)
  const findWsl = methodOf(api, findWslMethod, decodeWslSearch)
  const installUbuntu = methodOf(api, installUbuntuMethod, decodeUbuntuInstall)
  const known = methodOf(api, knownEnginesMethod, decodeKnownEngines)
  const keep = methodOf(api, keepEngineMethod, decodeKeepAnswer)
  const fingerprint = methodOf(
    api,
    readFingerprintMethod,
    decodeFingerprintAnswer,
  )
  const pair = methodOf(api, pairEngineMethod, decodePairAnswer)
  const connect: unknown =
    typeof api === 'object' && api !== null
      ? Reflect.get(api, connectEngineMethod)
      : undefined
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
    findWsl: Option.map(findWsl, call =>
      call([]).pipe(
        Effect.catch(reason =>
          Effect.succeed(WslSearch.cases.Unavailable.make({ reason })),
        ),
      ),
    ),
    installUbuntu: Option.map(installUbuntu, call =>
      call([]).pipe(
        Effect.catch(reason =>
          Effect.succeed(UbuntuInstall.cases.Unfinished.make({ reason })),
        ),
      ),
    ),
    knownEngines: Option.map(known, call =>
      call([]).pipe(
        Effect.catch(reason =>
          Effect.succeed(KnownEnginesAnswer.cases.Failed.make({ reason })),
        ),
      ),
    ),
    keepEngine: Option.map(
      keep,
      call => (engine: KnownEngine) =>
        call([engine]).pipe(
          Effect.catch(reason =>
            Effect.succeed(KeepAnswer.cases.Failed.make({ reason })),
          ),
        ),
    ),
    readFingerprint: Option.map(
      fingerprint,
      call => (endpoint: TlsEndpoint) =>
        call([endpoint]).pipe(
          Effect.catch(reason =>
            Effect.succeed(FingerprintAnswer.cases.Failed.make({ reason })),
          ),
        ),
    ),
    pairEngine: Option.map(
      pair,
      call => (request: PairRequest) =>
        call([encodePairRequest(request)]).pipe(
          Effect.catch(reason =>
            Effect.succeed(PairAnswer.cases.Failed.make({ reason })),
          ),
        ),
    ),
    enginePort: Option.flatMap(ports, listen =>
      typeof connect === 'function'
        ? Option.some(
            enginePortOf(
              request => Reflect.apply(connect, api, [request]),
              listen,
            ),
          )
        : Option.none(),
    ),
  }
}
