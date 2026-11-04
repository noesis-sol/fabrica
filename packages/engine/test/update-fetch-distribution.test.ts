import { Effect, Layer } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from '@effect/vitest'

import { layerClock, layer as runnerLayer } from '../src/process'
import { describeFailure, fetchDistribution } from '../src/update'
import {
  PATH,
  entries,
  fixtureReleases,
  keyPair,
  makeHome,
  releaseKey,
  runnerConfig,
  serveReleases,
  target,
} from './fixture-releases'

// A distribution for another machine's target (spec §12.7): what a macOS engine fetches once for its
// projects' containers. Verified as an update is, its launcher never run, and the engine's own version taken.

describe('fetching a distribution for containers', () => {
  const setup = Effect.gen(function* () {
    const host = yield* makeHome()
    const root = yield* fixtureReleases([
      { version: '0.2.0', launcher: 'not a program this host could run' },
    ])
    const served = yield* serveReleases({ root, latest: '0.2.0' })
    const services = Layer.mergeAll(
      FetchHttpClient.layer,
      Layer.provide(
        runnerLayer(runnerConfig({ path: PATH, home: host.home })),
        layerClock,
      ),
    )
    const fetch = (keys: ReadonlyArray<string>) =>
      fetchDistribution({
        source: { releases: served.url, keys },
        target,
        version: '0.2.0',
        folder: join(host.home, 'distributions'),
      }).pipe(Effect.provide(services))
    return { host, served, fetch }
  })

  it.live('fetches it once, its launcher unrun, nothing else left behind', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { host, served, fetch } = yield* setup
        const place = yield* fetch([releaseKey.publicPem])
        expect(place).toBe(
          join(host.home, 'distributions', `fabrica-0.2.0-${target}`),
        )
        expect(readFileSync(join(place, 'bin/fabrica'), 'utf8')).toBe(
          'not a program this host could run',
        )
        expect(yield* entries(join(host.home, 'distributions'))).toEqual([
          `fabrica-0.2.0-${target}`,
        ])
        const asked = served.asked.length
        expect(yield* fetch([releaseKey.publicPem])).toBe(place)
        expect(served.asked.length).toBe(asked)
      }),
    ),
  )

  it.live('refuses a release its key did not sign, and keeps nothing', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { host, fetch } = yield* setup
        const failure = yield* fetch([keyPair().publicPem]).pipe(Effect.flip)
        expect(describeFailure(failure)).toContain("doesn't verify")
        expect(yield* entries(join(host.home, 'distributions'))).toEqual([])
      }),
    ),
  )

  it.live('says so where the engine holds no release key', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fetch } = yield* setup
        const failure = yield* fetch([]).pipe(Effect.flip)
        expect(failure._tag).toBe('NoReleaseKey')
      }),
    ),
  )
})
