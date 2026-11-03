import {
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Redacted,
  Stream,
} from 'effect'
import { RpcTest } from 'effect/rpc'
import { type IncomingHttpHeaders, createServer } from 'node:http'

import type {
  AuthInteraction,
  OAuthAuth,
  OAuthCredential,
} from '@earendil-works/pi-ai'
import { type Provider, createProvider } from '@earendil-works/pi-ai/models'
import { describe, expect, it } from '@effect/vitest'
import {
  CredentialInfo,
  CredentialValue,
  EngineId,
  EngineVersion,
  type LoginStep,
  ModelName,
  RunId,
  SecretRpcs,
  SessionId,
  TicketId,
  protocolVersion,
} from '@fabrica/contracts'

import { modelsJson } from '../src/agent/launch'
import { Engine } from '../src/engine/service'
import { ProcessRunner } from '../src/process'
import {
  Authentication,
  type Caller,
  type ProviderRoute,
  ProxyEvent,
  Refusal,
  chatGptCompat,
  deviceIdOf,
  layerOpen,
  make,
  makeSubscriptions,
  subscriptionEntry,
  subscriptionProviders,
} from '../src/proxy'
import { secretsHandlers, termsNotice } from '../src/rpc/secrets'
import { RunHosting, RunHostingShape } from '../src/run/hosting'
import {
  ApiKey,
  Held,
  type ItemStore,
  Kept,
  SecretMissing,
  SecretName,
  Secrets,
  type SecretsShape,
  decodeKept,
  encodeKept,
  makeSecrets,
  oauthStore,
} from '../src/secrets'

// Subscription sign-ins and their tokens in the model proxy (spec §12.9, §20.3): `pi-ai`'s `Models` run
// for real over the engine's secret store, on an in-memory store, with a provider whose sign-in and
// refresh the test scripts. A sign-in's steps relayed to the client that asked and its questions answered;
// a token refreshed as it expires, two agents sharing one refresh, and written back; a refresh that fails
// raising the refusal, saying nothing of what the provider answered; the placeholder Pi needs.

const anthropic = SecretName.make('anthropic')

/** An item store in memory, as a keyring holds them. */
const memoryStore = (): ItemStore & {
  readonly items: Map<string, Redacted.Redacted<string>>
} => {
  const items = new Map<string, Redacted.Redacted<string>>()
  return {
    kind: 'file',
    items,
    read: item => Effect.sync(() => Option.fromUndefinedOr(items.get(item))),
    write: (item, value) =>
      Effect.sync(() => {
        items.set(item, value)
      }),
    remove: item =>
      Effect.sync(() => {
        items.delete(item)
      }),
  }
}

/** The engine's secret store over memory; its key commands are never run here. */
const memorySecrets = Effect.suspend(() =>
  makeSecrets({ store: memoryStore(), cwd: '/nowhere' }),
).pipe(
  Effect.provideService(
    ProcessRunner,
    ProcessRunner.of({
      run: () => Effect.die('a test ran a key command'),
      start: () => Effect.die('a test ran a key command'),
    }),
  ),
)

/** A credential whose token has long expired, or never will: `pi-ai` reads the clock itself. */
const signedIn = (
  access: string,
  expires: number = Number.MAX_SAFE_INTEGER,
): OAuthCredential => ({
  type: 'oauth',
  access,
  refresh: `${access}-refresh`,
  expires,
})

const keep = (
  secrets: SecretsShape,
  provider: string,
  credential: OAuthCredential,
) =>
  secrets.modify(SecretName.make(provider), () =>
    Effect.succeed(
      Option.some(
        Kept.OAuth({
          provider,
          credential: Redacted.make(JSON.stringify(credential)),
        }),
      ),
    ),
  )

/** The token kept under `name`, as a sign-in's. */
const accessKept = (secrets: SecretsShape, name: SecretName) =>
  Effect.promise(() => oauthStore(secrets).read(name)).pipe(
    Effect.map(credential =>
      credential?.type === 'oauth' ? credential.access : 'not a sign-in',
    ),
  )

/** A provider whose sign-in and refresh a test gives. */
const scripted = (
  id: string,
  auth: {
    readonly login?: OAuthAuth['login']
    readonly refresh?: OAuthAuth['refresh']
    readonly toAuth?: OAuthAuth['toAuth']
  },
): Provider =>
  createProvider({
    id,
    auth: {
      oauth: {
        name: id,
        login:
          auth.login ??
          (() => Promise.reject(new Error('this test signs in to nothing'))),
        refresh:
          auth.refresh ??
          (() => Promise.reject(new Error('this test refreshes nothing'))),
        toAuth:
          auth.toAuth ??
          (credential => Promise.resolve({ apiKey: credential.access })),
      },
    },
    models: [],
    api: {
      stream: () => {
        throw new Error('no model is called here')
      },
      streamSimple: () => {
        throw new Error('no model is called here')
      },
    },
  })

