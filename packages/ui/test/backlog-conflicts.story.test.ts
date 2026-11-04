import { Option, Schema } from 'effect'
import {
  Command as SceneCommand,
  click,
  expect as expectScene,
  given as givenScene,
  role,
  scene,
  selector,
  within,
} from 'foldkit/scene'
import { Command, given, message, model, story } from 'foldkit/story'

import { describe, expect, test } from '@effect/vitest'
import {
  EngineId,
  ProjectId,
  StreamEpoch,
  Ticket,
  TicketConflict,
  TicketId,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection, localEngineName } from '../src/app/connection'
import type { EngineProject } from '../src/app/engine-project'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { Screen } from '../src/app/screen'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import * as Backlog from '../src/screens/backlog'

// The Backlog screen's merge conflicts (spec §18.4, §11.7), from fixture facts: each conflict's ticket,
// field and both values, "use the other value" setting the field through `tickets.update` one conflict
// at a time, what it says when the engine refuses, and a conflict the engine can't set.

const scoped: EngineProject = {
  engine: localEngineName,
  project: ProjectId.make('p-1'),
}
const other: EngineProject = {
  engine: localEngineName,
  project: ProjectId.make('p-2'),
}

const decodeConflict = Schema.decodeUnknownSync(
  Schema.toCodecJson(TicketConflict),
)
const decodeTicket = Schema.decodeUnknownSync(Schema.toCodecJson(Ticket))
const at = 1_793_268_900_000

// Closed, so no graph is drawn beside the section.
const login = decodeTicket({
  id: 'fa-2',
  type: 'task',
  title: 'Login form',
  description: null,
  design: null,
  acceptance: null,
  status: 'closed',
  resolution: 'done',
  priority: 2,
  deferUntil: null,
  assignee: null,
  model: null,
  metadata: {},
  result: null,
  question: null,
  mergedCommit: null,
  closeReason: null,
  createdAt: at,
  updatedAt: at,
})

const onTitle = decodeConflict({
  seq: 7,
  ticket: 'fa-2',
  field: 'title',
  kept: 'Login form',
  other: 'Sign-in form',
  useOther: { title: 'Sign-in form' },
})
const onPriority = decodeConflict({
  seq: 8,
  ticket: 'fa-2',
  field: 'priority',
  kept: 2,
  other: 1,
  useOther: { priority: 1 },
})
const onAssignee = decodeConflict({
  seq: 9,
  ticket: 'fa-2',
  field: 'assignee',
  kept: null,
  other: { engine: 'e-1', session: 's-1' },
  useOther: null,
})

const facts = (
  conflicts: ReadonlyArray<TicketConflict>,
  project: EngineProject = scoped,
): Backlog.Facts => ({ project, ready: [], waiting: [], edges: [], conflicts })

const ticket = TicketId.make('fa-2')
const clickTitle = Backlog.Message.ClickedUseOtherValue({
  project: scoped,
  seq: 7,
  ticket,
  changes: { title: 'Sign-in form' },
})
const useTitle = Backlog.UseOtherValue({
  project: scoped,
  seq: 7,
  ticket,
  changes: { title: 'Sign-in form' },
})

