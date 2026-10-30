import { Duration, Effect, Layer, Option, Queue, Redacted, Ref } from 'effect'
import { SqlClient } from 'effect/sql'
import { TestClock } from 'effect/testing'
import { createServer, request as httpRequest } from 'node:http'

import { describe, expect, it } from '@effect/vitest'
import {
  EndEvent,
  LocalTime,
  ModelName,
  ProjectId,
  ProviderName,
  Retention as RetentionSetting,
  RunId,
  SessionId,
  TicketId,
  type Tokens,
  TurnEvent,
  encodeEventLine,
} from '@fabrica/contracts'

import {
  type Billing,
  Price,
  type PriceTable,
  addCall,
  countProxyCalls,
  makeCostAccount,
  noSpend,
  piPriceTable,
  priceOf,
  spendFields,
} from '../src/cost'
import {
  Authentication,
  type Caller,
  ModelProxy,
  ProxyEvent,
  Refusal,
  layerOpen,
  make as makeProxy,
} from '../src/proxy'
import { SecretMissing, SecretName, Secrets } from '../src/secrets'
import {
  Telemetry,
  TelemetryRow,
  makeTelemetry,
  prune,
  telemetryStoreLayer,
} from '../src/telemetry'
import {
  anthropicMessages,
  chatCompletions,
  googleGenerate,
  openaiResponses,
} from './proxy-streams'

// Cost accounting (spec §14.4, §21): calls priced from the proxy's recorded usage at pi-ai's tables,
// a subscription's at its API-price equivalent marked as such, each recorded as a model-call row tied
// to its project, run and ticket, and added up for the event stream's `turn`, `closed` and `end`.

const project = ProjectId.make('project-1')
const run = RunId.make('run-1')
const ticket = TicketId.make('fab-a1b2')
const other = TicketId.make('fab-c3d4')
const session = SessionId.make('session-1')
const time = LocalTime.make('2026-10-29T10:15:00.000+02:00')

const anthropic = ProviderName.make('anthropic')
const openai = ProviderName.make('openai')
const google = ProviderName.make('google')
const ollama = ProviderName.make('ollama')

const piPrices = piPriceTable()

const sonnet = ModelName.make('claude-sonnet-4-5')
const gpt = ModelName.make('gpt-5')

// pi-ai 1.4.0's prices, in US dollars per million tokens: claude-sonnet-4-5 3 in, 15 out, 0.3 a cache
// read, 3.75 a cache write; gpt-5 1.25, 10 and 0.125; gemini-2.5-pro 1.25, 10 and 0.125, and 2.5, 15
// and 0.25 past 200,000 tokens of input.
const sonnetMessages = (25 * 3 + 15 * 15 + 2000 * 0.3 + 100 * 3.75) / 1e6
const gptResponses = (200 * 1.25 + 42 * 10 + 1000 * 0.125) / 1e6

const callerOf = (fields: Partial<Caller> = {}): Caller => ({
  run,
  ticket: Option.some(ticket),
  session: Option.some(session),
  model: sonnet,
  ...fields,
})

const used = (options: {
  readonly provider?: ProviderName
  readonly caller?: Caller
  readonly tokens: Tokens
}) =>
  ProxyEvent.Used({
    provider: options.provider ?? anthropic,
    caller: options.caller ?? callerOf(),
    tokens: options.tokens,
    latency: Duration.seconds(4),
    firstToken: Option.some(Duration.millis(800)),
  })

const billedBy =
  (subscriptions: ReadonlyArray<ProviderName>) =>
  (provider: ProviderName): Billing =>
    subscriptions.includes(provider) ? 'subscription' : 'api_key'