// The Secrets group, through its handlers

const engineId = EngineId.make('engine-one')

/** The engine the handlers run on: they read only its ID. */
const thisEngine = Engine.of({
  id: engineId,
  version: new EngineVersion({
    release: '1.2.3',
    protocol: protocolVersion,
    supported: [protocolVersion],
  }),
  listening: Option.none(),
  status: () => Effect.die('not asked here'),
  settings: Effect.die('not asked here'),
  stop: Effect.void,
  restart: () => Effect.void,
  stopping: Effect.succeed(false),
  stopRequested: Effect.never,
})

/** A client of the Secrets group, on `credentials`; a hosting refusing runs serves it all the same. */
const clientOf = (hosting: RunHostingShape) =>
  RpcTest.makeClient(SecretRpcs).pipe(
    Effect.provide(
      secretsHandlers.pipe(
        Layer.provide([
          Layer.succeed(RunHosting)(hosting),
          Layer.succeed(Engine)(thisEngine),
        ]),
      ),
    ),
  )

const refusedWith = (
  secrets: SecretsShape,
  providers: ReadonlyArray<Provider>,
) =>
  RunHostingShape.Refused({
    reason: "this engine can't run a project: no Pi",
    credentials: { secrets, providers },
  })

/** A sign-in's steps as they come, on a queue; its fiber ends with the stream. */
const follow = (stream: Stream.Stream<LoginStep, { readonly _tag: string }>) =>
  Effect.gen(function* () {
    const steps = yield* Queue.unbounded<LoginStep>()
    const ended = yield* stream.pipe(
      Stream.runForEach(step => Queue.offer(steps, step)),
      Effect.exit,
      Effect.forkScoped,
    )
    return { steps, ended }
  })

