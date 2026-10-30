import type { Tokens } from '@fabrica/contracts'

// Provider responses as their APIs stream them, for the model proxy's tests: each API's events in
// the order and shape the provider sends them (Anthropic Messages, OpenAI Responses and Chat
// Completions, Google's generateContent with `alt=sse`), cut to a short answer, with the tokens each
// reports as orchestra's four (H65).

export interface RecordedStream {
  /** The path the agent's Pi asks for, past the provider's base URL. */
  readonly path: string
  readonly contentType: string
  readonly body: string
  readonly tokens: Tokens
}

const sse = (events: ReadonlyArray<readonly [string | null, unknown]>) =>
  events
    .map(
      ([event, data]) =>
        `${event === null ? '' : `event: ${event}\n`}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`,
    )
    .join('')

export const anthropicMessages: RecordedStream = {
  path: '/v1/messages',
  contentType: 'text/event-stream; charset=utf-8',
  body: sse([
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_01XFDUDYJgAACzvnptvVoYEL',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5-20250929',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 25,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 2000,
            output_tokens: 1,
            service_tier: 'standard',
          },
        },
      },
    ],
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
    ],
    ['ping', { type: 'ping' }],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello' },
      },
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '! How can I help?' },
      },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 15 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ]),
  tokens: { input: 25, output: 15, cache_write: 100, cache_read: 2000 },
}

const response = {
  id: 'resp_68af4030592c81938ec0a5fbab4a3e9f',
  object: 'response',
  created_at: 1756315696,
  model: 'gpt-5-2025-08-07',
}

export const openaiResponses: RecordedStream = {
  path: '/responses',
  contentType: 'text/event-stream; charset=utf-8',
  body: sse([
    [
      'response.created',
      {
        type: 'response.created',
        sequence_number: 0,
        response: {
          ...response,
          status: 'in_progress',
          output: [],
          usage: null,
        },
      },
    ],
    [
      'response.output_item.added',
      {
        type: 'response.output_item.added',
        sequence_number: 1,
        output_index: 0,
        item: {
          id: 'msg_1',
          type: 'message',
          status: 'in_progress',
          content: [],
          role: 'assistant',
        },
      },
    ],
    [
      'response.output_text.delta',
      {
        type: 'response.output_text.delta',
        sequence_number: 2,
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        delta: 'Hi there',
      },
    ],
    [
      'response.completed',
      {
        type: 'response.completed',
        sequence_number: 3,
        response: {
          ...response,
          status: 'completed',
          output: [
            {
              id: 'msg_1',
              type: 'message',
              status: 'completed',
              role: 'assistant',
              content: [
                { type: 'output_text', text: 'Hi there', annotations: [] },
              ],
            },
          ],
          usage: {
            input_tokens: 1200,
            input_tokens_details: { cached_tokens: 1000 },
            output_tokens: 42,
            output_tokens_details: { reasoning_tokens: 30 },
            total_tokens: 1242,
          },
        },
      },
    ],
  ]),
  tokens: { input: 200, output: 42, cache_write: 0, cache_read: 1000 },
}

const chunk = {
  id: 'chatcmpl-C9pWQfJ3tqX3zLgN8hY2',
  object: 'chat.completion.chunk',
  created: 1756315700,
  model: 'gpt-4o-2024-08-06',
  system_fingerprint: 'fp_80956533cb',
}

export const chatCompletions: RecordedStream = {
  path: '/chat/completions',
  contentType: 'text/event-stream',
  body: sse([
    [
      null,
      {
        ...chunk,
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: '' },
            logprobs: null,
            finish_reason: null,
          },
        ],
        usage: null,
      },
    ],
    [
      null,
      {
        ...chunk,
        choices: [
          {
            index: 0,
            delta: { content: 'Hi' },
            logprobs: null,
            finish_reason: null,
          },
        ],
        usage: null,
      },
    ],
    [
      null,
      {
        ...chunk,
        choices: [
          { index: 0, delta: {}, logprobs: null, finish_reason: 'stop' },
        ],
        usage: null,
      },
    ],
    [
      null,
      {
        ...chunk,
        choices: [],
        usage: {
          prompt_tokens: 50,
          completion_tokens: 7,
          total_tokens: 57,
          prompt_tokens_details: { cached_tokens: 10, audio_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      },
    ],
    [null, '[DONE]'],
  ]),
  tokens: { input: 40, output: 7, cache_write: 0, cache_read: 10 },
}

export const googleGenerate: RecordedStream = {
  path: '/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
  contentType: 'text/event-stream',
  body: sse([
    [
      null,
      {
        candidates: [
          { content: { parts: [{ text: 'Hi' }], role: 'model' }, index: 0 },
        ],
        usageMetadata: { promptTokenCount: 30, totalTokenCount: 30 },
        modelVersion: 'gemini-2.5-pro',
        responseId: 'mJeuaLmPAvGWz7IP5qmJ4Ac',
      },
    ],
    [
      null,
      {
        candidates: [
          {
            content: { parts: [{ text: ' there' }], role: 'model' },
            finishReason: 'STOP',
            index: 0,
          },
        ],
        usageMetadata: {
          promptTokenCount: 30,
          candidatesTokenCount: 5,
          thoughtsTokenCount: 12,
          cachedContentTokenCount: 8,
          totalTokenCount: 47,
        },
        modelVersion: 'gemini-2.5-pro',
        responseId: 'mJeuaLmPAvGWz7IP5qmJ4Ac',
      },
    ],
  ]),
  tokens: { input: 22, output: 17, cache_write: 0, cache_read: 8 },
}

/** Anthropic's whole answer to a call that doesn't stream, as JSON: the probe's, and a gzipped answer's. */
export const anthropicAnswer = {
  contentType: 'application/json',
  body: JSON.stringify({
    id: 'msg_013Zva2CMHLNnXjNJJKqJ2EF',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-5-20250929',
    content: [{ type: 'text', text: 'OK' }],
    stop_reason: 'max_tokens',
    stop_sequence: null,
    usage: {
      input_tokens: 11,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 1,
    },
  }),
  tokens: { input: 11, output: 1, cache_write: 0, cache_read: 0 },
}

/** Anthropic's refusal of a subscription's call past its five-hour window, and the window's reset. */
export const anthropicUsageLimit = {
  reset: 1761840000,
  body: JSON.stringify({
    type: 'error',
    error: {
      type: 'rate_limit_error',
      message:
        "This request would exceed your account's rate limit. Please try again later.",
    },
  }),
}

/** Anthropic's refusal of a key it doesn't take. */
export const anthropicBadKey = JSON.stringify({
  type: 'error',
  error: { type: 'authentication_error', message: 'invalid x-api-key' },
})
