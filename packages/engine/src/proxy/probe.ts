import { Data } from 'effect'

import type { ModelName } from '@fabrica/contracts'

import type { Refusal } from './refusal'
import type { ModelApi } from './routes'

// The model proxy's probe (spec §12.9, §13.1, §14.2, §14.6): one small call to a provider, through
// the proxy's own exchange (its credential, its reading of refusals and usage), which tells whether
// the provider takes the credential and answers now. The start checks try each key with it; the
// usage-limit and credentials holds lift when it goes through. It takes no permit: a held provider
// is what it asks about.

/** What a probe came to. */
export type ProbeOutcome = Data.TaggedEnum<{
  /** The provider answered. */
  Passed: {}
  /** The provider (or the engine, for a credential it doesn't have) refused the call. */
  Refused: { readonly refusal: Refusal }
  /** The call failed otherwise: the provider unreachable, or an answer that is neither (a 500, a 400). */
  Failed: { readonly reason: string }
}>
export const ProbeOutcome = Data.taggedEnum<ProbeOutcome>()

/** A probe's request: its path past the provider's base URL, its headers, its body. */
export interface ProbeRequest {
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/** The headers of a call on a Claude subscription, as `pi-ai` 1.4.0 sends them; the Pi contract suite holds them to it. */
export const claudeSubscriptionHeaders: Readonly<Record<string, string>> = {
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
  'user-agent': 'claude-cli/2.1.280',
  'x-app': 'cli',
}

/** The system line every call on a Claude subscription opens with, as `pi-ai` sends it. */
export const claudeSubscriptionSystem =
  "You are Claude Code, Anthropic's official CLI for Claude."

/** The question every probe asks, as short as an answer can be. */
const question = 'Say OK.'

const json = (path: string, body: unknown): ProbeRequest => ({
  path,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

/** The smallest call to `model` in `api`: one token of answer, where the API takes so few. */
export const probeRequest = (
  api: ModelApi,
  model: ModelName,
  /** Whether it is made on a subscription, whose request differs where the provider's does (§12.9). */
  subscription: boolean = false,
): ProbeRequest => {
  switch (api) {
    case 'anthropic-messages':
      if (subscription)
        return {
          ...json('/v1/messages', {
            model,
            max_tokens: 1,
            system: [{ type: 'text', text: claudeSubscriptionSystem }],
            messages: [{ role: 'user', content: question }],
          }),
          headers: {
            'content-type': 'application/json',
            ...claudeSubscriptionHeaders,
          },
        }
      return {
        ...json('/v1/messages', {
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: question }],
        }),
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
      }
    case 'openai-responses':
      // A ChatGPT sign-in refuses `max_output_tokens`; the API itself takes no fewer than 16.
      return json('/responses', {
        model,
        input: question,
        ...(subscription ? {} : { max_output_tokens: 16 }),
        store: false,
      })
    case 'openai-completions':
      return json('/chat/completions', {
        model,
        messages: [{ role: 'user', content: question }],
        max_tokens: 1,
      })
    case 'google-generative-ai':
      return json(`/models/${encodeURIComponent(model)}:generateContent`, {
        contents: [{ role: 'user', parts: [{ text: question }] }],
        generationConfig: { maxOutputTokens: 1 },
      })
  }
}
