import { Array, DateTime, Option } from 'effect'

import { describe, expect, test } from '@effect/vitest'
import {
  EngineId,
  ProjectId,
  StreamEpoch,
  UsageWindow,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection, localEngineName } from '../src/app/connection'
import type { EngineProject } from '../src/app/engine-project'
import { Message } from '../src/app/message'
import { type Flags, type Model, initialModel } from '../src/app/model'
import { type UsageItem, applyUsage } from '../src/app/streams'
import { update } from '../src/app/update'

// The title bar's usage windows (spec §12.9, §18.3, H90), from `projects.watchUsage`: a snapshot of
// the scoped project's provider account's windows takes the Model's place, each window that moves
// replaces the one of its provider and name, a new one joins at the end, and a sample of another
// project's, or of another engine's, is left out. A scope change clears them.

const flags: Flags = { platform: 'darwin', release: '0.0.0' }
const epoch = StreamEpoch.make('usage-1')

const window = (name: string, utilization: number, provider = 'anthropic') =>
  new UsageWindow({
    provider,
    window: name,
    utilization,
    resetsAt: Option.some(DateTime.makeUnsafe('2026-10-30T18:00:00Z')),
  })

const fiveHour = window('five_hour', 0.41)
const sevenDay = window('seven_day', 0.12)

const snapshot = (
  value: ReadonlyArray<UsageWindow>,
): typeof UsageItem.Type => ({ _tag: 'snapshot', epoch, seq: 0, value })

const patch = (seq: number, value: UsageWindow): typeof UsageItem.Type => ({
  _tag: 'patch',
  seq,
  value,
})

const app: EngineProject = {
  engine: localEngineName,
  project: ProjectId.make('p-app'),
}
const site: EngineProject = {
  engine: localEngineName,
  project: ProjectId.make('p-site'),
}
const appOnBox: EngineProject = { engine: 'build-box', project: app.project }

/** Connected, with `app` scoped. */
const scoped: Model = update(
  {
    ...initialModel(flags),
    connection: Connection.Up({
      engine: EngineId.make('e-local'),
      release: '0.0.0',
      protocol: protocolVersion,
    }),
  },
  Message.SelectedScope({ project: Option.some(app) }),
).model

const received = (
  model: Model,
  project: EngineProject,
  items: Array.NonEmptyReadonlyArray<typeof UsageItem.Type>,
): Model => update(model, Message.ReceivedUsage({ project, items })).model

describe('the usage windows applied', () => {
  test('a snapshot takes their place; a moved window replaces its own, in its place; a new one goes at the end', () => {
    const moved = window('five_hour', 0.5)
    const other = window('five_hour', 0.23, 'openai')
    expect(
      applyUsage(Option.none(), [
        snapshot([fiveHour, sevenDay]),
        patch(1, moved),
        patch(2, other),
      ]),
    ).toEqual(Option.some([moved, sevenDay, other]))
    expect(applyUsage(Option.some([fiveHour]), [snapshot([sevenDay])])).toEqual(
      Option.some([sevenDay]),
    )
  })

  test('a patch before the first snapshot changes nothing', () => {
    expect(applyUsage(Option.none(), [patch(1, fiveHour)])).toEqual(
      Option.none(),
    )
  })
})

describe('the scoped project’s usage windows', () => {
  test('are the Model’s usage, as its stream sends them', () => {
    const first = received(scoped, app, [snapshot([fiveHour, sevenDay])])
    expect(first.usage).toEqual(Option.some([fiveHour, sevenDay]))
    const moved = window('seven_day', 0.2)
    expect(received(first, app, [patch(1, moved)]).usage).toEqual(
      Option.some([fiveHour, moved]),
    )
  })

  test('leave out another project’s, and another engine’s project of the same ID', () => {
    expect(received(scoped, site, [snapshot([fiveHour])]).usage).toEqual(
      Option.none(),
    )
    expect(received(scoped, appOnBox, [snapshot([fiveHour])]).usage).toEqual(
      Option.none(),
    )
  })

  test('are cleared when the scope changes', () => {
    const shown = received(scoped, app, [snapshot([fiveHour])])
    expect(
      update(shown, Message.SelectedScope({ project: Option.some(site) })).model
        .usage,
    ).toEqual(Option.none())
    expect(
      update(shown, Message.SelectedScope({ project: Option.none() })).model
        .usage,
    ).toEqual(Option.none())
  })
})
