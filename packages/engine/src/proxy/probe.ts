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

/** The question every probe asks, as short as an answer can be. */
const question = 'Say OK.'

const json = (path: string, body: unknown): ProbeRequest => ({
  path,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

/** The smallest call to `model` in `api`: one token of answer, where the API takes so few. */
export const probeRequest = (api: ModelApi, model: ModelName): ProbeRequest => {
  switch (api) {
    case 'anthropic-messages':
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
      // The Responses API takes no fewer than 16 output tokens.
      return json('/responses', {
        model,
        input: question,
        max_output_tokens: 16,
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
