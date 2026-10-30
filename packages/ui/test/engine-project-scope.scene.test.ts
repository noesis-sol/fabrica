import { DateTime, Effect, Option, Stream } from 'effect'
import {
  all,
  click,
  expectAll,
  expect as expectScene,
  given as givenScene,
  scene,
  selector,
} from 'foldkit/scene'
import { given, message, model, story } from 'foldkit/story'

import { describe, expect, test } from '@effect/vitest'
import { EngineAddress } from '@fabrica/client'
import {
  AttentionAnswer,
  AttentionRequest,
  EngineId,
  LocalTime,
  ProjectId,
  ProjectRunState,
  ProjectStatus,
  QuestionAnswer,
  QuestionChoices,
  QuestionOption,
  RunEvent,
  RunId,
  StreamEpoch,
  TicketId,
  attentionKey,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection, localEngineName } from '../src/app/connection'
import type { EngineProject } from '../src/app/engine-project'
import { paletteEntries } from '../src/app/features/palette/palette'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { NotificationTarget } from '../src/app/notify'
import * as RemoteEngines from '../src/app/remote-engines'
import { makeSubscriptions } from '../src/app/subscriptions'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import * as Attention from '../src/console/attention'
import { historyRows } from '../src/console/history'
import { goingRun, projectChip, projectName } from '../src/console/sidebar'

// One repository added on this machine and on a known engine has one project ID on both, its ID being
// a slug of its name (spec §9.1, §18.3): the console names each with its engine. Selecting the known
// engine's row scopes to that engine's project, not this machine's; the palette offers both; each has
// its own chip, run and events; the streams of the scope follow its engine; and a notification's target
// says which engine's project it is.

const project = ProjectId.make('p-fabrica')
const box = 'build-box'
const boxEngine = EngineId.make('e-build-box')
const epoch = StreamEpoch.make('epoch-1')

/** The one project ID, on this machine's engine and on the build-box. */
const here: EngineProject = { engine: localEngineName, project }
const onBox: EngineProject = { engine: box, project }

const hereRun = RunId.make('r-here')
const boxRun = RunId.make('r-box')

const status = (run: RunId, base: string) =>
  new ProjectStatus({
    project,
    name: 'fabrica',
    base,
    setUp: true,
    trusted: false,
    run: ProjectRunState.cases.running.make({ run, overnight: false }),
    ready: 0,
  })

const rowsOf = (engine: EngineId, name: string, row: ProjectStatus) =>
  Message.ReceivedProjects({
    engine,
    name,
    items: [{ _tag: 'snapshot', epoch, seq: 0, value: [row] }],
  })

/** `messages` applied to `from`, as the runtime would. */
const after = (from: Model, ...messages: ReadonlyArray<Message>): Model =>
  messages.reduce((shown, received) => update(shown, received).model, from)

/** Both engines connected. */
const connected: Model = {
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
        engine: boxEngine,
        release: '0.0.0',
        protocol: protocolVersion,
      }),
    },
  ).model,
}

/** Both engines connected, each with its row for the one project ID. */
const bothEngines = after(
  connected,
  rowsOf(EngineId.make('e-local'), localEngineName, status(hereRun, 'main')),
  rowsOf(boxEngine, box, status(boxRun, 'trunk')),
)

const scopedTo = (scope: EngineProject): Model =>
  update(bothEngines, Message.SelectedScope({ project: Option.some(scope) }))
    .model

const rowOn = (engine: string) =>
  selector(`button[data-project="${project}"][data-engine="${engine}"]`)

const subscriptions = makeSubscriptions({
  nextFrame: Effect.void,
  keys: Stream.empty,
  ticks: Stream.empty,
  replacedEnginePorts: Stream.empty,
})

const dispatched = (run: RunId, title: string): RunEvent =>
  RunEvent.cases.dispatch.make({
    time: LocalTime.make('2026-10-30T10:00:00.000+01:00'),
    run,
    ticket: TicketId.make('fa-1'),
    title,
    n: 1,
    queued: 0,
    text: `fa-1 dispatching: ${title}`,
  })