describe('a sign-in', () => {
  it.live(
    'relays what it says to the client that asked, takes its answers, and keeps the sign-in',
    () =>
      Effect.gen(function* () {
        const secrets = yield* memorySecrets
        const provider = scripted('anthropic', {
          login: async interaction => {
            const method = await interaction.prompt({
              type: 'select',
              message: 'How?',
              options: [
                { id: 'browser', label: 'Browser' },
                { id: 'copy_code', label: 'Copy a code' },
              ],
            })
            interaction.notify({
              type: 'auth_url',
              url: `https://claude.test/oauth?method=${method}`,
              instructions: 'Paste the code here.',
            })
            interaction.notify({
              type: 'device_code',
              userCode: 'ABCD-1234',
              verificationUri: 'https://device.test',
            })
            const code = await interaction.prompt({
              type: 'manual_code',
              message: 'The code:',
              placeholder: 'code#state',
            })
            interaction.notify({ type: 'progress', message: 'Exchanging...' })
            return signedIn(`token-for-${code}`)
          },
        })
        const client = yield* clientOf(refusedWith(secrets, [provider]))
        const { steps, ended } = yield* follow(
          client['credentials.login']({ provider: 'anthropic' }),
        )

        expect(yield* Queue.take(steps)).toMatchObject({
          _tag: 'terms',
          text: termsNotice,
        })
        const method = yield* Queue.take(steps)
        if (method._tag !== 'asked') return expect.fail(method._tag)
        expect(method.message).toBe('How?')
        expect(method.secret).toBe(false)
        expect(method.choices).toStrictEqual([
          { id: 'browser', label: 'Browser' },
          { id: 'copy_code', label: 'Copy a code' },
        ])
        yield* client['credentials.answerLogin']({
          login: method.login,
          answer: Redacted.make('copy_code'),
        })

        expect(yield* Queue.take(steps)).toMatchObject({
          _tag: 'open_url',
          url: 'https://claude.test/oauth?method=copy_code',
          instructions: Option.some('Paste the code here.'),
        })
        expect(yield* Queue.take(steps)).toMatchObject({
          _tag: 'device_code',
          url: 'https://device.test',
          code: 'ABCD-1234',
        })
        const code = yield* Queue.take(steps)
        if (code._tag !== 'asked') return expect.fail(code._tag)
        expect(code.placeholder).toStrictEqual(Option.some('code#state'))
        // Only the question waiting takes an answer, and once.
        const unknown = yield* Effect.flip(
          client['credentials.answerLogin']({
            login: 'another',
            answer: Redacted.make('x'),
          }),
        )
        expect(unknown._tag).toBe('LoginNotWaiting')
        yield* client['credentials.answerLogin']({
          login: code.login,
          answer: Redacted.make('pasted'),
        })

        expect(yield* Queue.take(steps)).toMatchObject({
          _tag: 'waiting',
          text: 'Exchanging...',
        })
        expect(yield* Queue.take(steps)).toMatchObject({
          _tag: 'signed_in',
          account: Option.some('anthropic'),
        })
        expect((yield* Fiber.join(ended))._tag).toBe('Success')

        expect(yield* accessKept(secrets, anthropic)).toBe('token-for-pasted')
        expect(yield* client['credentials.list']()).toStrictEqual([
          CredentialInfo.make({
            name: 'anthropic',
            kind: 'oauth',
            provider: Option.some('anthropic'),
          }),
        ])
        expect(yield* secrets.get(anthropic)).toStrictEqual(
          Held.Subscription({ provider: 'anthropic' }),
        )
      }).pipe(Effect.scoped),
  )

  it.live('takes the blank answer GitHub Copilot’s question has', () =>
    Effect.gen(function* () {
      const secrets = yield* memorySecrets
      const answers: Array<string> = []
      const provider = scripted('github-copilot', {
        login: async interaction => {
          answers.push(
            await interaction.prompt({
              type: 'text',
              message: 'GitHub Enterprise domain (blank for github.com)',
            }),
          )
          return signedIn('copilot')
        },
      })
      const client = yield* clientOf(refusedWith(secrets, [provider]))
      const { steps, ended } = yield* follow(
        client['credentials.login']({ provider: 'github-copilot' }),
      )
      yield* Queue.take(steps)
      const asked = yield* Queue.take(steps)
      if (asked._tag !== 'asked') return expect.fail(asked._tag)
      yield* client['credentials.answerLogin']({
        login: asked.login,
        answer: Redacted.make(''),
      })
      yield* Fiber.join(ended)
      expect(answers).toStrictEqual([''])
    }).pipe(Effect.scoped),
  )

  it.live('goes past a question its browser sign-in overtook', () =>
    Effect.gen(function* () {
      const secrets = yield* memorySecrets
      const callback = yield* Deferred.make<void>()
      const provider = scripted('openai', {
        login: async interaction => {
          const overtaken = new AbortController()
          const typed = interaction
            .prompt({
              type: 'manual_code',
              message: 'Or paste the redirect URL:',
              signal: overtaken.signal,
            })
            .catch(() => 'overtaken')
          await Effect.runPromise(Deferred.await(callback))
          overtaken.abort(new Error('the browser answered'))
          return signedIn(await typed)
        },
      })
      const client = yield* clientOf(refusedWith(secrets, [provider]))
      const { steps, ended } = yield* follow(
        client['credentials.login']({ provider: 'openai' }),
      )
      yield* Queue.take(steps)
      const asked = yield* Queue.take(steps)
      if (asked._tag !== 'asked') return expect.fail(asked._tag)

      yield* Deferred.succeed(callback, undefined)
      yield* Fiber.join(ended)

      const late = yield* Effect.flip(
        client['credentials.answerLogin']({
          login: asked.login,
          answer: Redacted.make('too late'),
        }),
      )
      expect(late._tag).toBe('LoginNotWaiting')
      expect(yield* accessKept(secrets, SecretName.make('openai'))).toBe(
        'overtaken',
      )
    }).pipe(Effect.scoped),
  )

  it.live('fails saying why, keeping what was kept', () =>
    Effect.gen(function* () {
      const secrets = yield* memorySecrets
      yield* secrets.set(
        anthropic,
        ApiKey.Key({ key: Redacted.make('sk-kept') }),
      )
      const provider = scripted('anthropic', {
        login: () => Promise.reject(new Error('the provider said no')),
      })
      const client = yield* clientOf(refusedWith(secrets, [provider]))
      const failed = yield* client['credentials.login']({
        provider: 'anthropic',
      }).pipe(Stream.runDrain, Effect.flip)
      expect(failed).toMatchObject({
        _tag: 'LoginFailed',
        provider: 'anthropic',
        reason: 'the provider said no',
      })
      expect(yield* secrets.get(anthropic)).toStrictEqual(
        Held.Key({ key: Redacted.make('sk-kept') }),
      )

      const none = yield* client['credentials.login']({
        provider: 'ollama',
      }).pipe(Stream.runDrain, Effect.flip)
      expect(none).toMatchObject({
        _tag: 'LoginFailed',
        reason: 'ollama has no sign-in in pi-ai',
      })
    }).pipe(Effect.scoped),
  )

  it.live('ends as its client goes, and its question with it', () =>
    Effect.gen(function* () {
      const secrets = yield* memorySecrets
      const aborted = yield* Deferred.make<void>()
      const provider = scripted('anthropic', {
        login: (interaction: AuthInteraction) => {
          interaction.signal?.addEventListener('abort', () =>
            Deferred.doneUnsafe(aborted, Effect.void),
          )
          return interaction
            .prompt({ type: 'manual_code', message: 'The code:' })
            .then(() => signedIn('never'))
        },
      })
      const client = yield* clientOf(refusedWith(secrets, [provider]))
      const steps = yield* Queue.unbounded<LoginStep>()
      const fiber = yield* client['credentials.login']({
        provider: 'anthropic',
      }).pipe(
        Stream.runForEach(step => Queue.offer(steps, step)),
        Effect.forkScoped,
      )
      yield* Queue.take(steps)
      const asked = yield* Queue.take(steps)
      if (asked._tag !== 'asked') return expect.fail(asked._tag)

      yield* Fiber.interrupt(fiber)
      yield* Deferred.await(aborted)
      const late = yield* Effect.flip(
        client['credentials.answerLogin']({
          login: asked.login,
          answer: Redacted.make('too late'),
        }),
      )
      expect(late._tag).toBe('LoginNotWaiting')
      expect(yield* secrets.read(anthropic)).toStrictEqual(Option.none())
    }).pipe(Effect.scoped),
  )
})

