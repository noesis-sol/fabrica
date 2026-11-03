import {
  Clock,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
} from 'effect'
import { type IncomingHttpHeaders, createServer } from 'node:http'

import type { OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai'
import { type Provider, createProvider } from '@earendil-works/pi-ai/models'
import { beforeAll, describe, expect, it } from '@effect/vitest'
import { RunId } from '@fabrica/contracts'

import { layer as gitLayer } from '../src/git'
import { ProcessRunner, layer as runnerLayer } from '../src/process'
import {
  Authentication,
  ModelProxy,
  type ProviderRoute,
  layerOpen,
  make,
} from '../src/proxy'
import { StartChecked, runStartChecks } from '../src/run'
import { RunLog, layerRunLog } from '../src/runlog'
import {
  ApiKey,
  type ItemStore,
  Kept,
  SecretName,
  Secrets,
  type SecretsShape,
  makeSecrets,
  oauthStore,
} from '../src/secrets'
import {
  type Project,
  configOf,
  gitConfig,
  liveDeadlines,
  options,
  project,
  runnerConfig,
  setUpRuns,
  settings,
} from './run-harness'

// The start's credentials check on a subscription (spec §13.1, H69): `pi-ai`'s `Models` run for real over
// the engine's secret store, on memory, with a provider whose refresh the test scripts, against a loopback
// provider. A token with under an hour left is refreshed before it is probed, once for its provider; a
// refresh that fails is a start problem, listed with the others; a token a provider only gives for less
// than the hour is as good as it gets. `pi-ai` reads the clock itself, so these run on the live one.

const run = RunId.make('run-1')

beforeAll(setUpRuns)

/** An item store in memory, as a keyring holds them. */
const memoryStore = (): ItemStore => {
  const items = new Map<string, Redacted.Redacted<string>>()
  return {
    kind: 'file',
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

/** A time `after` from now, as a token's expiry. */
const fromNow = (after: Duration.Duration) =>
  Effect.map(Clock.currentTimeMillis, now => now + Duration.toMillis(after))

const signedIn = (access: string, expires: number): OAuthCredential => ({
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

/** The token kept under `provider`, as a sign-in's. */
const accessKept = (secrets: SecretsShape, provider: string) =>
  Effect.promise(() => oauthStore(secrets).read(provider)).pipe(
    Effect.map(credential =>
      credential?.type === 'oauth' ? credential.access : 'not a sign-in',
    ),
  )

/** A provider whose refresh the test gives, and how many times it ran. */
const scripted = (id: string, refresh: OAuthAuth['refresh']) => {
  const refreshes = { count: 0 }
  const provider: Provider = createProvider({
    id,
    auth: {
      oauth: {
        name: id,
        login: () => Promise.reject(new Error('this test signs in to nothing')),
        refresh: (credential, signal) => {
          refreshes.count += 1
          return refresh(credential, signal)
        },
        toAuth: credential => Promise.resolve({ apiKey: credential.access }),
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
  return { provider, refreshes }
}

const noRefresh: OAuthAuth['refresh'] = () =>
  Promise.reject(new Error('this token was not to be refreshed'))

interface Asked {
  readonly url: string
  readonly headers: IncomingHttpHeaders
}

/** A loopback provider answering each call with the status `statusOf` gives its path: what it was asked. */
const upstreamAnswering = (statusOf: (url: string) => number = () => 200) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const asked: Array<Asked> = []
      const server = createServer((request, response) => {
        request.resume()
        request.on('end', () => {
          const url = request.url ?? ''
          asked.push({ url, headers: request.headers })
          response.writeHead(statusOf(url), {
            'content-type': 'application/json',
          })
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
    upstream: `${url}/openai`,
    api: 'openai-responses',
    authentication: Authentication.Bearer({
      credential: SecretName.make('openai'),
    }),
  },
]

/** Real git in a temp folder, and the run's log: what the checks other than the credentials' read. */
const startServices = (fixture: Project) =>
  Layer.mergeAll(
    Layer.provideMerge(
      gitLayer(gitConfig),
      Layer.provideMerge(runnerLayer(runnerConfig()), liveDeadlines),
    ),
    Layer.provide(
      layerRunLog({ root: fixture.checkout, run }),
      DateTime.layerCurrentZoneOffset(0),
    ),
  )

/** The start checks of a project using `models`, through the real proxy over `secrets`. */
const startChecked = (input: {
  readonly url: string
  readonly secrets: SecretsShape
  readonly providers: ReadonlyArray<Provider>
  readonly model: string
  readonly fallbacks?: ReadonlyArray<string>
}) =>
  Effect.gen(function* () {
    const fixture = project({
      ...settings,
      model: input.model,
      model_fallbacks: input.fallbacks ?? [],
    })
    const proxy = yield* make({
      routes: routesAt(input.url),
      providers: input.providers,
    }).pipe(
      Effect.provideService(Secrets, Secrets.of(input.secrets)),
      Effect.provide(layerOpen),
    )
    return yield* Effect.gen(function* () {
      const log = yield* RunLog
      return yield* runStartChecks({
        config: configOf(fixture, options()),
        run,
        log,
      })
    }).pipe(
      Effect.provideService(ModelProxy, proxy),
      Effect.provide(startServices(fixture)),
    )
  })

const problemsOf = (checked: StartChecked): ReadonlyArray<string> =>
  StartChecked.$match(checked, {
    Ready: () => [],
    Problems: ({ problems }) => problems,
  })

const expired = (provider: string) =>
  `${provider}'s credential was refused (the OAuth session expired and could not be refreshed); sign in again or set a new key`

describe('the start’s credentials check', () => {
  it.live(
    'refreshes a token with under an hour left, and probes with the new one',
    () =>
      Effect.gen(function* () {
        const upstream = yield* upstreamAnswering()
        const secrets = yield* memorySecrets
        // Past the five minutes a call refreshes at: only the start's check refreshes it.
        yield* keep(
          secrets,
          'anthropic',
          signedIn('first', yield* fromNow(Duration.minutes(30))),
        )
        const later = yield* fromNow(Duration.hours(8))
        const { provider, refreshes } = scripted('anthropic', () =>
          Promise.resolve(signedIn('renewed', later)),
        )
        const checked = yield* startChecked({
          url: upstream.url,
          secrets,
          providers: [provider],
          model: 'anthropic/claude-test',
        })
        expect(problemsOf(checked)).toStrictEqual([])
        expect(StartChecked.$is('Ready')(checked)).toBe(true)
        expect(refreshes.count).toBe(1)
        expect(
          upstream.asked.map(({ headers }) => headers.authorization),
        ).toEqual(['Bearer renewed'])
        expect(yield* accessKept(secrets, 'anthropic')).toBe('renewed')
      }).pipe(Effect.scoped),
  )

  it.live('leaves a token with over an hour left', () =>
    Effect.gen(function* () {
      const upstream = yield* upstreamAnswering()
      const secrets = yield* memorySecrets
      yield* keep(
        secrets,
        'anthropic',
        signedIn('first', yield* fromNow(Duration.hours(2))),
      )
      const { provider, refreshes } = scripted('anthropic', noRefresh)
      const checked = yield* startChecked({
        url: upstream.url,
        secrets,
        providers: [provider],
        model: 'anthropic/claude-test',
      })
      expect(StartChecked.$is('Ready')(checked)).toBe(true)
      expect(refreshes.count).toBe(0)
      expect(upstream.asked[0]?.headers.authorization).toBe('Bearer first')
    }).pipe(Effect.scoped),
  )

  it.live(
    'takes a refreshed token that lasts under the hour, as GitHub Copilot’s do',
    () =>
      Effect.gen(function* () {
        const upstream = yield* upstreamAnswering()
        const secrets = yield* memorySecrets
        yield* keep(
          secrets,
          'anthropic',
          signedIn('first', yield* fromNow(Duration.minutes(20))),
        )
        const soon = yield* fromNow(Duration.minutes(25))
        const { provider, refreshes } = scripted('anthropic', () =>
          Promise.resolve(signedIn('short-lived', soon)),
        )
        const checked = yield* startChecked({
          url: upstream.url,
          secrets,
          providers: [provider],
          model: 'anthropic/claude-test',
        })
        expect(problemsOf(checked)).toStrictEqual([])
        expect(refreshes.count).toBe(1)
        expect(upstream.asked[0]?.headers.authorization).toBe(
          'Bearer short-lived',
        )
        expect(yield* accessKept(secrets, 'anthropic')).toBe('short-lived')
      }).pipe(Effect.scoped),
  )

  it.live(
    'lists a refresh that fails as a problem, with no call made and the sign-in kept',
    () =>
      Effect.gen(function* () {
        const upstream = yield* upstreamAnswering()
        const secrets = yield* memorySecrets
        yield* keep(
          secrets,
          'anthropic',
          signedIn('first', yield* fromNow(Duration.minutes(30))),
        )
        const { provider } = scripted('anthropic', () =>
          Promise.reject(new Error('invalid_grant: body=rotated-secret')),
        )
        const checked = yield* startChecked({
          url: upstream.url,
          secrets,
          providers: [provider],
          model: 'anthropic/claude-test',
        })
        expect(problemsOf(checked)).toStrictEqual([expired('anthropic')])
        expect(JSON.stringify(checked)).not.toContain('rotated-secret')
        expect(upstream.asked).toHaveLength(0)
        expect(yield* accessKept(secrets, 'anthropic')).toBe('first')
      }).pipe(Effect.scoped),
  )

  it.live('refreshes once for a provider however many of its models', () =>
    Effect.gen(function* () {
      const upstream = yield* upstreamAnswering()
      const secrets = yield* memorySecrets
      yield* keep(
        secrets,
        'anthropic',
        signedIn('first', yield* fromNow(Duration.minutes(30))),
      )
      const soon = yield* fromNow(Duration.minutes(25))
      const { provider, refreshes } = scripted('anthropic', () =>
        Promise.resolve(signedIn('short-lived', soon)),
      )
      const checked = yield* startChecked({
        url: upstream.url,
        secrets,
        providers: [provider],
        model: 'anthropic/claude-test',
        fallbacks: ['anthropic/claude-other'],
      })
      expect(StartChecked.$is('Ready')(checked)).toBe(true)
      expect(refreshes.count).toBe(1)
      expect(upstream.asked).toHaveLength(2)
    }).pipe(Effect.scoped),
  )

  it.live('says a failed refresh once for a provider’s models', () =>
    Effect.gen(function* () {
      const upstream = yield* upstreamAnswering()
      const secrets = yield* memorySecrets
      yield* keep(
        secrets,
        'anthropic',
        signedIn('first', yield* fromNow(Duration.minutes(30))),
      )
      const { provider, refreshes } = scripted('anthropic', () =>
        Promise.reject(new Error('invalid_grant')),
      )
      const checked = yield* startChecked({
        url: upstream.url,
        secrets,
        providers: [provider],
        model: 'anthropic/claude-test',
        fallbacks: ['anthropic/claude-other'],
      })
      expect(problemsOf(checked)).toStrictEqual([expired('anthropic')])
      expect(refreshes.count).toBe(1)
    }).pipe(Effect.scoped),
  )

  it.live(
    'still tries another provider, and lists its problem with the refresh’s',
    () =>
      Effect.gen(function* () {
        const upstream = yield* upstreamAnswering(url =>
          url.startsWith('/openai') ? 401 : 200,
        )
        const secrets = yield* memorySecrets
        yield* keep(
          secrets,
          'anthropic',
          signedIn('first', yield* fromNow(Duration.minutes(30))),
        )
        yield* secrets.set(
          SecretName.make('openai'),
          ApiKey.Key({ key: Redacted.make('sk-openai') }),
          'openai',
        )
        const { provider } = scripted('anthropic', () =>
          Promise.reject(new Error('invalid_grant')),
        )
        const checked = yield* startChecked({
          url: upstream.url,
          secrets,
          providers: [provider],
          model: 'anthropic/claude-test',
          fallbacks: ['openai/gpt-test'],
        })
        expect(problemsOf(checked)).toStrictEqual([
          expired('anthropic'),
          'openai/gpt-test: the credential was refused: the provider refused the credential (HTTP 401)',
        ])
        expect(upstream.asked.map(({ url }) => url)).toEqual([
          '/openai/responses',
        ])
      }).pipe(Effect.scoped),
  )

  it.live('has nothing to refresh on a key, which it only probes', () =>
    Effect.gen(function* () {
      const upstream = yield* upstreamAnswering()
      const secrets = yield* memorySecrets
      yield* secrets.set(
        SecretName.make('anthropic'),
        ApiKey.Key({ key: Redacted.make('sk-ant-key') }),
        'anthropic',
      )
      const { provider, refreshes } = scripted('anthropic', noRefresh)
      const checked = yield* startChecked({
        url: upstream.url,
        secrets,
        providers: [provider],
        model: 'anthropic/claude-test',
      })
      expect(StartChecked.$is('Ready')(checked)).toBe(true)
      expect(refreshes.count).toBe(0)
      expect(upstream.asked[0]?.headers['x-api-key']).toBe('sk-ant-key')
    }).pipe(Effect.scoped),
  )
})
