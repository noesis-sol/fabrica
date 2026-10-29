import { DateTime, Option, Schema } from 'effect'
import {
  expect as expectScene,
  given,
  scene,
  selector,
  within,
} from 'foldkit/scene'

import { describe, test } from '@effect/vitest'
import {
  EngineId,
  ProjectId,
  RunView,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection } from '../src/app/connection'
import { type Model, initialModel } from '../src/app/model'
import { update } from '../src/app/update'
import { view } from '../src/app/view'

// The stats row's Done today (spec §18.3): the run view's `doneToday`, the project's tickets merged or
// closed with no change since the engine host's midnight whichever run closed them, and not the
// run's own done count.

const project = ProjectId.make('p-1')

/** Thursday 29 October 2026, 12:00 UTC. */
const at = Date.UTC(2026, 9, 29, 12, 0, 0)

/** The day's second run: it has done 3 tickets of the day's 11. */
const secondRunOfTheDay: Model = {
  ...initialModel({ platform: 'darwin', release: '0.0.0' }),
  connection: Connection.Up({
    engine: EngineId.make('e-1'),
    release: '0.1.0',
    protocol: protocolVersion,
  }),
  scope: Option.some(project),
  now: Option.some(DateTime.makeZonedUnsafe(at, { timeZone: 'UTC' })),
  runView: Option.some(
    Schema.decodeUnknownSync(Schema.toCodecJson(RunView))({
      header: {
        run: 'r-2',
        project,
        engine: 'e-1',
        mode: { _tag: 'tickets' },
        state: 'running',
        startedAt: at - 3_600_000,
        offline: false,
        autoAnswer: false,
      },
      totals: {
        live: 0,
        slots: 4,
        counts: {
          in_queue: 0,
          working: 0,
          waiting_to_merge: 0,
          needs_you: 0,
          set_aside: 0,
          carried_over: 0,
          done: 3,
        },
        doneToday: 11,
        tokens: { input: 0, output: 0, cache_write: 0, cache_read: 0 },
        costUsd: null,
      },
      tickets: [],
      workers: [],
      queue: { merging: null, train: null, waiting: [] },
      holds: [],
      banners: [],
      attention: [],
      load: null,
      steps: [],
    }),
  ),
}

const done = selector('[data-stat="done"]')

describe('done today', () => {
  test("draws the day's done tickets, not the run's own", () => {
    scene(
      { update, view },
      given(secondRunOfTheDay),
      expectScene(within(done, selector('[data-value]'))).toHaveText('11'),
      expectScene(done).toContainText('Done today'),
    )
  })
})