/** A cost account over telemetry that keeps the rows it is given. */
const accountOf = (options: {
  readonly billing?: (provider: ProviderName) => Billing
  readonly prices?: PriceTable
}) =>
  Effect.gen(function* () {
    const rows = yield* Ref.make<ReadonlyArray<TelemetryRow>>([])
    const account = yield* makeCostAccount({
      project,
      run,
      billing: options.billing ?? billedBy([]),
      ...(options.prices === undefined ? {} : { prices: options.prices }),
    }).pipe(
      Effect.provideService(
        Telemetry,
        Telemetry.of({
          record: row => Ref.update(rows, kept => [...kept, row]),
          flush: Effect.void,
        }),
      ),
    )
    return { account, rows: Ref.get(rows) }
  })

describe('pricing', () => {
  it("prices recorded usage at pi-ai's tables, a model named with its provider too", () => {
    const price = (provider: ProviderName, model: string, tokens: Tokens) =>
      piPrices({ provider, model: ModelName.make(model), tokens })
    expect(
      Option.getOrThrow(
        price(anthropic, 'claude-sonnet-4-5', anthropicMessages.tokens),
      ),
    ).toBeCloseTo(sonnetMessages, 12)
    expect(
      Option.getOrThrow(
        price(
          anthropic,
          'anthropic/claude-sonnet-4-5',
          anthropicMessages.tokens,
        ),
      ),
    ).toBeCloseTo(sonnetMessages, 12)
    expect(
      Option.getOrThrow(price(openai, 'gpt-5', openaiResponses.tokens)),
    ).toBeCloseTo(gptResponses, 12)
    expect(
      Option.getOrThrow(price(google, 'gemini-2.5-pro', googleGenerate.tokens)),
    ).toBeCloseTo((22 * 1.25 + 17 * 10 + 8 * 0.125) / 1e6, 12)
  })

  it("prices a call past an input tier at the tier's prices", () => {
    const tokens = {
      input: 150_000,
      output: 1000,
      cache_write: 0,
      cache_read: 60_000,
    }
    expect(
      Option.getOrThrow(
        piPrices({
          provider: google,
          model: ModelName.make('gemini-2.5-pro'),
          tokens,
        }),
      ),
    ).toBeCloseTo((150_000 * 2.5 + 1000 * 15 + 60_000 * 0.25) / 1e6, 12)
  })

  it('leaves a model the tables lack unpriced', () => {
    expect(
      piPrices({
        provider: ollama,
        model: ModelName.make('llama3.2'),
        tokens: chatCompletions.tokens,
      }),
    ).toEqual(Option.none())
    expect(
      priceOf(piPrices, {
        provider: anthropic,
        model: ModelName.make('claude-unreleased-9'),
        tokens: anthropicMessages.tokens,
        billing: 'api_key',
      }),
    ).toEqual(Price.Unpriced())
  })

  it("marks a subscription's call as its API-price equivalent, an API key's as money", () => {
    const call = {
      provider: anthropic,
      model: sonnet,
      tokens: anthropicMessages.tokens,
    }
    const paid = priceOf(piPrices, { ...call, billing: 'api_key' })
    const equivalent = priceOf(piPrices, { ...call, billing: 'subscription' })
    expect(paid).toMatchObject({
      _tag: 'Paid',
      usd: expect.closeTo(sonnetMessages, 12),
    })
    expect(equivalent).toMatchObject({
      _tag: 'Equivalent',
      usd: expect.closeTo(sonnetMessages, 12),
    })
  })
})

describe('spend', () => {
  it('adds tokens by model, money and equivalents apart, and leaves out what has no value', () => {
    expect(spendFields(noSpend)).toEqual({})
    const spend = [
      {
        model: sonnet,
        tokens: anthropicMessages.tokens,
        price: Price.Paid({ usd: 0.5 }),
      },
      {
        model: sonnet,
        tokens: anthropicMessages.tokens,
        price: Price.Paid({ usd: 0.25 }),
      },
      { model: gpt, tokens: openaiResponses.tokens, price: Price.Unpriced() },
    ].reduce(addCall, noSpend)
    expect(spendFields(spend)).toEqual({
      tokens: {
        [sonnet]: { input: 50, output: 30, cache_write: 200, cache_read: 4000 },
        [gpt]: openaiResponses.tokens,
      },
      cost_usd: 0.75,
    })
    expect(
      spendFields(
        addCall(spend, {
          model: gpt,
          tokens: openaiResponses.tokens,
          price: Price.Equivalent({ usd: 2 }),
        }),
      ),
    ).toMatchObject({ cost_usd: 0.75, equivalent_usd: 2 })
  })
})

