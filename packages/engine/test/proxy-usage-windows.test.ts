import { DateTime, Effect, Option, PubSub, Redacted, Stream } from 'effect'
import { TestClock } from 'effect/testing'
import { createServer, request as httpRequest } from 'node:http'

import { describe, expect, it } from '@effect/vitest'
import { RunId, SessionId, TicketId } from '@fabrica/contracts'

import { makeLineStream } from '../src/files'
import {
  Authentication,
  type Caller,
  type ProviderRoute,
  ProxyEvent,
  Refusal,
  type UsageWindowFigure,
  layerOpen,
  make,
  windowsOf,
} from '../src/proxy'
import {
  RunLog,
  eventsPath,
  logPath,
  makeRunLog,
  recordUsageWindows,
  usageWindowDraft,
} from '../src/runlog'
import { SecretMissing, SecretName, Secrets } from '../src/secrets'
import { anthropicAnswer, openaiResponses } from './proxy-streams'

// The usage windows (spec §12.9, §13.12, H90): read from the headers of every response the model
// proxy passes on, allowed ones too, Anthropic's five-hour and seven-day and ChatGPT's primary and
// secondary; each account's latest figure kept and served, a move published, a figure unchanged not;
// and the run's `usage_window` record of each move on its calls, its reset in the run's zone.

/** Anthropic's windows on a response: 41% of five hours, 12% of seven days. */
const anthropicWindows = {
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': '0.41',
  'anthropic-ratelimit-unified-5h-reset': '1761840000',
  'anthropic-ratelimit-unified-7d-utilization': '0.12',
  'anthropic-ratelimit-unified-7d-reset': '1762300000',
}

/** ChatGPT's windows on a response: 23% of five hours, 7% of a week. */
const codexWindows = {
  'x-codex-primary-used-percent': '23',
  'x-codex-primary-window-minutes': '300',
  'x-codex-primary-reset-at': '1761840000',
  'x-codex-secondary-used-percent': '7',
  'x-codex-secondary-window-minutes': '10080',
  'x-codex-secondary-reset-at': '1762300000',
}

describe('the usage windows a response reports', () => {
  it("reads Anthropic's five-hour and seven-day windows", () => {
    expect(windowsOf(anthropicWindows)).toEqual([
      {
        window: 'five_hour',
        utilization: 0.41,
        resetsAt: Option.some(DateTime.fromEpochSeconds(1761840000)),
      },
      {
        window: 'seven_day',
        utilization: 0.12,
        resetsAt: Option.some(DateTime.fromEpochSeconds(1762300000)),
      },
    ])
  })

  it("reads ChatGPT's windows by their length, their percent as a share", () => {
    expect(windowsOf(codexWindows)).toEqual([
      {
        window: 'five_hour',
        utilization: 0.23,
        resetsAt: Option.some(DateTime.fromEpochSeconds(1761840000)),
      },
      {
        window: 'seven_day',
        utilization: 0.07,
        resetsAt: Option.some(DateTime.fromEpochSeconds(1762300000)),
      },
    ])
  })

  it('names a window of another length by its minutes, one of none by its slot', () => {
    expect(
      windowsOf({
        'x-codex-primary-used-percent': '50',
        'x-codex-primary-window-minutes': '90',
        'x-codex-secondary-used-percent': '10',
      }).map(({ window }) => window),
    ).toEqual(['90_minute', 'secondary'])
  })

  it('keeps a share between 0 and 1, and a window with no reset has none', () => {
    expect(
      windowsOf({
        'anthropic-ratelimit-unified-5h-utilization': '1.04',
        'x-codex-primary-used-percent': '-3',
      }),
    ).toEqual([
      { window: 'five_hour', utilization: 1, resetsAt: Option.none() },
      { window: 'primary', utilization: 0, resetsAt: Option.none() },
    ])
  })

  it('reads none where a provider reports none, or reports them unreadably', () => {
    expect(windowsOf({ 'content-type': 'application/json' })).toEqual([])
    expect(
      windowsOf({
        'anthropic-ratelimit-unified-5h-utilization': 'high',
        'x-codex-primary-reset-at': '1761840000',
      }),
    ).toEqual([])
  })
})