describe('one project ID on two engines', () => {
  test("the build-box's row scopes to its own project: it alone is marked selected", () => {
    scene(
      { update, view },
      givenScene(bothEngines),
      expectAll(all.selector(`button[data-project="${project}"]`)).toHaveCount(
        2,
      ),
      click(rowOn(box)),
      expectScene(rowOn(box)).toHaveAttr('aria-current', 'true'),
      expectScene(rowOn(localEngineName)).not.toHaveAttr('aria-current'),
    )
    story(
      update,
      given(bothEngines),
      message(Message.SelectedScope({ project: Option.some(onBox) })),
      model(shown => {
        expect(shown.scope).toEqual(Option.some(onBox))
      }),
      // This machine's project of the same ID is another scope.
      message(Message.SelectedScope({ project: Option.some(here) })),
      model(shown => {
        expect(shown.scope).toEqual(Option.some(here))
      }),
    )
  })

  test('each has its own chip, name and run going, by its engine', () => {
    const { sidebar } = bothEngines.console
    expect(projectChip(sidebar, here)).toEqual(
      Option.some({ role: 'c1', label: '01' }),
    )
    expect(projectChip(sidebar, onBox)).toEqual(
      Option.some({ role: 'c2', label: '02' }),
    )
    expect(goingRun(sidebar, here)).toEqual(Option.some(hereRun))
    expect(goingRun(sidebar, onBox)).toEqual(Option.some(boxRun))
    expect(projectName(sidebar, onBox)).toEqual(Option.some('fabrica'))
    expect(projectName(sidebar, { engine: 'elsewhere', project })).toEqual(
      Option.none(),
    )
  })

  test('the palette offers both, each scoping to its own engine’s', () => {
    const projects = paletteEntries(bothEngines).filter(
      entry => entry.group === 'project',
    )
    expect(projects.map(entry => [entry.id, entry.title])).toEqual([
      ['project.all', 'All projects'],
      [`project.local/${project}`, 'fabrica · local'],
      [`project.build-box/${project}`, 'fabrica · build-box'],
    ])
    story(
      update,
      given(bothEngines),
      message(Message.RequestedPalette()),
      message(Message.RanPaletteEntry({ id: `project.build-box/${project}` })),
      model(shown => {
        expect(shown.scope).toEqual(Option.some(onBox))
      }),
    )
  })

  test("the scope's streams go to its engine, its run the one its row shows", () => {
    const shown = scopedTo(onBox)
    expect(subscriptions.runView.modelToDependencies(shown)).toEqual({
      project: Option.some(onBox),
      run: Option.some(boxRun),
      watch: 0,
    })
    expect(subscriptions.attention.modelToDependencies(shown)).toEqual({
      engines: [box],
      project: Option.some(project),
    })
    expect(subscriptions.load.modelToDependencies(shown)).toEqual({
      engine: box,
      live: true,
    })
    expect(subscriptions.runTalk.modelToDependencies(shown)).toEqual({
      project: Option.some(onBox),
    })
  })

  test("another engine's run view, attention or backlog for the same ID is left out of the scope", () => {
    const shown = scopedTo(onBox)
    expect(
      update(
        shown,
        Message.EndedRunView({ project: here, reason: 'ProjectNotFound' }),
      ).model,
    ).toBe(shown)
    expect(
      update(
        shown,
        Message.ReceivedAttention({
          engine: localEngineName,
          items: [{ _tag: 'snapshot', epoch, seq: 0, value: [] }],
        }),
      ).model,
    ).toBe(shown)
    expect(
      update(
        shown,
        Message.ReceivedBacklog({
          project: here,
          items: [{ _tag: 'snapshot', epoch, seq: 0, value: [] }],
        }),
      ).model,
    ).toBe(shown)
  })

  test("under All projects, each engine's events are kept apart, each row with its own chip", () => {
    const withEvents = after(
      bothEngines,
      Message.ReceivedEvents({
        project: here,
        items: [
          {
            _tag: 'snapshot',
            epoch,
            seq: 0,
            value: [dispatched(hereRun, 'here')],
          },
        ],
      }),
      Message.ReceivedEvents({
        project: onBox,
        items: [
          {
            _tag: 'snapshot',
            epoch,
            seq: 0,
            value: [dispatched(boxRun, 'on the box')],
          },
        ],
      }),
    )
    expect(withEvents.events.map(entry => entry.project)).toEqual([here, onBox])
    const rows = historyRows(
      withEvents.events.map(entry => ({
        ...entry,
        chip: projectChip(withEvents.console.sidebar, entry.project),
      })),
    )
    expect(rows.map(row => Option.map(row.chip, chip => chip.label))).toEqual([
      Option.some('01'),
      Option.some('02'),
    ])
    expect(new Set(rows.map(row => row.key)).size).toBe(2)
  })

  test("under All projects, a question open on both engines is answered on the card's own engine", () => {
    const question = AttentionRequest.cases.question.make({
      project,
      ticket: TicketId.make('fa-q1'),
      title: 'Which store keeps the sessions?',
      description: Option.none(),
      choices: Option.some(
        new QuestionChoices({
          options: [
            new QuestionOption({ label: 'SQLite', tradeOff: 'One file' }),
            new QuestionOption({ label: 'Memory', tradeOff: 'Lost on exit' }),
          ],
          recommended: 0,
        }),
      ),
      consequential: false,
      maintainerOnly: false,
      blocks: [],
      askedFrom: Option.none(),
      openedAt: DateTime.makeUnsafe(Date.UTC(2026, 9, 30, 8)),
    })
    const both = after(
      bothEngines,
      ...[localEngineName, box].map(engine =>
        Message.ReceivedAttention({
          engine,
          items: [{ _tag: 'snapshot', epoch, seq: 0, value: [question] }],
        }),
      ),
    )
    expect(Option.map(both.attention, requests => requests.length)).toEqual(
      Option.some(2),
    )
    const key = attentionKey(question)
    const opened = Attention.update(
      both.console.attention,
      Attention.Message.ClickedAnswer({ engine: box, request: question }),
    ).model
    const submitted = Attention.update(
      opened,
      Attention.Message.SubmittedAnswer({ key }),
    )
    expect(
      submitted.commands?.map(command => [command.name, command.args]),
    ).toEqual([
      [
        'Answer',
        {
          key,
          engine: box,
          answer: AttentionAnswer.cases.question.make({
            project,
            ticket: question.ticket,
            answer: QuestionAnswer.cases.option.make({ index: 0 }),
          }),
        },
      ],
    ])
  })

  test("a notification's click scopes to its engine's project", () => {
    story(
      update,
      given(scopedTo(here)),
      message(
        Message.ClickedNotification({
          target: NotificationTarget.cases.Project.make(onBox),
        }),
      ),
      model(shown => {
        expect(shown.scope).toEqual(Option.some(onBox))
      }),
    )
  })
})