describe('cost account', () => {
  it.effect(
    'records each call of the run as a model-call row with its ticket and run, priced',
    () =>
      Effect.gen(function* () {
        const { account, rows } = yield* accountOf({})
        yield* account.count(used({ tokens: anthropicMessages.tokens }))
        // Another run's call, and a refusal, are left.
        yield* account.count(
          used({
            caller: callerOf({ run: RunId.make('run-2') }),
            tokens: anthropicMessages.tokens,
          }),
        )
        yield* account.count(
          ProxyEvent.Refused({
            provider: anthropic,
            caller: callerOf(),
            refusal: Refusal.RateLimited({ retryAfter: Option.none() }),
          }),
        )
        // An organ's call, counted to no ticket.
        yield* account.count(
          used({
            provider: openai,
            caller: callerOf({
              ticket: Option.none(),
              session: Option.none(),
              model: gpt,
            }),
            tokens: openaiResponses.tokens,
          }),
        )

        const recorded = yield* rows
        expect(recorded).toHaveLength(2)
        const [worker, organ] = recorded
        expect(worker).toMatchObject({
          _tag: 'ModelCall',
          project,
          run,
          ticket,
          provider: anthropic,
          model: sonnet,
          tokens: anthropicMessages.tokens,
          latency: Duration.seconds(4),
          firstToken: Duration.millis(800),
          outcome: 'answered',
        })
        expect(worker).toMatchObject({
          costUsd: expect.closeTo(sonnetMessages, 12),
        })
        expect(worker).not.toHaveProperty('equivalentUsd')
        expect(organ).toMatchObject({
          _tag: 'ModelCall',
          run,
          ticket: undefined,
          model: gpt,
        })
      }),
  )

  it.effect(
    "records a subscription's call with its equivalent, not money",
    () =>
      Effect.gen(function* () {
        const { account, rows } = yield* accountOf({
          billing: billedBy([anthropic]),
        })
        yield* account.count(used({ tokens: anthropicMessages.tokens }))
        yield* account.count(
          used({
            provider: openai,
            caller: callerOf({ model: gpt }),
            tokens: openaiResponses.tokens,
          }),
        )
        const [subscription, paid] = yield* rows
        expect(subscription).not.toHaveProperty('costUsd')
        expect(subscription).toMatchObject({
          equivalentUsd: expect.closeTo(sonnetMessages, 12),
        })
        expect(paid).toMatchObject({
          costUsd: expect.closeTo(gptResponses, 12),
        })
        expect(paid).not.toHaveProperty('equivalentUsd')

        const fields = spendFields(yield* account.ticket(ticket))
        expect(fields.cost_usd).toBeCloseTo(gptResponses, 12)
        expect(fields.equivalent_usd).toBeCloseTo(sonnetMessages, 12)
      }),
  )

  it.effect(
    "gives a turn its share of its session's totals, and a ticket and the run theirs",
    () =>
      Effect.gen(function* () {
        const { account } = yield* accountOf({ prices: () => Option.some(0.5) })
        const secondSession = SessionId.make('session-2')
        yield* account.count(used({ tokens: anthropicMessages.tokens }))
        yield* account.count(used({ tokens: anthropicMessages.tokens }))
        const first = yield* account.takeTurn(session)
        expect(spendFields(first)).toEqual({
          tokens: {
            [sonnet]: {
              input: 50,
              output: 30,
              cache_write: 200,
              cache_read: 4000,
            },
          },
          cost_usd: 1,
        })
        // Nothing since: the next turn's share is empty.
        expect(yield* account.takeTurn(session)).toEqual(noSpend)
        yield* account.count(used({ tokens: anthropicMessages.tokens }))
        expect(spendFields(yield* account.takeTurn(session)).cost_usd).toBe(0.5)

        yield* account.count(
          used({
            caller: callerOf({
              ticket: Option.some(other),
              session: Option.some(secondSession),
            }),
            tokens: anthropicMessages.tokens,
          }),
        )
        yield* account.count(
          used({
            caller: callerOf({ ticket: Option.none(), session: Option.none() }),
            tokens: anthropicMessages.tokens,
          }),
        )
        expect(spendFields(yield* account.ticket(ticket)).cost_usd).toBe(1.5)
        expect(spendFields(yield* account.ticket(other)).cost_usd).toBe(0.5)
        expect(yield* account.ticket(TicketId.make('fab-e5f6'))).toEqual(
          noSpend,
        )

        const spent = yield* account.run
        expect(spendFields(spent.workers)).toEqual({
          tokens: {
            [sonnet]: {
              input: 100,
              output: 60,
              cache_write: 400,
              cache_read: 8000,
            },
          },
          cost_usd: 2,
        })
        expect(spendFields(spent.untied).cost_usd).toBe(0.5)

        // The records carry them as the stream writes them.
        const turn = JSON.parse(
          encodeEventLine(
            TurnEvent.make({
              time,
              run,
              ticket,
              session,
              model: sonnet,
              turns: 2,
              duration_ms: 1000,
              ...spendFields(first),
            }),
          ),
        )
        expect(turn).toMatchObject({
          kind: 'turn',
          cost_usd: 1,
          tokens: spendFields(first).tokens,
        })
        const end = JSON.parse(
          encodeEventLine(
            EndEvent.make({
              time,
              run,
              code: 0,
              ...spendFields(spent.workers),
            }),
          ),
        )
        expect(end).toEqual({
          v: 1,
          time,
          run,
          kind: 'end',
          code: 0,
          tokens: {
            [sonnet]: {
              input: 100,
              output: 60,
              cache_write: 400,
              cache_read: 8000,
            },
          },
          cost_usd: 2,
        })
      }),
  )

  it.effect("puts a subscription's equivalent on end as such", () =>
    Effect.gen(function* () {
      const { account } = yield* accountOf({
        billing: billedBy([anthropic]),
        prices: () => Option.some(0.5),
      })
      yield* account.count(used({ tokens: anthropicMessages.tokens }))
      const end = JSON.parse(
        encodeEventLine(
          EndEvent.make({
            time,
            run,
            code: 0,
            ...spendFields((yield* account.run).workers),
          }),
        ),
      )
      expect(end).not.toHaveProperty('cost_usd')
      expect(end).toMatchObject({ equivalent_usd: 0.5 })
    }),
  )
})

