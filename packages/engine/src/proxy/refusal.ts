import { Array, Data, DateTime, Duration, Option } from 'effect'
import type { IncomingHttpHeaders } from 'node:http'

// What a provider's refusal of a model call means for the run (spec §12.9): read by the model proxy
// from the response's status and headers, which it passes on unchanged. A quota with its reset time
// starts the usage-limit hold (§14.2); a refusal with no reset is a rate limit to back off from
// (§12.8); a credential refused is a start that failed while no call to its provider has gone through
// in the run, and the credentials hold after (§14.6).

export type Refusal = Data.TaggedEnum<{
  /** A 429 naming when a usage window resets: a subscription's session or weekly limit, a provider's quota. */
  UsageLimited: { readonly resetAt: DateTime.Utc }
  /** A 429 with no reset time: the provider's rate limit, retried after `retryAfter` where it says. */
  RateLimited: { readonly retryAfter: Option.Option<Duration.Duration> }
  /** The credential was refused, or there is none, before any call to its provider went through in the run. */
  StartFailed: { readonly reason: string }
  /** The credential was refused, or is gone, after a call to its provider went through in the run. */
  CredentialRefused: { readonly reason: string }
}>
export const Refusal = Data.taggedEnum<Refusal>()

/**
 * The headers naming when a subscription's usage window resets, in epoch seconds: Anthropic's
 * (`unified`, the window that refused), and OpenAI ChatGPT's two windows.
 */
const resetHeaders: ReadonlyArray<string> = [
  'anthropic-ratelimit-unified-reset',
  'x-codex-primary-reset-at',
  'x-codex-secondary-reset-at',
]

/** A header's one value, where it has one. */
const headerOf = (
  headers: IncomingHttpHeaders,
  name: string,
): Option.Option<string> => {
  const value = headers[name]
  return typeof value === 'string' ? Option.some(value.trim()) : Option.none()
}

const epochSeconds = (text: string): Option.Option<DateTime.Utc> =>
  /^\d+(?:\.\d+)?$/u.test(text)
    ? Option.some(DateTime.fromEpochSeconds(Number(text)))
    : Option.none()

/** The latest reset a refusal's headers name: the call waits for every window it names. */
export const resetOf = (
  headers: IncomingHttpHeaders,
): Option.Option<DateTime.Utc> =>
  Array.reduce(resetHeaders, Option.none<DateTime.Utc>(), (latest, name) =>
    Option.match(Option.flatMap(headerOf(headers, name), epochSeconds), {
      onNone: () => latest,
      onSome: reset =>
        Option.some(
          Option.match(latest, {
            onNone: () => reset,
            onSome: other => DateTime.max(other, reset),
          }),
        ),
    }),
  )

/** How long a rate limit asks to wait: `retry-after-ms`, or `retry-after` in seconds. */
export const retryAfterOf = (
  headers: IncomingHttpHeaders,
): Option.Option<Duration.Duration> => {
  const number = (text: string) =>
    /^\d+(?:\.\d+)?$/u.test(text) ? Option.some(Number(text)) : Option.none()
  return Option.orElse(
    Option.map(
      Option.flatMap(headerOf(headers, 'retry-after-ms'), number),
      Duration.millis,
    ),
    () =>
      Option.map(
        Option.flatMap(headerOf(headers, 'retry-after'), number),
        Duration.seconds,
      ),
  )
}

/** A refused credential: a start that failed until a call to its provider has gone through in the run. */
export const credentialRefusal = (options: {
  readonly wentThrough: boolean
  readonly reason: string
}): Refusal =>
  options.wentThrough
    ? Refusal.CredentialRefused({ reason: options.reason })
    : Refusal.StartFailed({ reason: options.reason })

/** What a provider's response refuses, from its status and headers; none for an answer or another failure. */
export const classify = (response: {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  /** Whether a call to the provider has gone through in the run. */
  readonly wentThrough: boolean
}): Option.Option<Refusal> => {
  if (response.status === 429)
    return Option.some(
      Option.match(resetOf(response.headers), {
        onSome: resetAt => Refusal.UsageLimited({ resetAt }),
        onNone: () =>
          Refusal.RateLimited({ retryAfter: retryAfterOf(response.headers) }),
      }),
    )
  if (response.status === 401 || response.status === 403)
    return Option.some(
      credentialRefusal({
        wentThrough: response.wentThrough,
        reason: `the provider refused the credential (HTTP ${response.status})`,
      }),
    )
  return Option.none()
}