describe('a sign-in with pi-ai’s own providers', () => {
  it('draws a UUID for ChatGPT’s agent host, the same each time, naming no engine', () => {
    const id = deviceIdOf(engineId)
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u,
    )
    expect(deviceIdOf(engineId)).toBe(id)
    expect(deviceIdOf(EngineId.make('engine-two'))).not.toBe(id)
  })

  it.live('gets each provider as far as what it first relays', () =>
    Effect.gen(function* () {
      const secrets = yield* memorySecrets
      const client = yield* clientOf(
        refusedWith(secrets, subscriptionProviders()),
      )
      for (const [provider, first] of [
        ['anthropic', 'asked'],
        ['github-copilot', 'asked'],
        ['openrouter', 'waiting'],
        ['openai', 'open_url'],
      ] as const) {
        const steps = yield* Queue.unbounded<LoginStep>()
        const failed = yield* Deferred.make<string>()
        const going = yield* client['credentials.login']({ provider }).pipe(
          Stream.runForEach(step => Queue.offer(steps, step)),
          Effect.catchTag('LoginFailed', ({ reason }) =>
            Deferred.succeed(failed, reason),
          ),
          Effect.forkScoped,
        )
        expect((yield* Queue.take(steps))._tag).toBe('terms')
        const next = yield* Effect.raceFirst(
          Effect.map(Queue.take(steps), step => step._tag),
          Deferred.await(failed),
        )
        // ChatGPT's sign-in listens on a port of its own, which another test on this machine may hold.
        if (!next.startsWith('Port 1455 is in use')) expect(next).toBe(first)
        yield* Fiber.interrupt(going)
      }
    }).pipe(Effect.scoped),
  )
})

describe('the Secrets group', () => {
  it.live('sets by name, lists names and kinds only, and removes', () =>
    Effect.gen(function* () {
      const secrets = yield* memorySecrets
      const client = yield* clientOf(refusedWith(secrets, []))
      yield* client['credentials.set']({
        name: 'openai.work',
        value: CredentialValue.cases.key.make({ key: Redacted.make('sk-1') }),
        provider: Option.some('openai'),
      })
      yield* client['credentials.set']({
        name: 'google',
        value: CredentialValue.cases.command.make({ command: 'op read k' }),
        provider: Option.none(),
      })
      expect(yield* client['credentials.list']()).toStrictEqual([
        CredentialInfo.make({
          name: 'google',
          kind: 'command',
          provider: Option.none(),
        }),
        CredentialInfo.make({
          name: 'openai.work',
          kind: 'key',
          provider: Option.some('openai'),
        }),
      ])
      yield* client['credentials.remove']({ name: 'google' })
      const gone = yield* Effect.flip(
        client['credentials.remove']({ name: 'google' }),
      )
      expect(gone._tag).toBe('CredentialNotFound')
      const bad = yield* Effect.flip(
        client['credentials.set']({
          name: '.names',
          value: CredentialValue.cases.key.make({ key: Redacted.make('x') }),
          provider: Option.none(),
        }),
      )
      expect(bad._tag).toBe('CredentialStoreFailed')
    }).pipe(Effect.scoped),
  )

  it.live('says why where the engine has no store', () =>
    Effect.gen(function* () {
      const client = yield* clientOf(
        RunHostingShape.Refused({ reason: 'this host needs a passphrase' }),
      )
      expect(yield* Effect.flip(client['credentials.list']())).toMatchObject({
        _tag: 'CredentialStoreFailed',
        reason: 'this host needs a passphrase',
      })
      expect(
        yield* client['credentials.login']({ provider: 'anthropic' }).pipe(
          Stream.runDrain,
          Effect.flip,
        ),
      ).toMatchObject({
        _tag: 'LoginFailed',
        reason: 'this host needs a passphrase',
      })
    }).pipe(Effect.scoped),
  )
})

