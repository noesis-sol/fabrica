import { Data, Duration, Effect, Option, Redacted } from 'effect'

import type { AuthInteraction, Credential } from '@earendil-works/pi-ai'
import {
  ModelsError,
  type Provider,
  createModels,
} from '@earendil-works/pi-ai/models'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter'
import type { ProviderName } from '@fabrica/contracts'

import { type SecretsShape, oauthStore } from '../secrets'

// A subscription's sign-in and its token (spec §12.9, §20.3, H26, H29): `pi-ai` runs both, with the
// engine's secret store as its credential store. The proxy asks for a subscription's token on each call;
// `pi-ai` refreshes it when under five minutes are left, in its store's `modify`, under the credential's
// lock, checking again once it holds it: agents sharing an account wait for one refresh and use its token,
// and it is written back before the lock goes. A refresh that fails keeps the credential, for the next
// call to try again, and says only that it failed: what `pi-ai` says of it can quote the provider's answer.
//
// What an agent's Pi is given differs per provider, as the providers spike and fab-mgi.11 found: Pi builds
// a subscription's request where its key is of that kind, and the proxy swaps only the token.

/** The subscription's token could not be had; nothing of the provider's answer is in it. */
export class RefreshFailed extends Data.TaggedError('RefreshFailed')<{
  readonly reason: string
}> {
  override get message() {
    return this.reason
  }
}

/** The sign-in `credentials.login` ran failed. */
export class SignInFailed extends Data.TaggedError('SignInFailed')<{
  readonly reason: string
}> {
  override get message() {
    return this.reason
  }
}

/** The providers signed in to through `pi-ai` (§20.3), as it gives them. */
export const subscriptionProviders = (): ReadonlyArray<Provider> => [
  anthropicProvider(),
  openaiProvider(),
  githubCopilotProvider(),
  openrouterProvider(),
]

/** What the proxy sends for a subscription's call: its token, and what else `pi-ai` derives from it. */
export interface SubscriptionAuth {
  readonly token: Option.Option<Redacted.Redacted<string>>
  /** The account's own base URL, where the provider gives each one its own (GitHub Copilot's). */
  readonly baseUrl: Option.Option<string>
  readonly headers: Readonly<Record<string, string>>
}

/** Keeps a header's value where `pi-ai` gives one: null takes a header away, and the proxy adds none. */
const presentHeaders = (
  headers: Readonly<Record<string, string | null>> | undefined,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(headers ?? {}).flatMap(([name, value]) =>
      value === null ? [] : [[name.toLowerCase(), value]],
    ),
  )

/** No ambient source of a credential: the engine's own secret store is the only one (§12.1). */
const noAmbient = {
  env: () => Promise.resolve(undefined),
  fileExists: () => Promise.resolve(false),
}

/** Sign-ins and their tokens, kept in `secrets`, over `providers`. */
export const makeSubscriptions = (options: {
  readonly secrets: SecretsShape
  readonly providers: ReadonlyArray<Provider>
}) => {
  const models = createModels({
    credentials: oauthStore(options.secrets),
    authContext: noAmbient,
  })
  options.providers.forEach(provider => models.setProvider(provider))
  return {
    /** Whether `provider` has a sign-in. */
    signsIn: (provider: ProviderName): boolean =>
      models.getProvider(provider)?.auth.oauth !== undefined,
    /** Runs `provider`'s sign-in, asking and telling through `interaction`, and keeps its credential. */
    login: (
      provider: ProviderName,
      interaction: AuthInteraction,
    ): Effect.Effect<Credential, SignInFailed> =>
      Effect.tryPromise({
        try: () =>
          models.login(provider, 'oauth', interaction, {
            agentName: 'Fabrica',
          }),
        catch: error =>
          new SignInFailed({
            reason:
              error instanceof Error && error.message.trim() !== ''
                ? error.message
                : 'the sign-in failed',
          }),
      }),
    /** The subscription's current token, refreshed first where it expires within `validFor` (or five minutes). */
    current: (
      provider: ProviderName,
      validFor?: Duration.Duration,
    ): Effect.Effect<SubscriptionAuth, RefreshFailed> =>
      Effect.tryPromise({
        try: signal =>
          models.getAuth(provider, {
            signal,
            ...(validFor === undefined
              ? {}
              : { minOAuthValidityMs: Duration.toMillis(validFor) }),
          }),
        catch: error =>
          new RefreshFailed({
            reason:
              error instanceof ModelsError && error.code !== 'oauth'
                ? "the secret store couldn't keep the sign-in's token"
                : 'the OAuth session expired and could not be refreshed',
          }),
      }).pipe(
        Effect.flatMap(result =>
          result === undefined
            ? Effect.fail(
                new RefreshFailed({ reason: 'the sign-in is no longer kept' }),
              )
            : Effect.succeed({
                token: Option.map(
                  Option.fromUndefinedOr(result.auth.apiKey),
                  Redacted.make,
                ),
                baseUrl: Option.fromUndefinedOr(result.auth.baseUrl),
                headers: presentHeaders(result.auth.headers),
              }),
        ),
      ),
  }
}

/** The compat overrides of a ChatGPT sign-in's agent: Pi's base URL check can't tell it behind the proxy (fab-mgi.11). */
export const chatGptCompat: Readonly<Record<string, boolean>> = {
  supportsMaxOutputTokens: false,
  supportsExplicitPromptCacheMode: false,
  supportsMidConvoEffort: false,
}

/** What an agent's Pi is given for a provider reached on a subscription, with `token` its token at the proxy. */
export const subscriptionEntry = (
  provider: ProviderName,
  token: string,
): {
  readonly apiKey: string
  readonly compat?: Readonly<Record<string, boolean>>
} => {
  switch (provider) {
    // Pi builds the Claude subscription's request for a key containing this; the proxy swaps the bearer.
    case 'anthropic':
      return { apiKey: `sk-ant-oat01-${token}` }
    case 'openai':
      return { apiKey: token, compat: chatGptCompat }
    // GitHub Copilot's and OpenRouter's requests are the same either way.
    default:
      return { apiKey: token }
  }
}