describe('use the other value', () => {
  test('sets the field through the engine', () => {
    story(
      Backlog.update,
      given(Backlog.init()),
      message(clickTitle),
      Command.expectExact(useTitle),
      model(shown => {
        expect(shown.using).toEqual(Option.some(7))
      }),
      Command.resolve(
        Backlog.UseOtherValue,
        Backlog.Message.SucceededUseOtherValue({ seq: 7 }),
      ),
      model(shown => {
        expect(shown.using).toEqual(Option.none())
        expect(shown.useFailed).toEqual(Option.none())
      }),
    )
  })

  test('one conflict at a time: another chosen meanwhile asks nothing', () => {
    const using = Backlog.update(Backlog.init(), clickTitle).model
    const again = Backlog.update(
      using,
      Backlog.Message.ClickedUseOtherValue({
        project: scoped,
        seq: 8,
        ticket,
        changes: { priority: 1 },
      }),
    )
    expect(again.commands).toBeUndefined()
    expect(again.model.using).toEqual(Option.some(7))
  })

  test('keeps why the engine refused, until the next try', () => {
    story(
      Backlog.update,
      given(Backlog.init()),
      message(clickTitle),
      Command.resolve(
        Backlog.UseOtherValue,
        Backlog.Message.FailedUseOtherValue({
          seq: 7,
          reason: "can't reopen fa-2: it is in progress",
        }),
      ),
      model(shown => {
        expect(shown.using).toEqual(Option.none())
        expect(shown.useFailed).toEqual(
          Option.some({
            seq: 7,
            reason: "can't reopen fa-2: it is in progress",
          }),
        )
      }),
      message(clickTitle),
      Command.expectExact(useTitle),
      model(shown => {
        expect(shown.useFailed).toEqual(Option.none())
      }),
      Command.resolve(
        Backlog.UseOtherValue,
        Backlog.Message.SucceededUseOtherValue({ seq: 7 }),
      ),
    )
  })

  test('an answer after the project changed is dropped', () => {
    const asked = Backlog.update(Backlog.init(), clickTitle)
    const reopened = Backlog.opened(asked.model)
    const answered = Backlog.update(
      reopened,
      Backlog.Message.FailedUseOtherValue({ seq: 7, reason: 'gone' }),
    )
    expect(answered.model.useFailed).toEqual(Option.none())
    expect(reopened.using).toEqual(Option.none())
  })
})

describe('what a conflict’s value says', () => {
  test('text as it is, nothing as such, anything else as JSON', () => {
    expect(Backlog.sayConflictValue('Login form')).toBe('Login form')
    expect(Backlog.sayConflictValue(null)).toBe('(nothing)')
    expect(Backlog.sayConflictValue('')).toBe('(nothing)')
    expect(Backlog.sayConflictValue(2)).toBe('2')
    expect(Backlog.sayConflictValue({ team: 'a' })).toBe('{\n  "team": "a"\n}')
  })
})

const connected: Model = {
  ...initialModel({ platform: 'darwin', release: '0.0.0' }),
  connection: Connection.Up({
    engine: EngineId.make('e-1'),
    release: '0.1.0',
    protocol: protocolVersion,
  }),
  scope: Option.some(scoped),
}

const backlogMessage = (message: Backlog.Message) =>
  Message.GotBacklogMessage({ message })

/** The screen in the app, its project's ticket received, on its Merge conflicts section; the engine yet to answer. */
const asked: Model = [
  Message.RequestedScreen({ screen: Screen.Backlog() }),
  Message.ReceivedBacklog({
    project: scoped,
    items: [
      {
        _tag: 'snapshot',
        epoch: StreamEpoch.make('epoch-1'),
        seq: 0,
        value: [login],
      },
    ],
  }),
  backlogMessage(Backlog.Message.ChoseSection({ section: 'conflicts' })),
].reduce((shown, each) => update(shown, each).model, connected)

/** The same, the engine having said `conflicts` of `project`. */
const onConflicts = (
  conflicts: ReadonlyArray<TicketConflict>,
  project: EngineProject = scoped,
): Model =>
  update(
    asked,
    backlogMessage(
      Backlog.Message.SucceededLoadFacts({ facts: facts(conflicts, project) }),
    ),
  ).model

const app = { update, view }

const conflictOf = (name: string) => role('listitem', { name })

