import { Cause, Data, Effect, Exit, Option, Redacted, Schema } from 'effect'

import type {
  Credential,
  CredentialInfo,
  CredentialStore,
  OAuthCredential,
} from '@earendil-works/pi-ai'

import type { SecretsShape } from './service'
import { Kept, SecretName } from './values'

// The engine's secret store as `pi-ai`'s `CredentialStore` (spec §20.3): `models.login` keeps a sign-in
// through it, and `models.getAuth` refreshes a token inside its `modify`. A provider's id is the name its
// credential is kept under, so a sign-in takes the place of the provider's key, and each name changes
// under its own lock in the store, so two callers, or two stores over it, never refresh the same token
// at once. It reads what is kept and runs no key's command: a key given by a command has no key to show.

const StoredOAuth = Schema.fromJsonString(
  Schema.StructWithRest(
    Schema.Struct({
      type: Schema.Literal('oauth'),
      access: Schema.String,
      refresh: Schema.String,
      expires: Schema.Number,
    }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
)
const decodeOAuth = Schema.decodeUnknownOption(StoredOAuth)

/** `pi-ai`'s credential for what is kept; none where a sign-in's text isn't one. */
const credentialOf = (kept: Kept): Option.Option<Credential> =>
  Kept.$match(kept, {
    Key: ({ key }) =>
      Option.some<Credential>({ type: 'api_key', key: Redacted.value(key) }),
    Command: () => Option.some<Credential>({ type: 'api_key' }),
    OAuth: ({ credential }) =>
      Option.map(
        decodeOAuth(Redacted.value(credential)),
        (oauth): OAuthCredential => oauth,
      ),
  })

/** What to keep for `pi-ai`'s credential, none where it holds no key to keep. */
const keptOf = (
  provider: string,
  credential: Credential,
): Option.Option<Kept> =>
  credential.type === 'oauth'
    ? Option.some(
        Kept.OAuth({
          provider,
          credential: Redacted.make(JSON.stringify(credential)),
        }),
      )
    : Option.map(Option.fromUndefinedOr(credential.key), key =>
        Kept.Key({
          key: Redacted.make(key),
          provider: Option.some(provider),
        }),
      )

/** What `pi-ai`'s change of a credential rejected with, which `modify` must reject with in turn. */
class ChangeRejected extends Data.TaggedError('ChangeRejected')<{
  readonly rejection: unknown
}> {}

/** An effect run for `pi-ai`: it rejects with the very error, as `pi-ai` tells its own errors by their class. */
const run = <A, E>(
  effect: Effect.Effect<A, E>,
  signal: AbortSignal | undefined,
): Promise<A> =>
  Effect.runPromiseExit(effect, { signal }).then(
    Exit.match({
      onSuccess: value => value,
      onFailure: cause => {
        const error = Cause.squash(cause)
        throw error instanceof ChangeRejected ? error.rejection : error
      },
    }),
  )

/** `secrets` as `pi-ai`'s credential store. */
export const oauthStore = (secrets: SecretsShape): CredentialStore => ({
  read: (providerId, options) =>
    run(
      Effect.map(secrets.read(SecretName.make(providerId)), kept =>
        Option.getOrUndefined(Option.flatMap(kept, credentialOf)),
      ),
      options?.signal,
    ),
  list: options =>
    run(
      Effect.flatMap(secrets.list, names =>
        Effect.forEach(
          names,
          name =>
            Effect.map(secrets.read(name), kept =>
              Option.match(Option.flatMap(kept, credentialOf), {
                onNone: (): ReadonlyArray<CredentialInfo> => [],
                onSome: ({ type }) => [{ providerId: name, type }],
              }),
            ),
          { concurrency: 'unbounded' },
        ),
      ).pipe(Effect.map(infos => infos.flat())),
      options?.signal,
    ),
  modify: (providerId, change, options) =>
    run(
      Effect.map(
        secrets.modify(SecretName.make(providerId), current =>
          Effect.tryPromise({
            try: () =>
              change(
                Option.getOrUndefined(Option.flatMap(current, credentialOf)),
              ),
            catch: rejection => new ChangeRejected({ rejection }),
          }).pipe(
            Effect.map(changed =>
              changed === undefined
                ? Option.none()
                : keptOf(providerId, changed),
            ),
          ),
        ),
        kept => Option.getOrUndefined(Option.flatMap(kept, credentialOf)),
      ),
      options?.signal,
    ),
  delete: (providerId, options) =>
    run(
      Effect.asVoid(secrets.remove(SecretName.make(providerId))),
      options?.signal,
    ),
})
