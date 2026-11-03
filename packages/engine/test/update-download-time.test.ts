import { Deferred, Effect, Fiber, Option } from 'effect'
import { TestClock } from 'effect/testing'

import { describe, expect, it } from '@effect/vitest'

import {
  DOWNLOAD_LIMIT,
  REQUEST_LIMIT,
  UpdateFailure,
  Updater,
  distributionName,
} from '../src/update'
import {
  PATH,
  entries,
  fixtureReleases,
  fixtureUpdater,
  installedBefore,
  makeHome,
  serveReleases,
  target,
} from './fixture-releases'

// The update's downloads are time-limited (spec §9.2), as orchestra's are: checksums.txt and its
// signature have REQUEST_LIMIT each, the archive DOWNLOAD_LIMIT, from the request to the body's end.
// A server that sends half a file and stalls fails the install with DownloadTimedOut once the limit
// passes on the TestClock, rather than holding the update (and its semaphore) for ever.

/** Installs the latest release, 0.2.0, over 0.1.0, from a server stalling on `path`. */
const installStalling = Effect.fn(function* (path: string) {
  const host = yield* makeHome()
  yield* installedBefore(host.places, '0.1.0')
  const root = yield* fixtureReleases([{ version: '0.2.0' }])
  const asked = yield* Deferred.make<void>()
  const served = yield* serveReleases({
    root,
    latest: '0.2.0',
    stalls: [{ path, asked: () => Deferred.doneUnsafe(asked, Effect.void) }],
  })
  const install = yield* Effect.gen(function* () {
    const updater = yield* Updater
    return yield* updater.install({ current: '0.1.0', release: Option.none() })
  }).pipe(
    Effect.provide(
      fixtureUpdater({ releases: served.url, home: host.home, path: PATH }),
    ),
    Effect.forkChild,
  )
  yield* Deferred.await(asked)
  return { ...host, served, install }
})

describe('the update’s download time limits', () => {
  it.effect('gives up a stalled checksums.txt after REQUEST_LIMIT', () =>
    Effect.gen(function* () {
      const { places, served, install } = yield* installStalling(
        '/latest/download/checksums.txt',
      )
      yield* TestClock.adjust(REQUEST_LIMIT)
      const failure = yield* Fiber.join(install).pipe(Effect.flip)
      // The signature, asked for beside it on the same limit, may be on its way still as the clock moves,
      // since a real request doesn't wait on the TestClock, and then its limit runs out first.
      expect(
        ['checksums.txt', 'checksums.txt.sig'].map(name =>
          UpdateFailure.DownloadTimedOut({
            url: `${served.url}/latest/download/${name}`,
            limit: REQUEST_LIMIT,
          }),
        ),
      ).toContainEqual(failure)
      // No archive asked for, and the stage gone.
      expect(
        served.asked.filter(
          path => !path.startsWith('/latest/download/checksums.txt'),
        ),
      ).toStrictEqual([])
      expect(yield* entries(places.engines)).toStrictEqual(['0.1.0'])
    }).pipe(Effect.scoped),
  )

  it.effect('gives up a stalled archive after DOWNLOAD_LIMIT', () =>
    Effect.gen(function* () {
      const archive = `/download/v0.2.0/${distributionName({ version: '0.2.0', target })}.tar.gz`
      const { places, served, install } = yield* installStalling(archive)
      yield* TestClock.adjust(DOWNLOAD_LIMIT)
      const failure = yield* Fiber.join(install).pipe(Effect.flip)
      expect(failure).toStrictEqual(
        UpdateFailure.DownloadTimedOut({
          url: `${served.url}${archive}`,
          limit: DOWNLOAD_LIMIT,
        }),
      )
      expect(yield* entries(places.engines)).toStrictEqual(['0.1.0'])
    }).pipe(Effect.scoped),
  )
})