/** What the provider answers each call: its status and headers, and its body. */
interface Answer {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/** A loopback provider answering the calls in turn with `answers`, the last one again past their end. */
const fakeProvider = (answers: ReadonlyArray<Answer>) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly url: string; readonly close: () => void }>(
      resume => {
        let call = 0
        const server = createServer((request, response) => {
          request.resume()
          request.on('end', () => {
            const answer = answers[Math.min(call, answers.length - 1)]
            call += 1
            if (answer === undefined) return response.destroy()
            response.writeHead(answer.status, answer.headers)
            response.end(answer.body)
          })
        })
        server.listen({ host: '127.0.0.1', port: 0 }, () => {
          const address = server.address()
          const port =
            typeof address === 'object' && address !== null ? address.port : 0
          resume(
            Effect.succeed({
              url: `http://127.0.0.1:${port}`,
              close: () => {
                server.close()
                server.closeAllConnections()
              },
            }),
          )
        })
      },
    ),
    provider => Effect.sync(provider.close),
  )

const secrets = Secrets.of({
  store: 'file',
  set: () => Effect.void,
  list: Effect.succeed([]),
  get: name =>
    name === 'anthropic.work' || name === 'openai'
      ? Effect.succeed(Redacted.make(`real-${name}-key`))
      : Effect.fail(new SecretMissing({ name })),
  remove: () => Effect.succeed(false),
})

