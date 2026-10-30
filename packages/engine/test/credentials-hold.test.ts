import {
  DateTime,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Option,
  PubSub,
  Queue,
  Redacted,
  Ref,
  Stream,
} from 'effect'
import { TestClock } from 'effect/testing'
import { createServer } from 'node:http'

import { describe, expect, it } from '@effect/vitest'
import {
  type ModelName,
  type ProviderName,
  type RunEvent,
  RunId,
  SessionId,
  TicketId,
  exitCodeOf,
} from '@fabrica/contracts'

import type { Worktree } from '../src/git'
import {
  CREDENTIALS_PROBE,
  type HoldKey,
  type HoldsShape,
  Settle,
  banners,
  clockHeld,
  heldProviders,
  makeCredentialsHold,
  makeHolds,
  stopping,
} from '../src/holds'
import {
  Authentication,
  type Caller,
  Permits,
  ProbeOutcome,
  type ProviderRoute,
  ProxyEvent,
  Refusal,
  makePermits,
  make as makeProxy,
} from '../src/proxy'
import { settleOf, supervisorHolds } from '../src/run/holds'
import { makeSupervision } from '../src/run/supervisor'
import { WorkerEnd, WorkerTurn } from '../src/run/worker'
import { makeRunLog } from '../src/runlog'
import { ApiKey, SecretMissing, SecretName, Secrets } from '../src/secrets'
import { anthropicAnswer, anthropicBadKey } from './proxy-streams'

// The credentials hold (spec §14.6, H69): a call refused for its credential once a call to its provider
// has gone through in the run holds the run for that provider alone, whose calls the proxy's permits
// hold back while the run's other providers go on; the proxy probes the provider every
// `CREDENTIALS_PROBE` and the hold lifts once a probe goes through after a new key; past
// `credentials_wait` the run stops `CREDENTIALS`, exit 2. A worker whose turn ended on the refusal
// waits and carries on: its ticket is neither deferred, set aside nor counted. The provider is a
// loopback server taking one key at a time, reached through the real model proxy; the clock is the
// TestClock.

const run = RunId.make('run-credentials')
const one = TicketId.make('fa-c1')
const anthropic: ProviderName = 'anthropic'
const openai: ProviderName = 'openai'
const key: HoldKey = { hold: 'CREDENTIALS', provider: anthropic }
const WAIT = Duration.hours(6)
const zone = DateTime.layerCurrentZoneOffset(0)
const refusedReason = 'the provider refused the credential (HTTP 401)'

/** A line stream that keeps nothing: the records are read from the log's subscription. */
const nowhere = (path: string) => ({ path, append: () => Effect.void })

/** The run's log in memory, and its records as they are written. */
const runLog = Effect.gen(function* () {
  const log = yield* makeRunLog({
    run,
    events: nowhere('events.jsonl'),
    log: nowhere('run.log'),
  })
  const written = yield* log.subscribe
  return {
    log,
    records: Effect.map(
      PubSub.takeUpTo(written, 1_000),
      (taken): ReadonlyArray<RunEvent> => taken,
    ),
  }
})

const texts = (records: ReadonlyArray<RunEvent>) =>
  records.flatMap(event =>
    event.kind === 'hold' ||
    event.kind === 'credentials_hold' ||
    event.kind === 'credentials_lifted' ||
    event.kind === 'info'
      ? [event.text]
      : [],
  )

/**
 * A loopback provider taking, for each of its providers, only the key it holds now: a call with another
 * gets Anthropic's 401. It counts the calls that aren't probes.
 */
