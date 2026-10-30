import { Effect, Option, Redacted, Schema } from 'effect'

import {
  EngineAddress,
  type EngineName,
  FingerprintAnswer,
  KeepAnswer,
  type KnownEngine,
  PairAnswer,
  type PairRequest,
  type TlsEndpoint,
  tlsEndpointText,
} from '@fabrica/client'
import type { CertificateFingerprint } from '@fabrica/contracts'

import { FingerprintRead, FingerprintRequest } from '../connection/fingerprint'
import { ConnectionTarget } from '../connection/target'
import { keepEngineIn } from './known-engines'
import { knownTarget, unpaired } from './ports'
import type { AppStateShape } from './state'

type Fingerprint = typeof CertificateFingerprint.Type

// Main's part in pairing with an engine over TLS (spec §9.1, §9.3). At the first pairing the page asks
// for the fingerprint of the certificate the engine presents, which main asks of the connection
// process; once the user accepts it, the page hands main the pairing (the name, where the engine is,
// that fingerprint, the token), which main holds until the engine's first hello has the page keep it:
// then the known engine joins the app's state with its pinned fingerprint, and the token goes into
// safeStorage. Main pairs only with the fingerprint the connection process read at that address, and
// reaches a TLS engine only with the fingerprint and token of its own records, held or kept: the page
// is trusted with neither.

/** The fingerprints asked of the connection process, as main waits on their answers. */
export const makeFingerprintDesk = (post: (request: unknown) => void) => {
  let asked = 0
  const waiting = new Map<number, (answer: FingerprintAnswer) => void>()
  const decodeRead = Schema.decodeUnknownOption(FingerprintRead)
  const encodeRequest = Schema.encodeSync(FingerprintRequest)

  return {
    /** The fingerprint the engine at `endpoint` presents, as the connection process reads it. */
    read: (endpoint: TlsEndpoint): Effect.Effect<FingerprintAnswer> =>
      Effect.callback<FingerprintAnswer>(resume => {
        asked += 1
        const id = asked
        waiting.set(id, answer => resume(Effect.succeed(answer)))
        post(encodeRequest(FingerprintRequest.make({ id, endpoint })))
        return Effect.sync(() => {
          waiting.delete(id)
        })
      }),
    /** What the connection process said: a fingerprint read; anything else is dropped. */
    fromConnection: (message: unknown): void => {
      Option.map(decodeRead(message), ({ id, answer }) => {
        const give = waiting.get(id)
        if (give !== undefined) {
          waiting.delete(id)
          give(answer)
        }
      })
    },
    /** The connection process exited: the reads it held fail. */
    connectionGone: (): void => {
      const gone = [...waiting.values()]
      waiting.clear()
      for (const give of gone) {
        give(
          FingerprintAnswer.cases.Failed.make({
            reason:
              'the connection process exited before it read the engine’s certificate: try again',
          }),
        )
      }
    },
  }
}

/** Whether a TLS address is at `endpoint` with `fingerprint` pinned. */
const pinnedAt = (
  address: EngineAddress,
  endpoint: TlsEndpoint,
  fingerprint: Fingerprint,
): boolean =>
  EngineAddress.guards.Tls(address) &&
  address.host === endpoint.host &&
  address.port === endpoint.port &&
  address.fingerprint === fingerprint

