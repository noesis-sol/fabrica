import {
  Context,
  Data,
  Effect,
  FiberSet,
  Layer,
  Option,
  PubSub,
  Redacted,
  Result,
  type Scope,
  Stream,
} from 'effect'
import { createHash } from 'node:crypto'
import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
  createServer,
  request as httpRequest,
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Readable, Transform } from 'node:stream'
import {
  createBrotliDecompress,
  createGunzip,
  createInflate,
  createZstdDecompress,
} from 'node:zlib'

import type { ModelName, ProviderName, RunId, Tokens } from '@fabrica/contracts'

import { drawToken } from '../control/token'
import { Secrets } from '../secrets'
import { type Caller, Permits } from './permits'
import { ProbeOutcome, probeRequest } from './probe'
import { type Refusal, classify, credentialRefusal } from './refusal'
import {
  Authentication,
  type ModelApi,
  type ProviderRoute,
  apiOf,
  credentialHeaders,
  targetOf,
  upstreamUrl,
} from './routes'
import { usageReader } from './usage'

// The model proxy (spec §12.9, H29): a loopback HTTP listener on 127.0.0.1, on a port of its own
// choosing, that every agent's model calls go through, so no agent holds a credential. Each agent's
// session is granted a token, the only way in, revoked as its session's scope closes. Each call is
// checked for its token, takes a permit (§14.2, §14.4), has the token swapped for the provider's
// credential from the secret store (§20.3), and has the provider's response streamed back unchanged,
// its bytes as they came, while the proxy reads the call's usage from it and what a refusal means.
// Usage and refusals are published, for telemetry and the holds.

/** What the proxy saw of a model call, for telemetry (§14.4, §21) and the holds (§14.2, §14.6). */
export type ProxyEvent = Data.TaggedEnum<{
  /** The call's tokens, as its response reported them. */
  Used: {
    readonly provider: ProviderName
    readonly caller: Caller
    readonly tokens: Tokens
  }
  /** The call was refused: a usage limit, a rate limit, a credential. */
  Refused: {
    readonly provider: ProviderName
    readonly caller: Caller
    readonly refusal: Refusal
  }
}>
export const ProxyEvent = Data.taggedEnum<ProxyEvent>()

/** An agent's way through the proxy, for its Pi's configuration (§12.1). */
export interface AgentProxy {
  /** Its token, given to Pi as each provider's key. */
  readonly token: Redacted.Redacted<string>
  /** Each provider's base URL at the proxy, by the provider's name. */
  readonly baseUrls: Readonly<Record<ProviderName, string>>
}

/** The proxy's listener couldn't be opened. */
export class ProxyFailed extends Data.TaggedError('ProxyFailed')<{
  readonly reason: string
}> {
  override get message() {
    return `the model proxy couldn't listen on 127.0.0.1: ${this.reason}`
  }
}

export interface ModelProxyShape {
  /** The proxy's address, `http://127.0.0.1:<port>`. */
  readonly address: string
  /** Grants a token counted to `caller`, for as long as the scope is open. */
  readonly grant: (
    caller: Caller,
  ) => Effect.Effect<AgentProxy, never, Scope.Scope>
  /** What the proxy sees from now on, for as long as the scope is open. */
  readonly events: Effect.Effect<Stream.Stream<ProxyEvent>, never, Scope.Scope>
  /** One small call to `provider`'s `model`, counted to `run`, past every permit. */
  readonly probe: (options: {
    readonly provider: ProviderName
    readonly model: ModelName
    readonly run: RunId
  }) => Effect.Effect<ProbeOutcome>
}

export class ModelProxy extends Context.Service<ModelProxy, ModelProxyShape>()(
  '@fabrica/engine/proxy/ModelProxy',
) {}

/** The providers the proxy reaches. */
export interface ProxyConfig {
  readonly routes: ReadonlyArray<ProviderRoute>
}

/** How the proxy's exchange with a provider went. */
type Exchanged = Data.TaggedEnum<{
  /** The provider answered, or refused: its response, unread. */
  Answered: {
    readonly upstream: IncomingMessage
    readonly refusal: Option.Option<Refusal>
  }
  /** The engine has no credential to send: missing, or its store or command failed. */
  NoCredential: { readonly refusal: Refusal; readonly reason: string }
  /** The provider couldn't be reached. */
  Unreachable: { readonly reason: string }
}>
const Exchanged = Data.taggedEnum<Exchanged>()

/** How a response's body is encoded, for reading its usage. */
type Encoding = Data.TaggedEnum<{
  Plain: {}
  Compressed: { readonly decompressor: Transform }
  /** An encoding the proxy doesn't read: passed on, not counted. */
  Unread: {}
}>
const Encoding = Data.taggedEnum<Encoding>()

