import { DateTime, Duration, Effect, Option, Redacted, Stream } from 'effect'
import {
  type IncomingHttpHeaders,
  createServer,
  request as httpRequest,
} from 'node:http'
import { gzipSync } from 'node:zlib'

import { describe, expect, it } from '@effect/vitest'
import { RunId, SessionId, TicketId } from '@fabrica/contracts'

import {
  Authentication,
  type Caller,
  ProbeOutcome,
  type ProviderRoute,
  ProxyEvent,
  Refusal,
  layerOpen,
  make,
} from '../src/proxy'
import { SecretMissing, SecretName, Secrets } from '../src/secrets'
import {
  type RecordedStream,
  anthropicAnswer,
  anthropicBadKey,
  anthropicMessages,
  anthropicUsageLimit,
  chatCompletions,
  googleGenerate,
  openaiResponses,
} from './proxy-streams'

// The model proxy (spec §12.9): recorded provider streams pass through it unchanged, each API's
// usage counted to the token's caller; refusals read as the run's holds read them (a 429 with and
// without a reset, a key refused before and after a call went through); a token it didn't grant, or
// one revoked, refused; the probe. The providers are a loopback server answering as they do.

/** What the provider was asked. */
interface Seen {
  readonly method: string
  readonly url: string
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

/** What the provider answers. */
interface Answer {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: string | Buffer
}

/** A loopback provider: it answers each call with `answer`, its body written in pieces, and keeps what it was asked. */
const fakeProvider = (answer: (seen: Seen) => Answer) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly url: string
      readonly seen: Array<Seen>
      readonly close: () => void
    }>(resume => {
      const seen: Array<Seen> = []
      const server = createServer((request, response) => {
        const chunks: Array<Buffer> = []
        request.on('data', (chunk: Buffer) => chunks.push(chunk))
        request.on('end', () => {
          const asked: Seen = {
            method: request.method ?? '',
            url: request.url ?? '',
            headers: request.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }
          seen.push(asked)
          const { status, headers, body } = answer(asked)
          const bytes = Buffer.from(body)
          response.writeHead(status, headers)
          // Three pieces, cut mid-line, as a stream arrives.
          const third = Math.ceil(bytes.length / 3)
          response.write(bytes.subarray(0, third))
          response.write(bytes.subarray(third, 2 * third))
          response.end(bytes.subarray(2 * third))
        })
      })
      server.listen({ host: '127.0.0.1', port: 0 }, () => {
        const address = server.address()
        const port =
          typeof address === 'object' && address !== null ? address.port : 0
        resume(
          Effect.succeed({
            url: `http://127.0.0.1:${port}`,
            seen,
            close: () => {
              server.close()
              server.closeAllConnections()
            },
          }),
        )
      })
    }),
    provider => Effect.sync(provider.close),
  )

/** The provider's credentials, as the secret store keeps them. */
const keys: Record<string, string> = {
  anthropic: 'sk-ant-api03-real-anthropic-key',
  openai: 'sk-proj-real-openai-key',
  google: 'AIza-real-google-key',
}

const secrets = Secrets.of({
  store: 'file',
  set: () => Effect.void,
  list: Effect.succeed([]),
  get: name =>
    name in keys
      ? Effect.succeed(Redacted.make(keys[name] ?? ''))
      : Effect.fail(new SecretMissing({ name })),
  remove: () => Effect.succeed(false),
})

/** Each provider at the fake one, under a path of its own. */
const routesAt = (url: string): ReadonlyArray<ProviderRoute> => [
  {
    provider: 'anthropic',
    upstream: `${url}/anthropic`,
    api: 'anthropic-messages',
    authentication: Authentication.Header({
      header: 'x-api-key',
      credential: SecretName.make('anthropic'),
    }),
  },
  {
    provider: 'openai',
    upstream: `${url}/openai/v1`,
    api: 'openai-responses',
    authentication: Authentication.Bearer({
      credential: SecretName.make('openai'),
    }),
  },
  {
    provider: 'google',
    upstream: `${url}/google/v1beta`,
    api: 'google-generative-ai',
    authentication: Authentication.Header({
      header: 'x-goog-api-key',
      credential: SecretName.make('google'),
    }),
  },
  {
    provider: 'ollama',
    upstream: `${url}/ollama/v1`,
    api: 'openai-completions',
    authentication: Authentication.None(),
  },
  {
    provider: 'mistral',
    upstream: `${url}/mistral/v1`,
    api: 'openai-completions',
    authentication: Authentication.Bearer({
      credential: SecretName.make('mistral'),
    }),
  },
]