// 2026-10-29T12:00:00.000Z.
const start = Date.UTC(2026, 9, 29, 12, 0, 0)

describe('cost in the telemetry store', () => {
  it.effect(
    'writes money and equivalents to their columns, and rolls both up',
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(start)
        const retention = {
          raw: RetentionSetting.cases.For.make({ duration: Duration.days(90) }),
          daily: RetentionSetting.cases.Forever.make({}),
        }
        const telemetry = yield* makeTelemetry({ retention })
        const account = yield* makeCostAccount({
          project,
          run,
          billing: billedBy([anthropic]),
          prices: ({ provider }) =>
            Option.some(provider === anthropic ? 0.5 : 0.25),
        }).pipe(Effect.provideService(Telemetry, telemetry))
        yield* account.count(used({ tokens: anthropicMessages.tokens }))
        yield* account.count(
          used({
            provider: openai,
            caller: callerOf({ model: gpt }),
            tokens: openaiResponses.tokens,
          }),
        )
        yield* telemetry.flush

        const sql = yield* SqlClient.SqlClient
        expect(
          yield* sql`SELECT provider, ticket, run, cost_usd, equivalent_usd FROM model_calls ORDER BY provider`,
        ).toEqual([
          {
            provider: 'anthropic',
            ticket,
            run,
            cost_usd: null,
            equivalent_usd: 0.5,
          },
          {
            provider: 'openai',
            ticket,
            run,
            cost_usd: 0.25,
            equivalent_usd: null,
          },
        ])

        yield* prune(retention, start + Duration.toMillis(Duration.days(100)))
        expect(
          yield* sql`SELECT key, count, cost_usd, equivalent_usd FROM daily WHERE kind = 'ModelCall' ORDER BY key`,
        ).toEqual([
          {
            key: 'anthropic/claude-sonnet-4-5',
            count: 1,
            cost_usd: null,
            equivalent_usd: 0.5,
          },
          {
            key: 'openai/gpt-5',
            count: 1,
            cost_usd: 0.25,
            equivalent_usd: null,
          },
        ])
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.fresh(telemetryStoreLayer(':memory:'))),
      ),
  )
})