const encodingOf = (header: string | undefined): Encoding => {
  switch ((header ?? '').trim().toLowerCase()) {
    case '':
    case 'identity':
      return Encoding.Plain()
    case 'gzip':
    case 'x-gzip':
      return Encoding.Compressed({ decompressor: createGunzip() })
    case 'deflate':
      return Encoding.Compressed({ decompressor: createInflate() })
    case 'br':
      return Encoding.Compressed({ decompressor: createBrotliDecompress() })
    case 'zstd':
      return Encoding.Compressed({ decompressor: createZstdDecompress() })
    default:
      return Encoding.Unread()
  }
}

/** Headers for one connection only, which a proxy never passes on. */
const hopByHop = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
])

/** `headers` without those for one connection, nor those named in `also`. */
const passed = (
  headers: IncomingHttpHeaders | Readonly<Record<string, string>>,
  also: ReadonlyArray<string>,
): OutgoingHttpHeaders =>
  Object.fromEntries(
    Object.entries(headers).filter(
      ([name, value]) =>
        value !== undefined &&
        !hopByHop.has(name.toLowerCase()) &&
        !also.includes(name.toLowerCase()),
    ),
  )

/** The headers a provider is sent: the agent's, its placeholder taken out and the credential put in. */
const outgoing = (
  headers: IncomingHttpHeaders | Readonly<Record<string, string>>,
  authentication: Authentication,
  credential: Option.Option<Redacted.Redacted<string>>,
): OutgoingHttpHeaders => {
  const kept = passed(headers, credentialHeaders)
  return Option.match(credential, {
    onNone: () => kept,
    onSome: key =>
      Authentication.$match(authentication, {
        Header: ({ header }) => ({ ...kept, [header]: Redacted.value(key) }),
        Bearer: () => ({
          ...kept,
          authorization: `Bearer ${Redacted.value(key)}`,
        }),
        None: () => kept,
      }),
  })
}

/** The token a request carries: as a bearer, or as one of the key headers providers use. */
const tokensOf = (headers: IncomingHttpHeaders): ReadonlyArray<string> =>
  credentialHeaders.flatMap(name => {
    const value = headers[name]
    if (typeof value !== 'string') return []
    const bearer = /^Bearer\s+(\S+)$/iu.exec(value.trim())
    return [bearer?.[1] ?? value.trim()]
  })

/** A token's key in the proxy's grants: its SHA-256, so finding it takes no time that tells its text. */
const digestOf = (token: string): string =>
  createHash('sha256').update(token).digest('hex')

/** Answers the agent with an error of the proxy's own, in the shape the providers' clients read. */
const reply = (response: ServerResponse, status: number, message: string) =>
  Effect.sync(() => {
    if (response.headersSent) {
      response.destroy()
      return
    }
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        type: 'error',
        error: { type: 'model_proxy_error', message },
      }),
    )
  })

const listen = (server: Server) =>
  Effect.callback<number, ProxyFailed>(resume => {
    const failed = (error: Error) =>
      resume(Effect.fail(new ProxyFailed({ reason: error.message })))
    server.once('error', failed)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      server.off('error', failed)
      const address = server.address()
      resume(
        typeof address === 'object' && address !== null
          ? Effect.succeed(address.port)
          : Effect.fail(new ProxyFailed({ reason: 'it has no port' })),
      )
    })
  })

/** Sends a request to the provider; its response, once its head has come. */
const send = (options: {
  readonly url: URL
  readonly method: string
  readonly headers: OutgoingHttpHeaders
  readonly body: Readable | string
}) =>
  Effect.callback<IncomingMessage, string>((resume, signal) => {
    let settled = false
    const settle = (effect: Effect.Effect<IncomingMessage, string>) => {
      if (settled) return
      settled = true
      resume(effect)
    }
    const request = (
      options.url.protocol === 'https:' ? httpsRequest : httpRequest
    )(
      options.url,
      {
        method: options.method,
        // A body the proxy makes (a probe's) is sent whole, its length given.
        headers:
          typeof options.body === 'string'
            ? {
                ...options.headers,
                'content-length': Buffer.byteLength(options.body),
              }
            : options.headers,
        signal,
      },
      upstream => settle(Effect.succeed(upstream)),
    )
    request.on('error', error => settle(Effect.fail(error.message)))
    if (typeof options.body === 'string') request.end(options.body)
    else options.body.pipe(request)
  })

/**
 * Passes the provider's response on to `sink` as it comes (or reads it through, for a probe), and
 * reads its usage on the way; ends with the tokens read when the response ends or either side goes.
 */