/** The pairings: the fingerprints read, the pairings held until kept, and the targets of TLS engines. */
export const makePairings = ({
  state,
  read,
}: {
  readonly state: AppStateShape
  /** The fingerprint the engine at an endpoint presents, read by the connection process. */
  readonly read: (endpoint: TlsEndpoint) => Effect.Effect<FingerprintAnswer>
}) => {
  /** The fingerprint each endpoint presented when last read, by its text. */
  const presented = new Map<string, Fingerprint>()
  /** The pairings the user agreed to, by the engine's name, until each is kept. */
  const held = new Map<EngineName, PairRequest>()

  const failed = (reason: string): PairAnswer =>
    PairAnswer.cases.Failed.make({ reason })

  /** The fingerprint the engine at `endpoint` presents, remembered for the pairing that follows. */
  const readFingerprint = (endpoint: TlsEndpoint) =>
    read(endpoint).pipe(
      Effect.tap(answer =>
        Effect.sync(() =>
          FingerprintAnswer.match(answer, {
            Presented: ({ fingerprint }): void => {
              presented.set(tlsEndpointText(endpoint), fingerprint)
            },
            Failed: (): void => {
              presented.delete(tlsEndpointText(endpoint))
            },
          }),
        ),
      ),
      Effect.withSpan('Pairing.readFingerprint'),
    )

  /**
   * Holds the pairing the user agreed to, where its fingerprint is the one read and a token can be
   * kept. One for an engine the state knows already with that certificate (paired again, as its token
   * was refused) has its new token kept at once: the page, its engine kept, keeps it no more.
   */
  const pair = (request: PairRequest): Effect.Effect<PairAnswer> =>
    Effect.gen(function* () {
      const at = tlsEndpointText(request.endpoint)
      if (presented.get(at) !== request.fingerprint) {
        return failed(
          `${request.fingerprint} isn't the fingerprint the engine at ${at} presented: read its certificate again`,
        )
      }
      yield* state.secretsReady
      const known = yield* state.engines
      if (
        known.some(
          engine =>
            engine.name === request.name &&
            pinnedAt(engine.address, request.endpoint, request.fingerprint),
        )
      ) {
        yield* state.saveToken({ engine: request.name, token: request.token })
      }
      held.set(request.name, request)
      return PairAnswer.cases.Paired.make({})
    }).pipe(
      Effect.catchTags({
        NoSecretStorage: ({ reason }) =>
          Effect.succeed(
            failed(`the app can't keep the pairing token: ${reason}`),
          ),
        AppStateFailed: ({ reason }) =>
          Effect.succeed(
            failed(`the app can't keep the pairing token: ${reason}`),
          ),
        EngineUnknown: ({ name }) =>
          Effect.succeed(failed(`the app's state knows no engine ${name}`)),
      }),
      Effect.withSpan('Pairing.pair'),
    )

  /**
   * Keeps `engine` in the app's state; one over TLS only as it was paired, its token kept with it, or
   * as the state knows it already (its engine updated since).
   */
  const keep = (engine: KnownEngine): Effect.Effect<KeepAnswer> =>
    EngineAddress.match(engine.address, {
      Local: () => keepEngineIn(state, engine),
      Ssh: () => keepEngineIn(state, engine),
      Wsl: () => keepEngineIn(state, engine),
      Tls: ({ host, port, fingerprint }) =>
        Effect.gen(function* () {
          const endpoint = { host, port }
          const pairing = Option.filter(
            Option.fromUndefinedOr(held.get(engine.name)),
            request =>
              pinnedAt(engine.address, request.endpoint, request.fingerprint),
          )
          if (Option.isSome(pairing)) {
            const answer = yield* keepEngineIn(state, engine)
            if (KeepAnswer.guards.Failed(answer)) return answer
            const tokenFailed = (reason: string) =>
              Effect.succeed(
                failedKeep(`couldn't keep its pairing token: ${reason}`),
              )
            return yield* state
              .saveToken({ engine: engine.name, token: pairing.value.token })
              .pipe(
                Effect.map(() => {
                  held.delete(engine.name)
                  return answer
                }),
                Effect.catchTags({
                  AppStateFailed: ({ reason }) => tokenFailed(reason),
                  NoSecretStorage: ({ reason }) => tokenFailed(reason),
                  EngineUnknown: ({ name }) =>
                    tokenFailed(`the app's state knows no engine ${name}`),
                }),
              )
          }
          const known = yield* state.engines.pipe(
            Effect.map(engines =>
              engines.some(
                kept =>
                  kept.name === engine.name &&
                  pinnedAt(kept.address, endpoint, fingerprint),
              ),
            ),
            Effect.orElseSucceed(() => false),
          )
          return known
            ? yield* keepEngineIn(state, engine)
            : failedKeep(unpaired(endpoint))
        }).pipe(Effect.withSpan('Pairing.keep')),
    })

  /**
   * The connection process's target for a known engine at `address`, `local` for this machine's: one
   * over TLS with the token held or kept for its endpoint and pinned fingerprint, or refused, saying why.
   */
  const target = (
    address: EngineAddress,
    local: ConnectionTarget,
  ): Effect.Effect<ConnectionTarget> =>
    EngineAddress.match(address, {
      Local: () => Effect.succeed(knownTarget(address, local)),
      Ssh: () => Effect.succeed(knownTarget(address, local)),
      Wsl: () => Effect.succeed(knownTarget(address, local)),
      Tls: ({ host, port, fingerprint }) =>
        Effect.gen(function* () {
          const endpoint = { host, port }
          const tlsTarget = (token: Redacted.Redacted<string>) =>
            ConnectionTarget.cases.Tls.make({ host, port, fingerprint, token })
          const pairing = [...held.values()].find(request =>
            pinnedAt(address, request.endpoint, request.fingerprint),
          )
          if (pairing !== undefined) return tlsTarget(pairing.token)
          const engines = yield* state.engines
          const kept = engines.find(engine =>
            pinnedAt(engine.address, endpoint, fingerprint),
          )
          if (kept === undefined) return refused(unpaired(endpoint))
          const token = yield* state.token(kept.name)
          return Option.match(token, {
            onNone: () =>
              refused(
                `no pairing token is kept for ${kept.name}: add it again with a pairing token`,
              ),
            onSome: tlsTarget,
          })
        }).pipe(
          Effect.catch(error =>
            Effect.succeed(
              refused(
                `the pairing token of the engine at ${tlsEndpointText({ host, port })} couldn't be read: ${error.reason}`,
              ),
            ),
          ),
          Effect.withSpan('Pairing.target'),
        ),
    })

  return { readFingerprint, pair, keep, target }
}

const refused = (reason: string): ConnectionTarget =>
  ConnectionTarget.cases.Refused.make({ reason })

const failedKeep = (reason: string): KeepAnswer =>
  KeepAnswer.cases.Failed.make({ reason })
