import { Deferred, Effect, Option, Redacted, Stream } from 'effect'
import {
  type ServerResponse,
  createServer,
  request as httpRequest,
} from 'node:http'

import { describe, expect, it } from '@effect/vitest'
import { RunId, SessionId, TicketId } from '@fabrica/contracts'

import {
  Authentication,
  type Caller,
  Permits,
  type PermitsShape,
  make,
} from '../src/proxy'
import { SecretName, Secrets } from '../src/secrets'

// The model proxy lets go of a call the agent drops (spec §12.9): dropped before the provider's head
// has come, the upstream request is aborted and the call's permit released; dropped while it waits for
// its permit, it stops waiting. Without that, each such call held a permit and a provider's
// response open for good. Dropped partway through the provider's stream, its usage to then is counted.

/**
 * A loopback provider that is asked, and answers with `begin` at most, never ending its answer: it
 * tells when it was asked and when the call to it went.
 */
const provider = (begin: (response: ServerResponse) => void) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const asked = yield* Deferred.make<void>()
      const gone = yield* Deferred.make<void>()
      const server = createServer((request, response) => {
        request.resume()
        request.on('end', () => {
          begin(response)
          Deferred.doneUnsafe(asked, Effect.void)
        })
        response.on('close', () => Deferred.doneUnsafe(gone, Effect.void))
      })
      const url = yield* Effect.callback<string>(resume => {
        server.listen({ host: '127.0.0.1', port: 0 }, () => {
          const address = server.address()
          const port =
            typeof address === 'object' && address !== null ? address.port : 0
          resume(Effect.succeed(`http://127.0.0.1:${port}`))
        })
      })
      return { url, asked, gone, server }
    }),
    ({ server }) =>
      Effect.sync(() => {
        server.close()
        server.closeAllConnections()
      }),
  )

const caller: Caller = {
  run: RunId.make('run-1'),
  ticket: Option.some(TicketId.make('fab-a1b2')),
  session: Option.some(SessionId.make('session-1')),
  model: 'claude-sonnet-4-5',
}

const secrets = Secrets.of({
  store: 'file',
  set: () => Effect.void,
  list: Effect.succeed([]),
  get: () => Effect.succeed(Redacted.make('sk-ant-api03-real-anthropic-key')),
  remove: () => Effect.succeed(false),
})

/** A provider that never answers. */
const silent = () => {}

/** The proxy over a provider answering with `begin`, its permits `permits`; its events from the start, and the agent's token. */
const setup = (
  permits: PermitsShape,
  begin: (response: ServerResponse) => void = silent,
) =>
  Effect.gen(function* () {
    const upstream = yield* provider(begin)
    const proxy = yield* make({
      routes: [
        {
          provider: 'anthropic',
          upstream: `${upstream.url}/anthropic`,
          api: 'anthropic-messages',
          authentication: Authentication.Header({
            header: 'x-api-key',
            credential: SecretName.make('anthropic'),
          }),
        },
      ],
    }).pipe(
      Effect.provideService(Secrets, secrets),
      Effect.provideService(Permits, permits),
    )
    const events = yield* proxy.events
    const agent = yield* proxy.grant(caller)
    return { provider: upstream, events, agent }
  })

/**
 * An agent's call to the proxy, sent whole; dropping it closes its connection, as Pi's abort does.
 * `answered` is done once the first piece of its answer has come.
 */
const callFrom = (agent: {
  readonly baseUrls: Readonly<Record<string, string>>
  readonly token: Redacted.Redacted<string>
}) =>
  Effect.gen(function* () {
    const answered = yield* Deferred.make<void>()
    const request = httpRequest(
      `${agent.baseUrls['anthropic']}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': Redacted.value(agent.token),
        },
      },
      response =>
        response.once('data', () => Deferred.doneUnsafe(answered, Effect.void)),
    )
    request.on('error', () => {})
    request.end('{"model":"m","stream":true}')
    return { answered, drop: Effect.sync(() => request.destroy()) }
  })

/** A permit that tells when it is released. */
const telling = (released: Deferred.Deferred<void>): PermitsShape => ({
  take: () =>
    Effect.acquireRelease(Effect.void, () =>
      Deferred.succeed(released, undefined),
    ),
  hold: () => Effect.void,
})

describe('model proxy, a call the agent drops', () => {
  it.effect(
    "aborts the provider's request and releases its permit when dropped before its head",
    () =>
      Effect.gen(function* () {
        const released = yield* Deferred.make<void>()
        const { provider, agent } = yield* setup(telling(released))
        const call = yield* callFrom(agent)
        yield* Deferred.await(provider.asked)
        yield* call.drop
        yield* Deferred.await(provider.gone)
        yield* Deferred.await(released)
        expect(yield* Deferred.isDone(released)).toBe(true)
      }).pipe(Effect.scoped),
  )

  it.effect('stops waiting for its permit when dropped while it waits', () =>
    Effect.gen(function* () {
      const waiting = yield* Deferred.make<void>()
      const stopped = yield* Deferred.make<void>()
      const { provider, agent } = yield* setup({
        take: () =>
          Effect.andThen(
            Deferred.succeed(waiting, undefined),
            Effect.never,
          ).pipe(
            Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
          ),
        hold: () => Effect.void,
      })
      const call = yield* callFrom(agent)
      yield* Deferred.await(waiting)
      yield* call.drop
      yield* Deferred.await(stopped)
      expect(yield* Deferred.isDone(provider.asked)).toBe(false)
    }).pipe(Effect.scoped),
  )

  it.effect(
    'counts the usage read when dropped partway through the stream, and lets go of the call',
    () =>
      Effect.gen(function* () {
        const released = yield* Deferred.make<void>()
        const { provider, events, agent } = yield* setup(
          telling(released),
          response => {
            response.writeHead(200, { 'content-type': 'text/event-stream' })
            response.write(
              'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":1}}}\n\n',
            )
          },
        )
        const call = yield* callFrom(agent)
        yield* Deferred.await(call.answered)
        yield* call.drop
        const [event] = yield* Stream.runCollect(Stream.take(events, 1))
        expect(event).toMatchObject({
          _tag: 'Used',
          provider: 'anthropic',
          caller,
          tokens: { input: 100, output: 1, cache_write: 0, cache_read: 0 },
        })
        yield* Deferred.await(provider.gone)
        yield* Deferred.await(released)
      }).pipe(Effect.scoped),
  )
})