const relay = (options: {
  readonly upstream: IncomingMessage
  readonly api: Option.Option<ModelApi>
  readonly sink: Option.Option<ServerResponse>
}) =>
  Effect.callback<Option.Option<Tokens>>(resume => {
    const { upstream } = options
    const contentType = upstream.headers['content-type'] ?? ''
    const reader = Option.map(options.api, api => usageReader(api, contentType))
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      resume(Effect.sync(() => Option.flatMap(reader, read => read.finish())))
    }
    upstream.on('error', finish)
    upstream.on('close', () => {
      if (!upstream.complete) finish()
    })

    Option.match(reader, {
      onNone: () => upstream.on('end', finish),
      onSome: read =>
        Encoding.$match(encodingOf(upstream.headers['content-encoding']), {
          Plain: () => {
            upstream.on('data', read.feed)
            upstream.on('end', finish)
          },
          Compressed: ({ decompressor }) => {
            decompressor.on('data', read.feed)
            decompressor.on('end', finish)
            decompressor.on('error', finish)
            upstream.on('data', chunk => decompressor.write(chunk))
            upstream.on('end', () => decompressor.end())
          },
          Unread: () => upstream.on('end', finish),
        }),
    })

    Option.match(options.sink, {
      onNone: () => upstream.resume(),
      onSome: response => {
        response.writeHead(
          upstream.statusCode ?? 502,
          upstream.statusMessage,
          passed(upstream.headers, []),
        )
        response.on('close', () => {
          if (!response.writableFinished) {
            upstream.destroy()
            finish()
          }
        })
        upstream.pipe(response)
      },
    })
  })