/** The proxy over a fake provider answering with `answer`, and its events from the start. */
const setup = (answer: (seen: Seen) => Answer) =>
  Effect.gen(function* () {
    const provider = yield* fakeProvider(answer)
    const proxy = yield* make({ routes: routesAt(provider.url) }).pipe(
      Effect.provideService(Secrets, secrets),
      Effect.provide(layerOpen),
    )
    const events = yield* proxy.events
    return { provider, proxy, events }
  })

const worker = (run: string): Caller => ({
  run: RunId.make(run),
  ticket: Option.some(TicketId.make('fab-a1b2')),
  session: Option.some(SessionId.make('session-1')),
  model: 'claude-sonnet-4-5',
})

interface Got {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: Buffer
}

/** A call to the proxy, read raw: its body's bytes as they came, never decompressed. */
const call = (
  url: string,
  options: {
    readonly headers: Readonly<Record<string, string>>
    readonly body?: string
  },
) =>
  Effect.callback<Got>(resume => {
    const request = httpRequest(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers },
      },
      response => {
        const chunks: Array<Buffer> = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () =>
          resume(
            Effect.succeed({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks),
            }),
          ),
        )
      },
    )
    request.on('error', error => resume(Effect.die(error)))
    request.end(options.body ?? '{"model":"m","stream":true}')
  })

const streamed = (recorded: RecordedStream) => () => ({
  status: 200,
  headers: { 'content-type': recorded.contentType },
  body: recorded.body,
})

/** The next `n` events. */
const next = (events: Stream.Stream<ProxyEvent>, n: number) =>
  Effect.map(Stream.runCollect(Stream.take(events, n)), chunk => [...chunk])

const bearer = (token: Redacted.Redacted<string>) => ({
  authorization: `Bearer ${Redacted.value(token)}`,
})