const fakeProvider = (accepted: Map<ProviderName, string>) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly url: string
      readonly workerCalls: () => number
      readonly close: () => void
    }>(resume => {
      let calls = 0
      const server = createServer((request, response) => {
        const chunks: Array<Buffer> = []
        request.on('data', (chunk: Buffer) => chunks.push(chunk))
        request.on('end', () => {
          const provider = (request.url ?? '').split('/')[1] ?? ''
          const given =
            request.headers['x-api-key'] ??
            (request.headers.authorization ?? '').replace(/^Bearer /u, '')
          if (!Buffer.concat(chunks).toString('utf8').includes('Say OK.'))
            calls += 1
          if (given === accepted.get(provider)) {
            response.writeHead(200, {
              'content-type': anthropicAnswer.contentType,
            })
            response.end(anthropicAnswer.body)
          } else {
            response.writeHead(401, { 'content-type': 'application/json' })
            response.end(anthropicBadKey)
          }
        })
      })
      server.listen({ host: '127.0.0.1', port: 0 }, () => {
        const address = server.address()
        const port =
          typeof address === 'object' && address !== null ? address.port : 0
        resume(
          Effect.succeed({
            url: `http://127.0.0.1:${port}`,
            workerCalls: () => calls,
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

const routesAt = (url: string): ReadonlyArray<ProviderRoute> =>
  [anthropic, openai].map(provider => ({
    provider,
    upstream: `${url}/${provider}`,
    api: 'anthropic-messages',
    authentication: Authentication.Header({
      header: 'x-api-key',
      credential: SecretName.make(provider),
    }),
  }))

const worker: Caller = {
  run,
  ticket: Option.some(one),
  session: Option.some(SessionId.make('s-c1')),
  model: 'anthropic/claude-test',
}

/**
 * The run's credentials hold over the real model proxy and its permits, a provider taking one key per
 * provider, and the secret store's keys, which the test changes as a new key is set; each probe the
 * hold makes is offered to `probed` once it has come to its outcome.
 */
const proxiedHold = Effect.gen(function* () {
  const stored = new Map<string, string>([
    [anthropic, 'sk-ant-old'],
    [openai, 'sk-openai'],
  ])
  const accepted = new Map<ProviderName, string>(stored)
  const provider = yield* fakeProvider(accepted)
  const secrets = Secrets.of({
    store: 'file',
    set: (name, value) =>
      Effect.sync(() => {
        if (ApiKey.$is('Key')(value))
          stored.set(name, Redacted.value(value.key))
      }),
    list: Effect.succeed([]),
    get: name =>
      Option.match(Option.fromUndefinedOr(stored.get(name)), {
        onNone: () => Effect.fail(new SecretMissing({ name })),
        onSome: value => Effect.succeed(Redacted.make(value)),
      }),
    remove: () => Effect.succeed(false),
  })
  const permits = yield* makePermits
  const proxy = yield* makeProxy({ routes: routesAt(provider.url) }).pipe(
    Effect.provideService(Secrets, secrets),
    Effect.provideService(Permits, permits),
  )
  const { log, records } = yield* runLog
  const holds = yield* makeHolds({ log, running: Effect.succeed(1) })
  const probed = yield* Queue.unbounded<ProbeOutcome>()
  const credentials = yield* makeCredentialsHold({
    holds,
    log,
    run,
    wait: WAIT,
    events: yield* proxy.events,
    probe: ({ provider, model }) =>
      Effect.tap(proxy.probe({ provider, model, run }), outcome =>
        Queue.offer(probed, outcome),
      ),
    modelFor: () => Option.some('claude-test'),
  })
  yield* permits.hold({
    run,
    held: holds.changes.pipe(Stream.map(heldProviders)),
  })
  const granted = yield* proxy.grant(worker)
  /** A worker's call to `to` through the proxy: its status. */
  const send = (to: ProviderName) =>
    Effect.promise(async () => {
      const response = await fetch(`${granted.baseUrls[to]}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': Redacted.value(granted.token),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: 'claude-test', messages: ['hi'] }),
      })
      await response.text()
      return response.status
    })
  return {
    holds,
    credentials,
    probed,
    records,
    send,
    workerCalls: provider.workerCalls,
    /** The provider takes a new key only: the old one is refused from now on. */
    revoke: () => accepted.set(anthropic, 'sk-ant-new'),
    /** The new key, set in the secret store as `credentials set` would. */
    newKey: secrets.set(
      SecretName.make(anthropic),
      ApiKey.Key({ key: Redacted.make('sk-ant-new') }),
    ),
  }
})

/** Waits for the hold on `key` to be raised. */
const raisedOn = (holds: HoldsShape) =>
  holds.changes.pipe(
    Stream.filter(snapshot =>
      snapshot.on.some(
        on =>
          on.hold === 'CREDENTIALS' && Option.contains(on.provider, anthropic),
      ),
    ),
    Stream.runHead,
  )

describe('the credentials hold', () => {
  it.effect(
    'holds only the provider whose key is refused mid-run, and lifts once a probe goes through on a new key',
    () =>
      Effect.gen(function* () {
        const kit = yield* proxiedHold
        // A call goes through: the run has begun on anthropic, so a refusal now is the credentials hold's.
        expect(yield* kit.send(anthropic)).toBe(200)
        kit.revoke()
        expect(yield* kit.send(anthropic)).toBe(401)
        yield* raisedOn(kit.holds)
        const held = yield* kit.holds.current
        expect(banners(held)).toEqual([
          `HOLD: CREDENTIALS (anthropic): anthropic's credential for anthropic was refused (${refusedReason}); sign in again or set a new key`,
        ])
        expect(clockHeld(held)).toBe(true)
        expect([...heldProviders(held)]).toEqual([anthropic])
        expect(Option.isNone(stopping(held))).toBe(true)

        // The held provider's next call waits for its permit; the run's other provider goes on.
        const callsBefore = kit.workerCalls()
        const waitingCall = yield* Effect.forkChild(kit.send(anthropic))
        expect(yield* kit.send(openai)).toBe(200)
        expect(kit.workerCalls()).toBe(callsBefore + 1)
        expect(waitingCall.pollUnsafe()).toBeUndefined()
        // The worker whose turn ended on the refusal waits on the hold.
        const waiting = yield* Effect.forkChild(
          kit.credentials.waitOut({
            ticket: one,
            provider: anthropic,
            account: Option.some(SecretName.make(anthropic)),
            reason: refusedReason,
          }),
        )

        // The old key is still refused: probed every minute, said once.
        yield* TestClock.adjust(CREDENTIALS_PROBE)
        expect((yield* Queue.take(kit.probed))._tag).toBe('Refused')
        yield* TestClock.adjust(CREDENTIALS_PROBE)
        expect((yield* Queue.take(kit.probed))._tag).toBe('Refused')
        expect(waitingCall.pollUnsafe()).toBeUndefined()
        expect(waiting.pollUnsafe()).toBeUndefined()
        expect(kit.workerCalls()).toBe(callsBefore + 1)

        // A new key: the next probe goes through, and the hold lifts.
        yield* kit.newKey
        yield* TestClock.adjust(CREDENTIALS_PROBE)
        expect((yield* Queue.take(kit.probed))._tag).toBe('Passed')
        yield* kit.holds.lifted(key)
        yield* Fiber.join(waiting)
        expect(yield* Fiber.join(waitingCall)).toBe(200)
        const lifted = yield* kit.holds.current
        expect(lifted.on).toEqual([])
        expect(clockHeld(lifted)).toBe(false)
        expect(Option.isNone(stopping(lifted))).toBe(true)

        const records = yield* kit.records
        expect(texts(records)).toEqual([
          `HOLD: CREDENTIALS: anthropic's credential for anthropic was refused (${refusedReason}); sign in again or set a new key; no new tickets while the 1 running finish`,
          "CREDENTIALS: anthropic refused a call of fa-c1's for its credential; the model proxy probes anthropic every 1m, and the run ends past credentials_wait, 6h",
          `CREDENTIALS: the model proxy's probe of anthropic was refused (${refusedReason}); probing again every 1m`,
          "anthropic's credential is taken again: anthropic answered the model proxy's probe",
          "CREDENTIALS lifted: anthropic answered the model proxy's probe",
        ])
        expect(
          records.flatMap(event =>
            event.kind === 'credentials_hold'
              ? [
                  {
                    provider: event.provider,
                    account: event.account,
                    ticket: event.ticket,
                    detail: event.detail,
                  },
                ]
              : [],
          ),
        ).toEqual([
          {
            provider: anthropic,
            account: 'anthropic',
            ticket: one,
            detail: refusedReason,
          },
        ])
      }).pipe(Effect.scoped, Effect.provide(zone)),
  )

  it.effect(
    'gives up past credentials_wait: the run stops CREDENTIALS, exit 2, still holding',
    () =>
      Effect.gen(function* () {
        const { log, records } = yield* runLog
        const holds = yield* makeHolds({ log, running: Effect.succeed(1) })
        const proxy = yield* PubSub.unbounded<ProxyEvent>()
        const probes = yield* Ref.make<ReadonlyArray<ModelName>>([])
        yield* makeCredentialsHold({
          holds,
          log,
          run,
          wait: WAIT,
          events: Stream.fromSubscription(yield* PubSub.subscribe(proxy)),
          probe: ({ model }) =>
            Effect.as(
              Ref.update(probes, made => [...made, model]),
              ProbeOutcome.Refused({
                refusal: Refusal.CredentialRefused({
                  reason: refusedReason,
                  account: Option.none(),
                }),
              }),
            ),
          modelFor: () => Option.some('claude-fallback'),
        })
        yield* PubSub.publish(
          proxy,
          ProxyEvent.Refused({
            provider: anthropic,
            caller: worker,
            refusal: Refusal.CredentialRefused({
              reason: refusedReason,
              account: Option.some(SecretName.make('anthropic')),
            }),
          }),
        )
        yield* raisedOn(holds)
        for (let n = 1; n < 360; n++) yield* TestClock.adjust(CREDENTIALS_PROBE)
        expect(Option.isNone(stopping(yield* holds.current))).toBe(true)
        yield* TestClock.adjust(CREDENTIALS_PROBE)
        yield* holds.lifted(key)
        // A probe every minute short of the wait, each on the refused call's model.
        const made = yield* Ref.get(probes)
        expect(made.length).toBe(359)
        expect(new Set(made)).toEqual(new Set(['claude-test']))
        const result = yield* holds.current
        const gaveUp = Option.getOrThrow(stopping(result))
        expect(gaveUp.kind).toBe('CREDENTIALS')
        expect(gaveUp.ticket).toEqual(Option.some(one))
        expect(gaveUp.detail).toBe(
          "anthropic's credential was still refused past credentials_wait, 6h",
        )
        expect(exitCodeOf(gaveUp.kind)).toBe(2)
        // It stays on: the run ends holding, its workers kept for the carry-over.
        expect(result.on.map(({ hold }) => hold)).toEqual(['CREDENTIALS'])
        // The refusal, said once though probed 359 times.
        expect(
          texts(yield* records).filter(text => text.includes('probe of')),
        ).toHaveLength(1)
      }).pipe(Effect.scoped, Effect.provide(zone)),
  )

  it.effect(
    'defers, sets aside and counts no ticket: its worker waits on the hold and carries on',
    () =>
      Effect.gen(function* () {
        const { log, records } = yield* runLog
        const holds = yield* makeHolds({ log, running: Effect.succeed(1) })
        const bus = yield* PubSub.unbounded<ProxyEvent>()
        const keySet = yield* Ref.make(false)
        const credentials = yield* makeCredentialsHold({
          holds,
          log,
          run,
          wait: WAIT,
          events: Stream.fromSubscription(yield* PubSub.subscribe(bus)),
          probe: () =>
            Effect.map(Ref.get(keySet), set =>
              set
                ? ProbeOutcome.Passed()
                : ProbeOutcome.Refused({
                    refusal: Refusal.CredentialRefused({
                      reason: refusedReason,
                      account: Option.none(),
                    }),
                  }),
            ),
          modelFor: () => Option.some('claude-test'),
        })
        const counted = yield* Ref.make<ReadonlyArray<Settle>>([])
        const supervision = yield* makeSupervision({
          proxy: Stream.fromSubscription(yield* PubSub.subscribe(bus)),
          holds: supervisorHolds({
            environment: {
              settled: settle => Ref.update(counted, all => [...all, settle]),
            },
            usage: { refused: () => Effect.void, waitOut: () => Effect.void },
            credentials,
          }),
          clock: {
            sleep: duration => Effect.sleep(duration),
            held: holds.changes.pipe(Stream.map(clockHeld), Stream.changes),
          },
          ticketLimit: Option.none(),
          fallbacks: [],
        })
        const worktree: Worktree = {
          ticket: one,
          path: '/work/fa-c1',
          branch: 'fabrica/fa-c1',
        }
        const finished = WorkerEnd.Deferred({ reason: 'the second turn' })
        const turns: Array<WorkerTurn> = []
        const firstEnded = yield* Deferred.make<void>()
        const watching = yield* Effect.forkChild(
          supervision.watch({
            ticket: one,
            session: SessionId.make('s-c1'),
            turn: WorkerTurn.First(),
            model: Option.some({ provider: anthropic, modelId: 'claude-test' }),
            run: attempt =>
              Effect.gen(function* () {
                turns.push(attempt.turn)
                yield* attempt.watcher.prepared(worktree)
                yield* attempt.watcher.started(
                  Option.some('/sessions/s-c1.jsonl'),
                )
                if (turns.length > 1) return finished
                // Its call refused for the credential mid-turn, which then ends with no outcome.
                yield* PubSub.publish(
                  bus,
                  ProxyEvent.Refused({
                    provider: anthropic,
                    caller: worker,
                    refusal: Refusal.CredentialRefused({
                      reason: refusedReason,
                      account: Option.some(SecretName.make('anthropic')),
                    }),
                  }),
                )
                yield* Effect.repeat(Effect.yieldNow, { times: 9 })
                yield* Deferred.succeed(firstEnded, undefined)
                return WorkerEnd.Unfinished()
              }),
          }),
        )
        yield* Deferred.await(firstEnded)
        yield* raisedOn(holds)
        yield* TestClock.adjust(Duration.minutes(30))
        // Half an hour on, it still waits: nothing ended its ticket.
        expect(watching.pollUnsafe()).toBeUndefined()
        expect(turns).toHaveLength(1)
        yield* Ref.set(keySet, true)
        yield* TestClock.adjust(CREDENTIALS_PROBE)
        // Its session resumed, told to carry on: the second turn's end is the ticket's.
        expect(yield* Fiber.join(watching)).toEqual(finished)
        expect(turns).toHaveLength(2)
        const resumed = turns[1]
        expect(resumed?._tag).toBe('HandBack')
        expect(
          resumed !== undefined && WorkerTurn.$is('HandBack')(resumed)
            ? resumed.prompt
            : '',
        ).toContain('the credential is usable again')
        // Not counted for the environment hold, neither the refusal nor a turn ended while it held.
        expect(yield* Ref.get(counted)).toEqual([])
        expect(
          settleOf({
            ticket: one,
            end: WorkerEnd.Unfinished(),
            quick: true,
            changed: false,
            providerHeld: true,
          }),
        ).toEqual(Settle.Uncounted())
        // The run's records say the hold and its lift, and nothing of the ticket.
        expect(
          (yield* records)
            .map(event => event.kind)
            .filter(kind => kind !== 'info'),
        ).toEqual(['hold', 'credentials_hold', 'credentials_lifted', 'hold'])
      }).pipe(Effect.scoped, Effect.provide(zone)),
  )
})