describe('what is kept', () => {
  it('reads a key kept before sign-ins, and each form back', () => {
    expect(
      decodeKept(Redacted.make('{"_tag":"Key","key":"sk-old"}')),
    ).toStrictEqual(
      Option.some(
        Kept.Key({ key: Redacted.make('sk-old'), provider: Option.none() }),
      ),
    )
    const forms = [
      Kept.Key({ key: Redacted.make('k'), provider: Option.some('openai') }),
      Kept.Command({ command: 'op read k', provider: Option.none() }),
      Kept.OAuth({ provider: 'anthropic', credential: Redacted.make('{}') }),
    ]
    for (const kept of forms)
      expect(decodeKept(encodeKept(kept))).toStrictEqual(Option.some(kept))
    expect(decodeKept(Redacted.make('not json'))).toStrictEqual(Option.none())
  })

  it.live(
    'runs no key’s command for pi-ai, and setting waits for a change',
    () =>
      Effect.gen(function* () {
        const secrets = yield* memorySecrets
        yield* secrets.set(anthropic, ApiKey.Command({ command: 'exit 1' }))
        const store = oauthStore(secrets)
        expect(
          yield* Effect.promise(() => store.read('anthropic')),
        ).toStrictEqual({ type: 'api_key' })
        expect(yield* Effect.promise(() => store.list())).toStrictEqual([
          { providerId: 'anthropic', type: 'api_key' },
        ])

        // A key set during a refresh waits for it, so the refresh doesn't write over it.
        const changing = yield* Deferred.make<void>()
        const finish = yield* Deferred.make<void>()
        const refresh = yield* Effect.forkScoped(
          Effect.promise(() =>
            store.modify('anthropic', async () => {
              await Effect.runPromise(Deferred.succeed(changing, undefined))
              await Effect.runPromise(Deferred.await(finish))
              return signedIn('refreshed')
            }),
          ),
        )
        yield* Deferred.await(changing)
        const setting = yield* Effect.forkScoped(
          secrets.set(
            anthropic,
            ApiKey.Key({ key: Redacted.make('sk-after') }),
          ),
        )
        yield* Deferred.succeed(finish, undefined)
        yield* Fiber.join(refresh)
        yield* Fiber.join(setting)
        expect(yield* secrets.get(anthropic)).toStrictEqual(
          Held.Key({ key: Redacted.make('sk-after') }),
        )
      }).pipe(Effect.scoped),
  )
})

// The proxy

const caller = (ticket: string): Caller => ({
  run: RunId.make('run-1'),
  ticket: Option.some(TicketId.make(ticket)),
  session: Option.some(SessionId.make(`session-${ticket}`)),
  model: 'claude-sonnet-4-5',
})

