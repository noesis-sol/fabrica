import { DateTime, Option } from 'effect'
import {
  all,
  expectAll,
  expect as expectScene,
  given,
  scene,
  selector,
  within,
} from 'foldkit/scene'

import { describe, expect, test } from '@effect/vitest'
import { EngineAddress } from '@fabrica/client'
import {
  AttentionRef,
  AttentionRequest,
  EngineId,
  ProjectId,
  ProjectRunState,
  ProjectStatus,
  StreamEpoch,
  TicketId,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection, localEngineName } from '../src/app/connection'
import type { EngineProject } from '../src/app/engine-project'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { NotificationTarget } from '../src/app/notify'
import * as RemoteEngines from '../src/app/remote-engines'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import { projectChip } from '../src/console/sidebar'

// A clicked notification's request, focused in the attention column (spec §18.5): the focus names the
// request with its engine, so under All projects, where one project ID and ticket are open on two
// engines, the column draws focused the card on the notification's engine alone.

const box = 'build-box'
const project = ProjectId.make('p-fabrica')
const epoch = StreamEpoch.make('epoch-1')

/** The one project ID, on this machine's engine and on the build-box. */
const here: EngineProject = { engine: localEngineName, project }
const onBox: EngineProject = { engine: box, project }

const status = new ProjectStatus({
  project,
  name: 'fabrica',
  base: 'main',
  setUp: true,
  trusted: false,
  run: ProjectRunState.cases.idle.make({}),
  ready: 0,
})

/** The same task, open on both engines. */
const task = AttentionRequest.cases.task.make({
  project,
  ticket: TicketId.make('fa-1'),
  title: 'Make an API key for the staging bucket',
  openedAt: DateTime.makeUnsafe(Date.UTC(2026, 9, 30, 9)),
})
const ref = AttentionRef.cases.task.make({
  project,
  ticket: TicketId.make('fa-1'),
})

const received = (model: Model, ...messages: ReadonlyArray<Message>): Model =>
  messages.reduce((shown, next) => update(shown, next).model, model)

/** Both engines connected, each with its row for the project and its task open, under All projects. */
const bothOpen = received(
  {
    ...initialModel({ platform: 'darwin', release: '0.0.0' }),
    connection: Connection.Up({
      engine: EngineId.make('e-local'),
      release: '0.0.0',
      protocol: protocolVersion,
    }),
    remotes: RemoteEngines.connected(
      RemoteEngines.added(RemoteEngines.init(), {
        name: box,
        address: EngineAddress.cases.Ssh.make({ destination: 'me@build-box' }),
      }),
      {
        name: box,
        hello: Connection.Up({
          engine: EngineId.make('e-build-box'),
          release: '0.0.0',
          protocol: protocolVersion,
        }),
      },
    ).model,
  },
  Message.ReceivedProjects({
    engine: EngineId.make('e-local'),
    name: localEngineName,
    items: [{ _tag: 'snapshot', epoch, seq: 0, value: [status] }],
  }),
  Message.ReceivedProjects({
    engine: EngineId.make('e-build-box'),
    name: box,
    items: [{ _tag: 'snapshot', epoch, seq: 0, value: [status] }],
  }),
  ...[localEngineName, box].map(engine =>
    Message.ReceivedAttention({
      engine,
      items: [{ _tag: 'snapshot', epoch, seq: 0, value: [task] }],
    }),
  ),
)

const clicked = (engine: string): Model =>
  received(
    bothOpen,
    Message.ClickedNotification({
      target: NotificationTarget.cases.Request.make({ engine, ref }),
    }),
  )

/** The chip of `of`'s row, as its card carries it under All projects. */
const chipOf = (model: Model, of: EngineProject): string =>
  Option.match(projectChip(model.console.sidebar, of), {
    onNone: () => '',
    onSome: chip => chip.label,
  })

describe('the request a notification focused', () => {
  test('is named with the engine the notification came from', () => {
    const focused = clicked(box)
    expect(focused.scope).toEqual(Option.none())
    expect(focused.focusedRequest).toEqual(Option.some({ engine: box, ref }))
  })

  test("under All projects, the card on the notification's engine alone is drawn focused", () => {
    for (const [engine, shown] of [
      [box, onBox],
      [localEngineName, here],
    ] as const) {
      const focused = clicked(engine)
      expect(chipOf(focused, shown)).not.toEqual('')
      scene(
        { update, view },
        given(focused),
        expectAll(all.selector('li[data-card]')).toHaveCount(2),
        expectAll(all.selector('li[data-focused]')).toHaveCount(1),
        expectScene(
          within(selector('li[data-focused]'), selector('[data-chip]')),
        ).toHaveText(chipOf(focused, shown)),
        expectScene(selector('li[data-focused]')).toHaveClass('outline-c1'),
      )
    }
  })

  test('another engine’s request of the same ref is not focused', () => {
    scene(
      { update, view },
      given({
        ...bothOpen,
        engineAttention: [{ engine: localEngineName, requests: [task] }],
        focusedRequest: Option.some({ engine: box, ref }),
      }),
      expectAll(all.selector('li[data-card]')).toHaveCount(1),
      expectAll(all.selector('li[data-focused]')).toHaveCount(0),
    )
  })
})