export const make = Effect.fn('ModelProxy.make')(function* (
  config: ProxyConfig,
) {
  const secrets = yield* Secrets
  const permits = yield* Permits
  const published = yield* PubSub.unbounded<ProxyEvent>()
  const routes = new Map(config.routes.map(route => [route.provider, route]))
  /** The callers granted a token, by the token's digest. */
  const grants = new Map<string, Caller>()
  /** Each run's providers a call has gone through to. */
  const wentThrough = new Map<RunId, Set<ProviderName>>()
  const hasGoneThrough = (run: RunId, provider: ProviderName) =>
    wentThrough.get(run)?.has(provider) ?? false

  const credentialOf = (authentication: Authentication) =>
    Authentication.$match(authentication, {
      Header: ({ credential }) =>
        Effect.map(secrets.get(credential), Option.some),
      Bearer: ({ credential }) =>
        Effect.map(secrets.get(credential), Option.some),
      None: () => Effect.succeedNone,
    })

  /** Sends the call to its provider with the credential in its token's place, and reads what its answer refuses. */
  const exchange = Effect.fn('ModelProxy.exchange')(function* (call: {
    readonly route: ProviderRoute
    readonly caller: Caller
    readonly method: string
    readonly path: string
    readonly headers: IncomingHttpHeaders | Readonly<Record<string, string>>
    readonly body: Readable | string
  }) {
    const { route, caller } = call
    const refused = (refusal: Refusal) =>
      PubSub.publish(
        published,
        ProxyEvent.Refused({ provider: route.provider, caller, refusal }),
      )
    const credential = yield* Effect.result(credentialOf(route.authentication))
    if (Result.isFailure(credential)) {
      const reason = credential.failure.message
      const refusal = credentialRefusal({
        wentThrough: hasGoneThrough(caller.run, route.provider),
        reason,
      })
      yield* refused(refusal)
      return Exchanged.NoCredential({ refusal, reason })
    }
    const sent = yield* Effect.result(
      send({
        url: upstreamUrl(route, call.path),
        method: call.method,
        headers: outgoing(
          call.headers,
          route.authentication,
          credential.success,
        ),
        body: call.body,
      }),
    )
    if (Result.isFailure(sent))
      return Exchanged.Unreachable({ reason: sent.failure })
    const upstream = sent.success
    yield* Effect.addFinalizer(() => Effect.sync(() => upstream.destroy()))
    const status = upstream.statusCode ?? 502
    const refusal = classify({
      status,
      headers: upstream.headers,
      wentThrough: hasGoneThrough(caller.run, route.provider),
    })
    if (status >= 200 && status < 300) {
      const providers = wentThrough.get(caller.run) ?? new Set()
      wentThrough.set(caller.run, providers.add(route.provider))
    }
    if (Option.isSome(refusal)) yield* refused(refusal.value)
    return Exchanged.Answered({ upstream, refusal })
  })

  /** Passes the answer on and publishes the tokens it reports. */
  const answer = (options: {
    readonly route: ProviderRoute
    readonly caller: Caller
    readonly path: string
    readonly upstream: IncomingMessage
    readonly sink: Option.Option<ServerResponse>
  }) =>
    Effect.flatMap(
      relay({
        upstream: options.upstream,
        api: apiOf(options.path),
        sink: options.sink,
      }),
      Option.match({
        onNone: () => Effect.void,
        onSome: tokens =>
          PubSub.publish(
            published,
            ProxyEvent.Used({
              provider: options.route.provider,
              caller: options.caller,
              tokens,
            }),
          ).pipe(Effect.asVoid),
      }),
    )

  const handle = (request: IncomingMessage, response: ServerResponse) =>
    Effect.gen(function* () {
      const target = targetOf(request.url ?? '')
      if (Option.isNone(target))
        return yield* reply(response, 404, 'this path names no provider')
      const route = routes.get(target.value.provider)
      if (route === undefined)
        return yield* reply(
          response,
          404,
          `the model proxy reaches no provider named ${target.value.provider}`,
        )
      const caller = tokensOf(request.headers)
        .map(token => grants.get(digestOf(token)))
        .find(granted => granted !== undefined)
      if (caller === undefined)
        return yield* reply(
          response,
          401,
          "the model proxy doesn't know this token",
        )
      yield* permits.take({ provider: route.provider, caller })
      const exchanged = yield* exchange({
        route,
        caller,
        method: request.method ?? 'GET',
        path: target.value.path,
        headers: request.headers,
        body: request,
      })
      return yield* Exchanged.$match(exchanged, {
        NoCredential: ({ reason }) => reply(response, 401, reason),
        Unreachable: ({ reason }) =>
          reply(
            response,
            502,
            `${route.provider} couldn't be reached: ${reason}`,
          ),
        Answered: ({ upstream }) =>
          answer({
            route,
            caller,
            path: target.value.path,
            upstream,
            sink: Option.some(response),
          }),
      })
    }).pipe(
      Effect.scoped,
      Effect.onInterrupt(() => Effect.sync(() => response.destroy())),
      Effect.catchCause(cause =>
        Effect.andThen(
          Effect.logError('The model proxy failed a call', cause),
          reply(response, 502, 'the model proxy failed the call'),
        ),
      ),
    )

  const fork = yield* FiberSet.makeRuntime<never>()
  const server = createServer((request, response) => {
    fork(handle(request, response))
  })
  const port = yield* listen(server)
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      server.close()
      server.closeAllConnections()
    }),
  )
  const address = `http://127.0.0.1:${port}`

  const grant = Effect.fn('ModelProxy.grant')(function* (caller: Caller) {
    const token = yield* drawToken
    const digest = digestOf(Redacted.value(token))
    yield* Effect.acquireRelease(
      Effect.sync(() => grants.set(digest, caller)),
      () => Effect.sync(() => grants.delete(digest)),
    )
    return {
      token,
      baseUrls: Object.fromEntries(
        config.routes.map(route => [
          route.provider,
          `${address}/${route.provider}`,
        ]),
      ),
    } satisfies AgentProxy
  })

  const probe = Effect.fn('ModelProxy.probe')(function* (options: {
    readonly provider: ProviderName
    readonly model: ModelName
    readonly run: RunId
  }) {
    const route = routes.get(options.provider)
    if (route === undefined)
      return ProbeOutcome.Failed({
        reason: `the model proxy reaches no provider named ${options.provider}`,
      })
    const caller: Caller = {
      run: options.run,
      ticket: Option.none(),
      session: Option.none(),
      model: options.model,
    }
    const request = probeRequest(route.api, options.model)
    const exchanged = yield* exchange({
      route,
      caller,
      method: 'POST',
      path: request.path,
      headers: request.headers,
      body: request.body,
    })
    return yield* Exchanged.$match(exchanged, {
      NoCredential: ({ refusal }) =>
        Effect.succeed(ProbeOutcome.Refused({ refusal })),
      Unreachable: ({ reason }) =>
        Effect.succeed(
          ProbeOutcome.Failed({
            reason: `${route.provider} couldn't be reached: ${reason}`,
          }),
        ),
      Answered: ({ upstream, refusal }) =>
        Effect.as(
          answer({
            route,
            caller,
            path: request.path,
            upstream,
            sink: Option.none(),
          }),
          Option.match(refusal, {
            onSome: refusal => ProbeOutcome.Refused({ refusal }),
            onNone: () => {
              const status = upstream.statusCode ?? 502
              return status >= 200 && status < 300
                ? ProbeOutcome.Passed()
                : ProbeOutcome.Failed({
                    reason: `${route.provider} answered HTTP ${status}`,
                  })
            },
          }),
        ),
    })
  }, Effect.scoped)

  return ModelProxy.of({
    address,
    grant,
    events: Effect.map(PubSub.subscribe(published), Stream.fromSubscription),
    probe,
  })
})

/** The model proxy, listening for as long as the layer lives, over the secret store and the permits. */
export const layer = (
  config: ProxyConfig,
): Layer.Layer<ModelProxy, ProxyFailed, Secrets | Permits> =>
  Layer.effect(ModelProxy, make(config))