describe('cost through the model proxy', () => {
  it.effect(
    "counts a call the proxy passed, with its timing, to its ticket's row",
    () =>
      Effect.gen(function* () {
        const provider = yield* Effect.acquireRelease(
          Effect.callback<{ readonly url: string; readonly close: () => void }>(
            resume => {
              const server = createServer((request, response) => {
                request.resume()
                request.on('end', () => {
                  response.writeHead(200, {
                    'content-type': anthropicMessages.contentType,
                  })
                  response.end(anthropicMessages.body)
                })
              })
              server.listen({ host: '127.0.0.1', port: 0 }, () => {
                const address = server.address()
                const port =
                  typeof address === 'object' && address !== null
                    ? address.port
                    : 0
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
          server => Effect.sync(server.close),
        )
        const proxy = yield* makeProxy({
          routes: [
            {
              provider: anthropic,
              upstream: provider.url,
              api: 'anthropic-messages',
              authentication: Authentication.Header({
                header: 'x-api-key',
                credential: SecretName.make('anthropic'),
              }),
            },
          ],
        }).pipe(
          Effect.provideService(
            Secrets,
            Secrets.of({
              store: 'file',
              set: () => Effect.void,
              list: Effect.succeed([]),
              get: name =>
                name === 'anthropic'
                  ? Effect.succeed(Redacted.make('sk-ant-api03-real-key'))
                  : Effect.fail(new SecretMissing({ name })),
              remove: () => Effect.succeed(false),
            }),
          ),
          Effect.provide(layerOpen),
        )

        const rows = yield* Queue.unbounded<TelemetryRow>()
        const account = yield* makeCostAccount({
          project,
          run,
          billing: billedBy([]),
        }).pipe(
          Effect.provideService(
            Telemetry,
            Telemetry.of({
              record: row => Queue.offer(rows, row),
              flush: Effect.void,
            }),
          ),
        )
        yield* countProxyCalls(account).pipe(
          Effect.provideService(ModelProxy, proxy),
        )

        const agent = yield* proxy.grant(callerOf())
        yield* Effect.callback<void>(resume => {
          const request = httpRequest(
            `${agent.baseUrls[anthropic]}/v1/messages`,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-api-key': Redacted.value(agent.token),
              },
            },
            response => {
              response.resume()
              response.on('end', () => resume(Effect.void))
            },
          )
          request.on('error', error => resume(Effect.die(error)))
          request.end('{"model":"claude-sonnet-4-5","stream":true}')
        })

        const row = yield* Queue.take(rows)
        expect(row).toMatchObject({
          _tag: 'ModelCall',
          project,
          run,
          ticket,
          model: sonnet,
          tokens: anthropicMessages.tokens,
          outcome: 'answered',
        })
        // Under the test clock no time passes, but the answer had a first byte.
        expect(row).toMatchObject({
          costUsd: expect.closeTo(sonnetMessages, 12),
          latency: Duration.zero,
          firstToken: Duration.zero,
        })
        expect(spendFields(yield* account.ticket(ticket)).cost_usd).toBeCloseTo(
          sonnetMessages,
          12,
        )
      }).pipe(Effect.scoped),
  )
})