interface Asked {
  readonly url: string
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

/** A loopback provider answering every call: what it was asked, as it was asked. */
const provider = Effect.acquireRelease(
  Effect.gen(function* () {
    const asked: Array<Asked> = []
    const server = createServer((request, response) => {
      const chunks: Array<Buffer> = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        asked.push({
          url: request.url ?? '',
          headers: request.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{}')
      })
    })
    const url = yield* Effect.callback<string>(resume => {
      server.listen({ host: '127.0.0.1', port: 0 }, () => {
        const address = server.address()
        const port =
          typeof address === 'object' && address !== null ? address.port : 0
        resume(Effect.succeed(`http://127.0.0.1:${port}`))
      })
    })
    return { url, asked, server }
  }),
  ({ server }) =>
    Effect.sync(() => {
      server.close()
      server.closeAllConnections()
    }),
)

/** The proxy over `secrets`, with Anthropic and OpenAI at `url`, signing in through `providers`. */
const proxyOver = (
  url: string,
  secrets: SecretsShape,
  providers: ReadonlyArray<Provider>,
  routes: ReadonlyArray<ProviderRoute> = [
    {
      provider: 'anthropic',
      upstream: `${url}/anthropic`,
      api: 'anthropic-messages',
      authentication: Authentication.Header({
        header: 'x-api-key',
        credential: anthropic,
      }),
    },
    {
      provider: 'openai',
      upstream: `${url}/openai`,
      api: 'openai-responses',
      authentication: Authentication.Bearer({
        credential: SecretName.make('openai'),
      }),
    },
  ],
) =>
  Effect.gen(function* () {
    const proxy = yield* make({ routes, providers }).pipe(
      Effect.provideService(Secrets, Secrets.of(secrets)),
      Effect.provide(layerOpen),
    )
    const refusals = yield* Queue.unbounded<ProxyEvent>()
    yield* (yield* proxy.events).pipe(
      Stream.filter(ProxyEvent.$is('Refused')),
      Stream.runForEach(event => Queue.offer(refusals, event)),
      Effect.forkScoped,
    )
    return { proxy, refusals }
  })

/** An agent's call, with the placeholder it was given, as Pi's client on a subscription sends it. */
const callAs = (
  agent: {
    readonly providers: ReadonlyArray<{
      readonly provider: string
      readonly baseUrl: string
      readonly apiKey?: string
    }>
    readonly token: Redacted.Redacted<string>
  },
  name: string,
  path: string,
) =>
  Effect.promise(async () => {
    const entry = agent.providers.find(({ provider }) => provider === name)
    const key = entry?.apiKey ?? Redacted.value(agent.token)
    const response = await fetch(`${entry?.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: '{"model":"m"}',
    })
    await response.text()
    return response.status
  })

/** Secrets telling when `count` callers are at a name's lock: they have all seen the token expiring. */
const tellingAt = (secrets: SecretsShape, count: number) =>
  Effect.map(Deferred.make<void>(), arrived => {
    let at = 0
    const telling: SecretsShape = {
      ...secrets,
      modify: (name, change) => {
        at += 1
        if (at === count) Deferred.doneUnsafe(arrived, Effect.void)
        return secrets.modify(name, change)
      },
    }
    return { telling, arrived }
  })

describe('a subscription’s token in the proxy', () => {
  it.live(
    'is refreshed mid-session, two agents sharing the one refresh, and written back',
    () =>
      Effect.gen(function* () {
        const upstream = yield* provider
        const secrets = yield* memorySecrets
        yield* keep(secrets, 'anthropic', signedIn('first'))
        const { telling, arrived } = yield* tellingAt(secrets, 2)
        let refreshes = 0
        const claude = scripted('anthropic', {
          refresh: async credential => {
            refreshes += 1
            // Held until both agents have seen the token expiring and wait on its lock.
            await Effect.runPromise(Deferred.await(arrived))
            expect(credential.refresh).toBe('first-refresh')
            return signedIn('second')
          },
        })
        const { proxy } = yield* proxyOver(upstream.url, telling, [claude])
        const one = yield* proxy.grant(caller('t-1'))
        const other = yield* proxy.grant(caller('t-2'))

        expect(yield* callAs(one, 'anthropic', '/v1/messages')).toBe(200)
        expect(upstream.asked[0]?.headers.authorization).toBe('Bearer first')
        expect(refreshes).toBe(0)

        // Hours on, the token expires with both agents mid-session.
        yield* keep(secrets, 'anthropic', signedIn('first', 0))
        const statuses = yield* Effect.all(
          [
            callAs(one, 'anthropic', '/v1/messages'),
            callAs(other, 'anthropic', '/v1/messages'),
          ],
          { concurrency: 'unbounded' },
        )
        expect(statuses).toStrictEqual([200, 200])

        expect(refreshes).toBe(1)
        expect(
          upstream.asked.slice(1).map(({ headers }) => headers.authorization),
        ).toStrictEqual(['Bearer second', 'Bearer second'])
        expect(yield* accessKept(secrets, anthropic)).toBe('second')
      }).pipe(Effect.scoped),
  )

  it.live(
    'raises the refusal where its refresh fails, past a call that went through, and keeps the sign-in',
    () =>
      Effect.gen(function* () {
        const upstream = yield* provider
        const secrets = yield* memorySecrets
        yield* keep(secrets, 'anthropic', signedIn('first'))
        const claude = scripted('anthropic', {
          refresh: () =>
            Promise.reject(new Error('invalid_grant: body=rotated-secret')),
        })
        const { proxy, refusals } = yield* proxyOver(upstream.url, secrets, [
          claude,
        ])
        const agent = yield* proxy.grant(caller('t-1'))
        expect(yield* callAs(agent, 'anthropic', '/v1/messages')).toBe(200)

        yield* keep(secrets, 'anthropic', signedIn('first', 0))
        expect(yield* callAs(agent, 'anthropic', '/v1/messages')).toBe(401)

        const event = yield* Queue.take(refusals)
        if (!ProxyEvent.$is('Refused')(event)) return expect.fail(event._tag)
        expect(event.provider).toBe('anthropic')
        expect(event.refusal).toStrictEqual(
          Refusal.CredentialRefused({
            reason: 'the OAuth session expired and could not be refreshed',
            account: Option.some(anthropic),
          }),
        )
        expect(JSON.stringify(event)).not.toContain('rotated-secret')
        expect(upstream.asked).toHaveLength(1)
        // Kept for the next try: a refresh that failed may have failed for a moment.
        expect(yield* accessKept(secrets, anthropic)).toBe('first')
      }).pipe(Effect.scoped),
  )

  it.live(
    'is a failed start where its refresh fails before any call went through',
    () =>
      Effect.gen(function* () {
        const upstream = yield* provider
        const secrets = yield* memorySecrets
        yield* keep(secrets, 'anthropic', signedIn('first', 0))
        const claude = scripted('anthropic', {
          refresh: () => Promise.reject(new Error('invalid_grant')),
        })
        const { proxy, refusals } = yield* proxyOver(upstream.url, secrets, [
          claude,
        ])
        const agent = yield* proxy.grant(caller('t-1'))
        expect(yield* callAs(agent, 'anthropic', '/v1/messages')).toBe(401)
        const event = yield* Queue.take(refusals)
        if (!ProxyEvent.$is('Refused')(event)) return expect.fail(event._tag)
        expect(Refusal.$is('StartFailed')(event.refusal)).toBe(true)
      }).pipe(Effect.scoped),
  )

  it.live(
    'goes as a bearer in the placeholder’s place, where the key would go in a header',
    () =>
      Effect.gen(function* () {
        const upstream = yield* provider
        const secrets = yield* memorySecrets
        yield* keep(secrets, 'anthropic', signedIn('claude-token'))
        const { proxy } = yield* proxyOver(upstream.url, secrets, [
          scripted('anthropic', {}),
        ])
        const agent = yield* proxy.grant(caller('t-1'))
        const token = Redacted.value(agent.token)
        const entry = agent.providers.find(
          ({ provider }) => provider === 'anthropic',
        )
        expect(entry?.apiKey).toBe(`sk-ant-oat01-${token}`)
        expect(yield* callAs(agent, 'anthropic', '/v1/messages')).toBe(200)
        const sent = upstream.asked[0]?.headers
        expect(sent?.authorization).toBe('Bearer claude-token')
        expect(sent?.['x-api-key']).toBeUndefined()
        expect(JSON.stringify(sent)).not.toContain(token)
      }).pipe(Effect.scoped),
  )

  it.live('goes to the account’s own base URL where its token names one', () =>
    Effect.gen(function* () {
      const upstream = yield* provider
      const secrets = yield* memorySecrets
      yield* keep(secrets, 'github-copilot', signedIn('copilot'))
      const copilot = scripted('github-copilot', {
        toAuth: credential =>
          Promise.resolve({
            apiKey: credential.access,
            baseUrl: `${upstream.url}/enterprise`,
          }),
      })
      const { proxy } = yield* proxyOver(
        upstream.url,
        secrets,
        [copilot],
        [
          {
            provider: 'github-copilot',
            upstream: `${upstream.url}/individual`,
            api: 'openai-completions',
            authentication: Authentication.Bearer({
              credential: SecretName.make('github-copilot'),
            }),
          },
        ],
      )
      const agent = yield* proxy.grant(caller('t-1'))
      expect(yield* callAs(agent, 'github-copilot', '/chat/completions')).toBe(
        200,
      )
      expect(upstream.asked[0]?.url).toBe('/enterprise/chat/completions')
      expect(upstream.asked[0]?.headers.authorization).toBe('Bearer copilot')
    }).pipe(Effect.scoped),
  )

  it.live('is probed with the subscription’s own request', () =>
    Effect.gen(function* () {
      const upstream = yield* provider
      const secrets = yield* memorySecrets
      yield* keep(secrets, 'anthropic', signedIn('claude-token'))
      yield* keep(secrets, 'openai', signedIn('chatgpt-token'))
      const { proxy } = yield* proxyOver(upstream.url, secrets, [
        scripted('anthropic', {}),
        scripted('openai', {}),
      ])
      const run = RunId.make('run-1')
      for (const [provider, model] of [
        ['anthropic', 'claude-sonnet-4-5'],
        ['openai', 'gpt-5'],
      ] as const) {
        const outcome = yield* proxy.probe({
          provider,
          model: ModelName.make(model),
          run,
        })
        expect(outcome._tag).toBe('Passed')
      }
      const [claude, chatgpt] = upstream.asked
      expect(claude?.headers['anthropic-beta']).toContain('oauth-2025-04-20')
      expect(claude?.headers.authorization).toBe('Bearer claude-token')
      expect(claude?.body).toContain('You are Claude Code')
      expect(chatgpt?.body).not.toContain('max_output_tokens')
      expect(chatgpt?.headers.authorization).toBe('Bearer chatgpt-token')
    }).pipe(Effect.scoped),
  )
})

describe('a probe on GitHub Copilot', () => {
  it.live('carries the headers pi-ai’s catalog has Pi send', () =>
    Effect.gen(function* () {
      const upstream = yield* provider
      const secrets = yield* memorySecrets
      yield* keep(secrets, 'github-copilot', signedIn('copilot'))
      // pi-ai's catalog, with the account's base URL here rather than Copilot's.
      const copilot = subscriptionProviders()
        .filter(({ id }) => id === 'github-copilot')
        .map((real): Provider => ({
          ...real,
          auth: scripted('github-copilot', {
            toAuth: credential =>
              Promise.resolve({
                apiKey: credential.access,
                baseUrl: upstream.url,
              }),
          }).auth,
        }))
      const { proxy } = yield* proxyOver(upstream.url, secrets, copilot, [
        {
          provider: 'github-copilot',
          upstream: upstream.url,
          api: 'openai-completions',
          authentication: Authentication.Bearer({
            credential: SecretName.make('github-copilot'),
          }),
        },
      ])
      const outcome = yield* proxy.probe({
        provider: 'github-copilot',
        model: ModelName.make('no-such-model'),
        run: RunId.make('run-1'),
      })
      expect(outcome._tag).toBe('Passed')
      const sent = upstream.asked[0]?.headers
      expect(sent?.authorization).toBe('Bearer copilot')
      expect(sent?.['editor-version']).toEqual(expect.any(String))
      expect(sent?.['copilot-integration-id']).toEqual(expect.any(String))
      // A model the catalog doesn't have goes by the route's API.
      expect(upstream.asked[0]?.url).toBe('/chat/completions')

      // Each model goes through the API pi-ai's catalog has it on, with no other provider's request.
      const [real] = copilot
      for (const [api, path] of [
        ['anthropic-messages', '/v1/messages'],
        ['openai-responses', '/responses'],
        ['openai-completions', '/chat/completions'],
      ] as const) {
        const model = real?.getModels().find(known => known.api === api)
        if (model === undefined) return expect.fail(`no model on ${api}`)
        upstream.asked.length = 0
        const probed = yield* proxy.probe({
          provider: 'github-copilot',
          model: ModelName.make(model.id),
          run: RunId.make('run-1'),
        })
        expect(probed._tag).toBe('Passed')
        expect(upstream.asked[0]?.url).toBe(path)
        expect(upstream.asked[0]?.body).not.toContain('You are Claude Code')
        expect(upstream.asked[0]?.headers['anthropic-beta']).toBeUndefined()
      }
    }).pipe(Effect.scoped),
  )

  it('reads them from the catalog, whatever the model', () => {
    const subscriptions = makeSubscriptions({
      secrets: Secrets.of({
        store: 'file',
        set: () => Effect.void,
        list: Effect.succeed([]),
        get: name => Effect.fail(new SecretMissing({ name })),
        read: () => Effect.succeedNone,
        modify: () => Effect.succeedNone,
        remove: () => Effect.succeed(false),
      }),
      providers: subscriptionProviders(),
    })
    expect(
      subscriptions.catalogOf('github-copilot', 'no-such-model'),
    ).toMatchObject({
      api: Option.none(),
      headers: { 'editor-version': expect.any(String) },
    })
    expect(
      subscriptions.catalogOf('anthropic', 'claude-sonnet-4-5'),
    ).toStrictEqual({ api: Option.some('anthropic-messages'), headers: {} })
  })
})

describe('an agent’s configuration', () => {
  it.live(
    'takes the placeholder and compat a sign-in needs, and the plain token for a key',
    () =>
      Effect.gen(function* () {
        const upstream = yield* provider
        const secrets = yield* memorySecrets
        yield* keep(secrets, 'openai', signedIn('chatgpt-token'))
        yield* secrets.set(
          anthropic,
          ApiKey.Key({ key: Redacted.make('sk-ant-key') }),
        )
        const { proxy } = yield* proxyOver(upstream.url, secrets, [
          scripted('openai', {}),
        ])
        const agent = yield* proxy.grant(caller('t-1'))
        const token = Redacted.value(agent.token)
        const written: unknown = JSON.parse(
          modelsJson({ providers: agent.providers, token }),
        )
        expect(written).toStrictEqual({
          providers: {
            anthropic: {
              baseUrl: `${proxy.address}/anthropic`,
              apiKey: token,
            },
            openai: {
              baseUrl: `${proxy.address}/openai`,
              apiKey: token,
              compat: chatGptCompat,
            },
          },
        })
      }).pipe(Effect.scoped),
  )

  it('has the placeholder each provider’s subscription asks of Pi', () => {
    expect(subscriptionEntry('anthropic', 'abc')).toStrictEqual({
      apiKey: 'sk-ant-oat01-abc',
    })
    expect(subscriptionEntry('openai', 'abc')).toStrictEqual({
      apiKey: 'abc',
      compat: chatGptCompat,
    })
    expect(subscriptionEntry('github-copilot', 'abc')).toStrictEqual({
      apiKey: 'abc',
    })
    expect(subscriptionEntry('openrouter', 'abc')).toStrictEqual({
      apiKey: 'abc',
    })
  })
})