describe('model proxy', () => {
  const apis: ReadonlyArray<{
    readonly api: string
    readonly provider: string
    readonly recorded: RecordedStream
    readonly placeholder: (
      token: Redacted.Redacted<string>,
    ) => Record<string, string>
    readonly credential: (seen: Seen) => unknown
    readonly expected: unknown
  }> = [
    {
      api: 'Anthropic Messages',
      provider: 'anthropic',
      recorded: anthropicMessages,
      placeholder: token => ({ 'x-api-key': Redacted.value(token) }),
      credential: seen => seen.headers['x-api-key'],
      expected: keys['anthropic'],
    },
    {
      api: 'OpenAI Responses',
      provider: 'openai',
      recorded: openaiResponses,
      placeholder: bearer,
      credential: seen => seen.headers['authorization'],
      expected: `Bearer ${keys['openai']}`,
    },
    {
      api: 'Google',
      provider: 'google',
      recorded: googleGenerate,
      placeholder: token => ({ 'x-goog-api-key': Redacted.value(token) }),
      credential: seen => seen.headers['x-goog-api-key'],
      expected: keys['google'],
    },
    {
      api: 'Chat Completions, a local model with no credential',
      provider: 'ollama',
      recorded: chatCompletions,
      placeholder: bearer,
      credential: seen => seen.headers['authorization'],
      expected: undefined,
    },
  ]

  for (const {
    api,
    provider,
    recorded,
    placeholder,
    credential,
    expected,
  } of apis) {
    it.effect(`passes ${api} through unchanged and counts its usage`, () =>
      Effect.gen(function* () {
        const {
          provider: upstream,
          proxy,
          events,
        } = yield* setup(streamed(recorded))
        const caller = worker('run-1')
        const agent = yield* proxy.grant(caller)
        expect(agent.baseUrls[provider]).toBe(`${proxy.address}/${provider}`)

        const got = yield* call(`${agent.baseUrls[provider]}${recorded.path}`, {
          headers: {
            ...placeholder(agent.token),
            'anthropic-version': '2023-06-01',
          },
        })
        expect(got.status).toBe(200)
        expect(got.headers['content-type']).toBe(recorded.contentType)
        expect(got.body.toString('utf8')).toBe(recorded.body)

        const [seen] = upstream.seen
        expect(seen?.url).toBe(
          new URL(
            routesAt(upstream.url).find(route => route.provider === provider)
              ?.upstream ?? '',
          ).pathname + recorded.path,
        )
        expect(seen?.body).toBe('{"model":"m","stream":true}')
        expect(seen?.headers['anthropic-version']).toBe('2023-06-01')
        expect(seen === undefined ? undefined : credential(seen)).toBe(expected)
        expect(JSON.stringify(seen?.headers)).not.toContain(
          Redacted.value(agent.token),
        )

        expect(yield* next(events, 1)).toEqual([
          ProxyEvent.Used({ provider, caller, tokens: recorded.tokens }),
        ])
      }).pipe(Effect.scoped),
    )
  }

  it.effect(
    'passes a compressed answer on as its bytes came, and reads its usage',
    () =>
      Effect.gen(function* () {
        const gzipped = gzipSync(anthropicAnswer.body)
        const { proxy, events } = yield* setup(() => ({
          status: 200,
          headers: {
            'content-type': anthropicAnswer.contentType,
            'content-encoding': 'gzip',
          },
          body: gzipped,
        }))
        const caller = worker('run-1')
        const agent = yield* proxy.grant(caller)
        const got = yield* call(`${agent.baseUrls['anthropic']}/v1/messages`, {
          headers: { 'x-api-key': Redacted.value(agent.token) },
        })
        expect(got.headers['content-encoding']).toBe('gzip')
        expect(got.body.equals(gzipped)).toBe(true)
        expect(yield* next(events, 1)).toEqual([
          ProxyEvent.Used({
            provider: 'anthropic',
            caller,
            tokens: anthropicAnswer.tokens,
          }),
        ])
      }).pipe(Effect.scoped),
  )

  it.effect(
    'reads a 429 with its window reset as a usage limit, and passes it on',
    () =>
      Effect.gen(function* () {
        const { proxy, events } = yield* setup(() => ({
          status: 429,
          headers: {
            'content-type': 'application/json',
            'anthropic-ratelimit-unified-status': 'rejected',
            'anthropic-ratelimit-unified-reset': String(
              anthropicUsageLimit.reset,
            ),
            'retry-after': '3600',
          },
          body: anthropicUsageLimit.body,
        }))
        const caller = worker('run-1')
        const agent = yield* proxy.grant(caller)
        const got = yield* call(`${agent.baseUrls['anthropic']}/v1/messages`, {
          headers: { 'x-api-key': Redacted.value(agent.token) },
        })
        expect(got.status).toBe(429)
        expect(got.body.toString('utf8')).toBe(anthropicUsageLimit.body)
        expect(got.headers['anthropic-ratelimit-unified-reset']).toBe(
          String(anthropicUsageLimit.reset),
        )
        expect(yield* next(events, 1)).toEqual([
          ProxyEvent.Refused({
            provider: 'anthropic',
            caller,
            refusal: Refusal.UsageLimited({
              resetAt: DateTime.fromEpochSeconds(anthropicUsageLimit.reset),
            }),
          }),
        ])
      }).pipe(Effect.scoped),
  )

  it.effect(
    'reads a 429 with no reset as a rate limit, with its retry-after',
    () =>
      Effect.gen(function* () {
        const { proxy, events } = yield* setup(() => ({
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '30' },
          body: '{"error":{"message":"Rate limit reached","type":"requests","code":"rate_limit_exceeded"}}',
        }))
        const caller = worker('run-1')
        const agent = yield* proxy.grant(caller)
        const got = yield* call(`${agent.baseUrls['openai']}/responses`, {
          headers: bearer(agent.token),
        })
        expect(got.status).toBe(429)
        const [event] = yield* next(events, 1)
        expect(event).toEqual(
          ProxyEvent.Refused({
            provider: 'openai',
            caller,
            refusal: Refusal.RateLimited({
              retryAfter: Option.some(Duration.seconds(30)),
            }),
          }),
        )
      }).pipe(Effect.scoped),
  )

  it.effect(
    'reads a refused key as a failed start until a call has gone through in the run, and a refused credential after',
    () =>
      Effect.gen(function* () {
        let refuse = true
        const { proxy, events } = yield* setup(() =>
          refuse
            ? {
                status: 401,
                headers: { 'content-type': 'application/json' },
                body: anthropicBadKey,
              }
            : {
                status: 200,
                headers: { 'content-type': anthropicAnswer.contentType },
                body: anthropicAnswer.body,
              },
        )
        const first = worker('run-1')
        const agent = yield* proxy.grant(first)
        const send = (token: Redacted.Redacted<string>) =>
          call(`${agent.baseUrls['anthropic']}/v1/messages`, {
            headers: { 'x-api-key': Redacted.value(token) },
          })
        const reason = 'the provider refused the credential (HTTP 401)'

        const refused = yield* send(agent.token)
        expect(refused.status).toBe(401)
        expect(refused.body.toString('utf8')).toBe(anthropicBadKey)
        refuse = false
        yield* send(agent.token)
        refuse = true
        yield* send(agent.token)
        // Another run has had no call go through.
        const second = worker('run-2')
        const other = yield* proxy.grant(second)
        yield* send(other.token)

        expect(yield* next(events, 4)).toEqual([
          ProxyEvent.Refused({
            provider: 'anthropic',
            caller: first,
            refusal: Refusal.StartFailed({ reason }),
          }),
          ProxyEvent.Used({
            provider: 'anthropic',
            caller: first,
            tokens: anthropicAnswer.tokens,
          }),
          ProxyEvent.Refused({
            provider: 'anthropic',
            caller: first,
            refusal: Refusal.CredentialRefused({ reason }),
          }),
          ProxyEvent.Refused({
            provider: 'anthropic',
            caller: second,
            refusal: Refusal.StartFailed({ reason }),
          }),
        ])
      }).pipe(Effect.scoped),
  )

  it.effect(
    'refuses a token it never granted, and one whose session has ended',
    () =>
      Effect.gen(function* () {
        const { provider, proxy, events } = yield* setup(
          streamed(anthropicMessages),
        )
        const url = `${proxy.address}/anthropic/v1/messages`

        const unknown = yield* call(url, {
          headers: { 'x-api-key': 'not-a-token' },
        })
        expect(unknown.status).toBe(401)
        const none = yield* call(url, { headers: {} })
        expect(none.status).toBe(401)

        const ended = yield* Effect.scoped(proxy.grant(worker('run-1')))
        const revoked = yield* call(url, {
          headers: { 'x-api-key': Redacted.value(ended.token) },
        })
        expect(revoked.status).toBe(401)
        expect(provider.seen).toEqual([])

        // Nothing was published for them: the first event is a granted call's.
        const caller = worker('run-1')
        const agent = yield* proxy.grant(caller)
        yield* call(url, {
          headers: { 'x-api-key': Redacted.value(agent.token) },
        })
        expect(yield* next(events, 1)).toEqual([
          ProxyEvent.Used({
            provider: 'anthropic',
            caller,
            tokens: anthropicMessages.tokens,
          }),
        ])
      }).pipe(Effect.scoped),
  )

  it.effect('refuses a call it has no credential for as a failed start', () =>
    Effect.gen(function* () {
      const { provider, proxy, events } = yield* setup(
        streamed(chatCompletions),
      )
      const caller = worker('run-1')
      const agent = yield* proxy.grant(caller)
      const got = yield* call(`${agent.baseUrls['mistral']}/chat/completions`, {
        headers: bearer(agent.token),
      })
      expect(got.status).toBe(401)
      expect(provider.seen).toEqual([])
      expect(yield* next(events, 1)).toEqual([
        ProxyEvent.Refused({
          provider: 'mistral',
          caller,
          refusal: Refusal.StartFailed({
            reason: 'no credential is kept under mistral',
          }),
        }),
      ])
    }).pipe(Effect.scoped),
  )

  it.effect('probes a provider with a small call, counted to the run', () =>
    Effect.gen(function* () {
      const { provider, proxy, events } = yield* setup(() => ({
        status: 200,
        headers: { 'content-type': anthropicAnswer.contentType },
        body: anthropicAnswer.body,
      }))
      const run = RunId.make('run-1')
      const outcome = yield* proxy.probe({
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        run,
      })
      expect(outcome).toEqual(ProbeOutcome.Passed())
      const [seen] = provider.seen
      expect(seen?.url).toBe('/anthropic/v1/messages')
      expect(seen?.headers['x-api-key']).toBe(keys['anthropic'])
      expect(JSON.parse(seen?.body ?? '{}')).toMatchObject({
        model: 'claude-haiku-4-5',
        max_tokens: 1,
      })
      expect(yield* next(events, 1)).toEqual([
        ProxyEvent.Used({
          provider: 'anthropic',
          caller: {
            run,
            ticket: Option.none(),
            session: Option.none(),
            model: 'claude-haiku-4-5',
          },
          tokens: anthropicAnswer.tokens,
        }),
      ])
    }).pipe(Effect.scoped),
  )

  it.effect(
    'gives a probe refused its refusal, and one with no credential a failed start',
    () =>
      Effect.gen(function* () {
        const { proxy } = yield* setup(() => ({
          status: 401,
          headers: { 'content-type': 'application/json' },
          body: anthropicBadKey,
        }))
        const run = RunId.make('run-1')
        expect(
          yield* proxy.probe({
            provider: 'google',
            model: 'gemini-2.5-flash',
            run,
          }),
        ).toEqual(
          ProbeOutcome.Refused({
            refusal: Refusal.StartFailed({
              reason: 'the provider refused the credential (HTTP 401)',
            }),
          }),
        )
        expect(
          yield* proxy.probe({
            provider: 'mistral',
            model: 'mistral-small',
            run,
          }),
        ).toEqual(
          ProbeOutcome.Refused({
            refusal: Refusal.StartFailed({
              reason: 'no credential is kept under mistral',
            }),
          }),
        )
        expect(
          ProbeOutcome.$is('Failed')(
            yield* proxy.probe({ provider: 'nowhere', model: 'm', run }),
          ),
        ).toBe(true)
      }).pipe(Effect.scoped),
  )
})
