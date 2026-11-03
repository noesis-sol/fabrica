import { Effect, Option } from 'effect'
import * as NodePath from 'node:path'

import { describe, expect, it } from '@effect/vitest'

import { LAUNCHER, Updater } from '../src/update'
import {
  PATH,
  fixtureReleases,
  fixtureUpdater,
  makeHome,
  serveReleases,
} from './fixture-releases'

// The one install test whose new launcher runs as the engine runs it, by its own exec, where the others'
// are read through /bin/sh (fixture-releases.ts). On macOS that exec waits on XProtect's queue, however long
// the machine's suites have made it (fixture-launcher.ts): up to 11 s has been measured under load, so this
// test has the time the install itself gives the launcher's --version.
const VERSION_TIME = 60_000

describe('the new launcher an install checks', () => {
  it.live(
    'runs by its own exec, as its first line asks',
    () =>
      Effect.gen(function* () {
        const host = yield* makeHome()
        const root = yield* fixtureReleases([
          {
            version: '0.2.0',
            // Only an exec reads the first line, so only an exec sets its -e: read through /bin/sh, this says nothing.
            launcher:
              "#!/bin/sh -e\ncase $- in *e*) echo 'fabrica v0.2.0' ;; esac\n",
          },
        ])
        const served = yield* serveReleases({ root, latest: '0.2.0' })
        const installed = yield* Effect.gen(function* () {
          const service = yield* Updater
          return yield* service.install({
            current: '0.1.0',
            release: Option.none(),
          })
        }).pipe(
          Effect.provide(
            fixtureUpdater({
              releases: served.url,
              home: host.home,
              path: PATH,
              launcherExec: true,
            }),
          ),
        )
        expect(installed).toStrictEqual({
          version: '0.2.0',
          launcher: NodePath.join(host.places.engines, '0.2.0', LAUNCHER),
        })
      }).pipe(Effect.scoped),
    VERSION_TIME,
  )
})