const routesAt = (url: string): ReadonlyArray<ProviderRoute> => [
  {
    provider: 'anthropic',
    upstream: `${url}/anthropic`,
    api: 'anthropic-messages',
    authentication: Authentication.Header({
      header: 'x-api-key',
      credential: SecretName.make('anthropic.work'),
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
]

const caller: Caller = {
  run: RunId.make('run-1'),
  ticket: Option.some(TicketId.make('fab-a1b2')),
  session: Option.some(SessionId.make('session-1')),
  model: 'claude-sonnet-4-5',
}

/** The proxy over a provider answering with `answers`, its events from the start, and a call through it. */
const setup = (answers: ReadonlyArray<Answer>) =>
  Effect.gen(function* () {
    const provider = yield* fakeProvider(answers)
    const proxy = yield* make({ routes: routesAt(provider.url) }).pipe(
      Effect.provideService(Secrets, secrets),
      Effect.provide(layerOpen),
    )
    const events = yield* proxy.events
    const agent = yield* proxy.grant(caller)
    const call = (provider: 'anthropic' | 'openai') =>
      Effect.callback<{
        readonly status: number
        readonly headers: Readonly<Record<string, unknown>>
      }>(resume => {
        const path = provider === 'anthropic' ? '/v1/messages' : '/responses'
        const request = httpRequest(
          `${agent.baseUrls[provider]}${path}`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${Redacted.value(agent.token)}`,
            },
          },
          response => {
            response.resume()
            response.on('end', () =>
              resume(
                Effect.succeed({
                  status: response.statusCode ?? 0,
                  headers: response.headers,
                }),
              ),
            )
          },
        )
        request.on('error', error => resume(Effect.die(error)))
        request.end('{"model":"m","stream":true}')
      })
    return { proxy, events, call }
  })

/** The windows published among the next `n` events. */
const windowed = (events: Stream.Stream<ProxyEvent>, n: number) =>
  Effect.map(Stream.runCollect(Stream.take(events, n)), chunk =>
    [...chunk].filter(ProxyEvent.$is('Windowed')),
  )

const anthropicAllowed = (
  headers: Readonly<Record<string, string>>,
): Answer => ({
  status: 200,
  headers: { 'content-type': anthropicAnswer.contentType, ...headers },
  body: anthropicAnswer.body,
})

const fiveHour = (
  utilization: number,
  provider = 'anthropic',
  account = 'anthropic.work',
): UsageWindowFigure => ({
  provider,
  account: Option.some(SecretName.make(account)),
  window: 'five_hour',
  utilization,
  resetsAt: Option.some(DateTime.fromEpochSeconds(1761840000)),
})

const sevenDay = (
  utilization: number,
  provider = 'anthropic',
  account = 'anthropic.work',
): UsageWindowFigure => ({
  provider,
  account: Option.some(SecretName.make(account)),
  window: 'seven_day',
  utilization,
  resetsAt: Option.some(DateTime.fromEpochSeconds(1762300000)),
})

describe('the model proxy', () => {
  it.effect(
    "keeps an allowed response's windows as its account's latest, publishes them, and passes the headers on",
    () =>
      Effect.gen(function* () {
        const { proxy, events, call } = yield* setup([
          anthropicAllowed(anthropicWindows),
        ])
        const got = yield* call('anthropic')
        expect(got.status).toBe(200)
        expect(got.headers['anthropic-ratelimit-unified-5h-utilization']).toBe(
          '0.41',
        )
        // Two windows, then the call's usage.
        expect(yield* windowed(events, 3)).toEqual([
          ProxyEvent.Windowed({ caller, figure: fiveHour(0.41) }),
          ProxyEvent.Windowed({ caller, figure: sevenDay(0.12) }),
        ])
        expect(yield* proxy.windows).toEqual([fiveHour(0.41), sevenDay(0.12)])
      }).pipe(Effect.scoped),
  )

  it.effect(
    'publishes only the windows that moved, and serves the latest of each',
    () =>
      Effect.gen(function* () {
        const { proxy, events, call } = yield* setup([
          anthropicAllowed(anthropicWindows),
          anthropicAllowed(anthropicWindows),
          anthropicAllowed({
            ...anthropicWindows,
            'anthropic-ratelimit-unified-5h-utilization': '0.43',
          }),
        ])
        yield* call('anthropic')
        yield* call('anthropic')
        yield* call('anthropic')
        // The first call's two windows and usage, the second's usage, the third's moved window and usage.
        expect(yield* windowed(events, 6)).toEqual([
          ProxyEvent.Windowed({ caller, figure: fiveHour(0.41) }),
          ProxyEvent.Windowed({ caller, figure: sevenDay(0.12) }),
          ProxyEvent.Windowed({ caller, figure: fiveHour(0.43) }),
        ])
        expect(yield* proxy.windows).toEqual([fiveHour(0.43), sevenDay(0.12)])
      }).pipe(Effect.scoped),
  )

  it.effect(
    "reads a refusal's windows too, and keeps each provider's account apart",
    () =>
      Effect.gen(function* () {
        const { proxy, events, call } = yield* setup([
          {
            status: 429,
            headers: {
              'content-type': 'application/json',
              ...anthropicWindows,
              'anthropic-ratelimit-unified-status': 'rejected',
              'anthropic-ratelimit-unified-5h-utilization': '1',
              'anthropic-ratelimit-unified-reset': '1761840000',
            },
            body: '{"type":"error","error":{"type":"rate_limit_error","message":"limited"}}',
          },
          {
            status: 200,
            headers: {
              'content-type': openaiResponses.contentType,
              ...codexWindows,
            },
            body: openaiResponses.body,
          },
        ])
        expect((yield* call('anthropic')).status).toBe(429)
        yield* call('openai')
        // The refusal and its two windows, then the answer's two windows and usage.
        expect(yield* windowed(events, 6)).toEqual([
          ProxyEvent.Windowed({ caller, figure: fiveHour(1) }),
          ProxyEvent.Windowed({ caller, figure: sevenDay(0.12) }),
          ProxyEvent.Windowed({
            caller,
            figure: fiveHour(0.23, 'openai', 'openai'),
          }),
          ProxyEvent.Windowed({
            caller,
            figure: sevenDay(0.07, 'openai', 'openai'),
          }),
        ])
        expect(yield* proxy.windows).toEqual([
          fiveHour(1),
          sevenDay(0.12),
          fiveHour(0.23, 'openai', 'openai'),
          sevenDay(0.07, 'openai', 'openai'),
        ])
      }).pipe(Effect.scoped),
  )

  it.effect('serves no windows before a response reported any', () =>
    Effect.gen(function* () {
      const { proxy, events, call } = yield* setup([anthropicAllowed({})])
      yield* call('anthropic')
      expect(yield* windowed(events, 1)).toEqual([])
      expect(yield* proxy.windows).toEqual([])
    }).pipe(Effect.scoped),
  )
})

// 2026-10-29T12:00:00.000Z, in a zone two hours east of UTC.
const start = Date.UTC(2026, 9, 29, 12, 0, 0)
const zone = DateTime.zoneMakeOffset(2 * 60 * 60 * 1000)

/** A RunLog for `run` whose stream and log take every byte. */
const memoryRunLog = (run: RunId) =>
  Effect.gen(function* () {
    const sink = { write: (bytes: Uint8Array) => Effect.succeed(bytes.length) }
    return yield* makeRunLog({
      run,
      events: yield* makeLineStream({
        path: eventsPath,
        sink,
        endsWithNewline: true,
      }),
      log: yield* makeLineStream({
        path: logPath,
        sink,
        endsWithNewline: true,
      }),
    })
  }).pipe(Effect.provideService(DateTime.CurrentTimeZone, zone))

describe('the usage_window record', () => {
  it.effect(
    "dates the window's reset in the run's zone, its account named",
    () =>
      Effect.gen(function* () {
        expect(yield* usageWindowDraft(fiveHour(0.41), zone)).toEqual({
          kind: 'usage_window',
          provider: 'anthropic',
          account: 'anthropic.work',
          window: 'five_hour',
          utilization: 0.41,
          resets_at: '2025-10-30T18:00:00.000+02:00',
        })
        expect(
          yield* usageWindowDraft(
            {
              ...fiveHour(0.41),
              account: Option.none(),
              resetsAt: Option.none(),
            },
            zone,
          ),
        ).toEqual({
          kind: 'usage_window',
          provider: 'anthropic',
          window: 'five_hour',
          utilization: 0.41,
        })
      }),
  )

  it.effect(
    "is written for each window that moved on the run's calls, not another run's",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(start)
        const run = RunId.make('run-1')
        const runLog = yield* memoryRunLog(run)
        const seen = yield* runLog.subscribe
        const published = yield* PubSub.unbounded<ProxyEvent>()
        const events = Stream.fromSubscription(
          yield* PubSub.subscribe(published),
        )
        yield* recordUsageWindows(events).pipe(
          Effect.provideService(RunLog, runLog),
        )
        const other: Caller = { ...caller, run: RunId.make('run-2') }
        yield* PubSub.publishAll(published, [
          ProxyEvent.Windowed({ caller: other, figure: fiveHour(0.5) }),
          ProxyEvent.Refused({
            provider: 'anthropic',
            caller,
            refusal: Refusal.StartFailed({ reason: 'no key' }),
          }),
          ProxyEvent.Windowed({ caller, figure: sevenDay(0.12) }),
        ])
        expect(yield* PubSub.take(seen)).toEqual({
          v: 1,
          time: '2026-10-29T14:00:00.000+02:00',
          run,
          kind: 'usage_window',
          provider: 'anthropic',
          account: 'anthropic.work',
          window: 'seven_day',
          utilization: 0.12,
          resets_at: '2025-11-05T01:46:40.000+02:00',
        })
      }).pipe(Effect.scoped),
  )
})
