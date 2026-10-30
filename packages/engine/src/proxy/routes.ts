import { Data, Option } from 'effect'

import type { ProviderName } from '@fabrica/contracts'

import { SecretName } from '../secrets'

// Where the model proxy sends each provider's calls (spec §12.9): an agent's Pi is given
// `<proxy>/<provider>` as each provider's base URL, so a call's path names its provider first and
// the provider's own path after it. The provider API a call speaks is read from that path.

/** A provider API Pi speaks, by Pi's name for it. */
export type ModelApi =
  | 'anthropic-messages'
  | 'openai-responses'
  | 'openai-completions'
  | 'google-generative-ai'

/** How a provider takes its credential, and the credential's name in the secret store (§20.3). */
export type Authentication = Data.TaggedEnum<{
  /** The key as a header of its own: Anthropic's `x-api-key`, Google's `x-goog-api-key`. */
  Header: { readonly header: string; readonly credential: SecretName }
  /** The key as `Authorization: Bearer <key>`: OpenAI's and those speaking its APIs. */
  Bearer: { readonly credential: SecretName }
  /** No credential: a local model (Ollama, LM Studio), proxied for the accounting alone. */
  None: {}
}>
export const Authentication = Data.taggedEnum<Authentication>()

/** A provider the proxy reaches. */
export interface ProviderRoute {
  readonly provider: ProviderName
  /** The provider's base URL, as Pi's own for it: a call's path past the provider's name is appended to it. */
  readonly upstream: string
  /** The API its probe call speaks. */
  readonly api: ModelApi
  readonly authentication: Authentication
}

/** The request headers an agent's placeholder may come in, and that never reach a provider. */
export const credentialHeaders: ReadonlyArray<string> = [
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'api-key',
]

/** The providers known out of the box, each credential under the provider's own name, at Pi's base URLs. */
export const knownRoutes: ReadonlyArray<ProviderRoute> = [
  {
    provider: 'anthropic',
    upstream: 'https://api.anthropic.com',
    api: 'anthropic-messages',
    authentication: Authentication.Header({
      header: 'x-api-key',
      credential: SecretName.make('anthropic'),
    }),
  },
  {
    provider: 'openai',
    upstream: 'https://api.openai.com/v1',
    api: 'openai-responses',
    authentication: Authentication.Bearer({
      credential: SecretName.make('openai'),
    }),
  },
  {
    provider: 'google',
    upstream: 'https://generativelanguage.googleapis.com/v1beta',
    api: 'google-generative-ai',
    authentication: Authentication.Header({
      header: 'x-goog-api-key',
      credential: SecretName.make('google'),
    }),
  },
  {
    provider: 'openrouter',
    upstream: 'https://openrouter.ai/api/v1',
    api: 'openai-completions',
    authentication: Authentication.Bearer({
      credential: SecretName.make('openrouter'),
    }),
  },
  {
    provider: 'ollama',
    upstream: 'http://127.0.0.1:11434/v1',
    api: 'openai-completions',
    authentication: Authentication.None(),
  },
  {
    provider: 'lmstudio',
    upstream: 'http://127.0.0.1:1234/v1',
    api: 'openai-completions',
    authentication: Authentication.None(),
  },
]

/** A call's target: its provider, and the path (with its query) the provider is asked for. */
export interface Target {
  readonly provider: string
  readonly path: string
}

/** The provider and path a request's URL names, `/<provider>/<path>`; none where it names no provider. */
export const targetOf = (url: string): Option.Option<Target> => {
  const match = /^\/([^/?#]+)(\/[^#]*)?$/u.exec(url)
  if (match === null) return Option.none()
  const [, provider, path] = match
  return provider === undefined
    ? Option.none()
    : Option.some({ provider, path: path ?? '/' })
}

/** The provider URL a call's path is sent to: the path appended to the provider's base URL. */
export const upstreamUrl = (route: ProviderRoute, path: string): URL =>
  new URL(`${route.upstream.replace(/\/+$/u, '')}${path}`)

/** The API a call's path speaks, read from the path without its query; none for another path (listing models). */
export const apiOf = (path: string): Option.Option<ModelApi> => {
  const bare = path.split('?')[0] ?? path
  if (bare.endsWith('/messages')) return Option.some('anthropic-messages')
  if (bare.endsWith('/responses')) return Option.some('openai-responses')
  if (bare.endsWith('/chat/completions'))
    return Option.some('openai-completions')
  if (/:(stream)?generateContent$/iu.test(bare))
    return Option.some('google-generative-ai')
  return Option.none()
}