describe('the section', () => {
  test('counts the conflicts on its tab, and lists each one’s ticket, field and both values', () => {
    scene(
      app,
      givenScene(onConflicts([onTitle, onPriority])),
      expectScene(role('button', { name: 'Merge conflicts 2' })).toHaveAttr(
        'aria-pressed',
        'true',
      ),
      expectScene(conflictOf('fa-2 title')).toContainText('Login form'),
      expectScene(conflictOf('fa-2 title')).toContainText('Sign-in form'),
      expectScene(
        within(
          conflictOf('fa-2 title'),
          selector('[data-conflict-value="Kept"]'),
        ),
      ).toContainText('Login form'),
      expectScene(
        within(
          conflictOf('fa-2 title'),
          selector('[data-conflict-value="Other"]'),
        ),
      ).toContainText('Sign-in form'),
      expectScene(conflictOf('fa-2 priority')).toContainText('priority'),
    )
  })

  test('says so with none, and while the engine hasn’t answered', () => {
    scene(
      app,
      givenScene(onConflicts([])),
      expectScene(role('region', { name: 'Merge conflicts' })).toContainText(
        'No merge conflicts',
      ),
    )
    scene(
      app,
      givenScene(asked),
      expectScene(role('region', { name: 'Merge conflicts' })).toContainText(
        'Asking the engine…',
      ),
      expectScene(role('button', { name: 'Merge conflicts 0' })).toExist(),
    )
  })

  test('another project’s conflicts aren’t shown', () => {
    scene(
      app,
      givenScene(onConflicts([onTitle], other)),
      expectScene(role('button', { name: 'Merge conflicts 0' })).toExist(),
      expectScene(role('region', { name: 'Merge conflicts' })).toContainText(
        'Asking the engine…',
      ),
    )
  })

  test('its button sets the other value, shown as under way, every button waiting on it', () => {
    scene(
      app,
      givenScene(onConflicts([onTitle, onPriority])),
      click(
        within(
          conflictOf('fa-2 title'),
          role('button', { name: 'Use the other value' }),
        ),
      ),
      expectScene(
        within(
          conflictOf('fa-2 title'),
          role('button', { name: 'Using the other value…' }),
        ),
      ).toBeDisabled(),
      expectScene(
        within(
          conflictOf('fa-2 priority'),
          role('button', { name: 'Use the other value' }),
        ),
      ).toBeDisabled(),
      SceneCommand.expectExact(useTitle),
      SceneCommand.resolve(
        Backlog.UseOtherValue,
        Backlog.Message.SucceededUseOtherValue({ seq: 7 }),
      ),
      expectScene(
        within(
          conflictOf('fa-2 priority'),
          role('button', { name: 'Use the other value' }),
        ),
      ).toBeEnabled(),
    )
  })

  test('the engine’s refusal is said on its conflict', () => {
    scene(
      app,
      givenScene(onConflicts([onTitle, onPriority])),
      click(
        within(
          conflictOf('fa-2 title'),
          role('button', { name: 'Use the other value' }),
        ),
      ),
      SceneCommand.resolve(
        Backlog.UseOtherValue,
        Backlog.Message.FailedUseOtherValue({
          seq: 7,
          reason: 'a title has one line',
        }),
      ),
      expectScene(
        within(conflictOf('fa-2 title'), role('alert')),
      ).toContainText('a title has one line'),
      expectScene(
        within(conflictOf('fa-2 priority'), role('alert')),
      ).not.toExist(),
    )
  })

  test('a value the engine can’t set has no button, and says so', () => {
    scene(
      app,
      givenScene(onConflicts([onAssignee])),
      expectScene(conflictOf('fa-2 assignee')).toContainText(
        'The app can’t set this value',
      ),
      expectScene(
        within(
          conflictOf('fa-2 assignee'),
          role('button', { name: 'Use the other value' }),
        ),
      ).not.toExist(),
    )
  })

  test('its ticket’s ID chooses the ticket', () => {
    scene(
      app,
      givenScene(onConflicts([onTitle])),
      click(role('button', { name: 'fa-2' })),
      SceneCommand.resolve(
        Backlog.FocusGraph,
        Backlog.Message.CompletedFocusGraph(),
      ),
      expectScene(role('region', { name: 'Ticket' })).toContainText(
        'Login form',
      ),
    )
  })
})
