import { DateTime, Option } from 'effect'
import { Command, given, message, model, story } from 'foldkit/story'

import { describe, expect, test } from '@effect/vitest'
import {
  AttentionClosed,
  AttentionRef,
  AttentionRequest,
  CommitHash,
  EngineId,
  LocalTime,
  PermissionId,
  ProjectId,
  ProjectRunState,
  ProjectStatus,
  type ProjectStatusItem,
  QuestionChoices,
  QuestionOption,
  RunEvent,
  RunId,
  SessionId,
  StreamEpoch,
  TicketId,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection, localEngineName } from '../src/app/connection'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { ShowNotification } from '../src/app/notifier'
import {
  type DesktopNotification,
  NotificationTarget,
  receivedRuns,
  titleMaxLength,
  watchedRuns,
} from '../src/app/notify'
import { Screen } from '../src/app/screen'
import type { AttentionItem, EventsItem } from '../src/app/streams'

type AttentionItemValue = typeof AttentionItem.Type
type RunEventsItemValue = typeof EventsItem.Type
import { update } from '../src/app/update'

// The app's notifications (spec §18.5, §7.7, §15.2): which requests and run events are told, once and
// only as they arrive, and a click on one focusing its target in the console.

const engine = EngineId.make('e-1')
const project = ProjectId.make('p-fabrica')
const other = ProjectId.make('p-tutti')
const run = RunId.make('2026-10-29T10:14:58.120+02:00')
const time = LocalTime.make('2026-10-29T10:15:00.000+02:00')
const epoch = StreamEpoch.make('epoch-1')
const openedAt = DateTime.makeUnsafe(Date.UTC(2026, 9, 29, 8, 15))

const status = (id: ProjectId, name: string, state: ProjectRunState) =>
  new ProjectStatus({
    project: id,
    name,
    base: 'main',
    setUp: true,
    trusted: false,
    run: state,
    ready: 0,
  })

const running = ProjectRunState.cases.running.make({ run, overnight: false })
const idle = ProjectRunState.cases.idle.make({})

const projects = (
  fabricaRun: ProjectRunState,
): readonly [ProjectStatusItem] => [
  {
    _tag: 'snapshot',
    epoch,
    seq: 0,
    value: [
      status(project, 'fabrica', fabricaRun),
      status(other, 'tutti', idle),
    ],
  },
]

const connected: Model = {
  ...initialModel({ platform: 'darwin', release: '0.0.0' }),
  connection: Connection.Up({
    engine,
    release: '0.1.0',
    protocol: protocolVersion,
  }),
}

const receivedProjects = (fabricaRun: ProjectRunState) =>
  Message.ReceivedProjects({
    engine,
    name: 'local',
    items: projects(fabricaRun),
  })

/** Connected, the fabrica project running `run`, its first events and the first attention read. */
const watching = (startEvent: RunEvent): Model => {
  const steps = [
    receivedProjects(running),
    Message.ReceivedRunEvents({
      engine: localEngineName,
      project,
      run,
      items: [{ _tag: 'snapshot', epoch, seq: 0, value: [startEvent] }],
    }),
    Message.ReceivedAttentionToNotify({
      engine: localEngineName,
      items: [{ _tag: 'snapshot', epoch, seq: 0, value: [] }],
    }),
  ]
  return steps.reduce((current, step) => update(current, step).model, connected)
}

const start = (autoAnswer: number | undefined) =>
  RunEvent.cases.start.make({
    time,
    run,
    version: '0.1.0',
    engine,
    repo: '/Users/me/fabrica',
    branch: 'main',
    commit: CommitHash.make('eda8c7a0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6'),
    concurrency: 4,
    ...(autoAnswer === undefined ? {} : { auto_answer: autoAnswer }),
  })

const plainRun = watching(start(undefined))

const choices = new QuestionChoices({
  options: [
    new QuestionOption({ label: 'Postgres', tradeOff: 'one more service' }),
    new QuestionOption({ label: 'SQLite', tradeOff: 'one writer' }),
  ],
  recommended: 1,
})

const question = (
  fields: Partial<{
    readonly ticket: TicketId
    readonly consequential: boolean
    readonly maintainerOnly: boolean
    readonly choices: Option.Option<QuestionChoices>
  }> = {},
) =>
  AttentionRequest.cases.question.make({
    project,
    ticket: TicketId.make('fa-q1'),
    title: 'Which store keeps the sessions?',
    description: Option.none(),
    choices: Option.some(choices),
    consequential: false,
    maintainerOnly: false,
    blocks: [TicketId.make('fa-7')],
    askedFrom: Option.some(TicketId.make('fa-7')),
    openedAt,
    ...fields,
  })

const permission = AttentionRequest.cases.permission.make({
  project,
  id: PermissionId.make('perm-1'),
  ticket: TicketId.make('fa-7'),
  session: SessionId.make('s-1'),
  tool: 'bash',
  input: { command: 'rm -rf build' },
  shown: { _tag: 'command', lines: ['rm -rf build'] },
  why: 'not on the allow list',
  openedAt,
})

const task = AttentionRequest.cases.task.make({
  project,
  ticket: TicketId.make('fa-t1'),
  title: 'Make a signing key',
  openedAt,
})

const review = AttentionRequest.cases.review.make({
  project,
  ticket: TicketId.make('fa-9'),
  title: 'Refresh tokens',
  reason: 'CHECKS_FAILED',
  openedAt,
})

const arrived = (
  ...requests: ReadonlyArray<AttentionRequest>
): readonly [AttentionItemValue] => [
  { _tag: 'patch', seq: 1, value: { upsert: requests, remove: [] } },
]

const questionRef = AttentionRef.cases.question.make({
  project,
  ticket: TicketId.make('fa-q1'),
})

const questionTold: DesktopNotification = {
  title: 'Question · fabrica',
  body: 'Which store keeps the sessions?',
  target: NotificationTarget.cases.Request.make({ ref: questionRef }),
}

const permissionRef = AttentionRef.cases.permission.make({
  project,
  id: PermissionId.make('perm-1'),
})

const toProject = NotificationTarget.cases.Project.make({ project })

const events = (
  ...value: ReadonlyArray<RunEvent>
): readonly [RunEventsItemValue] => [{ _tag: 'patch', seq: 1, value }]

const hold = (
  kind: 'ENVIRONMENT' | 'USAGE_LIMIT' | 'CREDENTIALS' | 'MACHINE' | 'BUDGET',
  lifted = false,
) =>
  RunEvent.cases.hold.make({
    time,
    run,
    hold: kind,
    text: `HOLD: ${kind}`,
    ...(lifted ? { lifted: true } : {}),
  })

const battery = (level: number, threshold: 20 | 10) =>
  RunEvent.cases.battery.make({
    time,
    run,
    level,
    threshold,
    text: `the battery is at ${level}%, discharging`,
  })

describe('requests that notify', () => {
  test('what is open when the app starts listening tells nothing', () => {
    story(
      update,
      given(update(connected, receivedProjects(running)).model),
      message(
        Message.ReceivedAttentionToNotify({
          engine: localEngineName,
          items: [
            {
              _tag: 'snapshot',
              epoch,
              seq: 5,
              value: [question(), permission],
            },
          ],
        }),
      ),
      Command.expectNone(),
    )
  })

  test('a question that arrives tells its title, in its project’s name', () => {
    story(
      update,
      given(plainRun),
      message(
        Message.ReceivedAttentionToNotify({
          engine: localEngineName,
          items: arrived(question()),
        }),
      ),
      Command.expectExact(ShowNotification({ notification: questionTold })),
      Command.resolve(ShowNotification, Message.CompletedShowNotification()),
    )
  })

  test('a permission request that arrives tells its ticket, tool and why', () => {
    story(
      update,
      given(plainRun),
      message(
        Message.ReceivedAttentionToNotify({
          engine: localEngineName,
          items: arrived(permission),
        }),
      ),
      Command.expectExact(
        ShowNotification({
          notification: {
            title: 'Permission request · fabrica',
            body: 'fa-7 asks to use bash: not on the allow list',
            target: NotificationTarget.cases.Request.make({
              ref: permissionRef,
            }),
          },
        }),
      ),
      Command.resolve(ShowNotification, Message.CompletedShowNotification()),
    )
  })

  test('a maintainer task or a ticket set aside tells nothing', () => {
    story(
      update,
      given(plainRun),
      message(
        Message.ReceivedAttentionToNotify({
          engine: localEngineName,
          items: arrived(task, review),
        }),
      ),
      Command.expectNone(),
    )
  })

  test('a request is told once: changed, or still open in a later snapshot, it tells nothing again', () => {
    const toldOnce = update(
      plainRun,
      Message.ReceivedAttentionToNotify({
        engine: localEngineName,
        items: arrived(question()),
      }),
    ).model
    story(
      update,
      given(toldOnce),
      message(
        Message.ReceivedAttentionToNotify({
          engine: localEngineName,
          items: arrived(question()),
        }),
      ),
      Command.expectNone(),
      message(
        Message.ReceivedAttentionToNotify({
          engine: localEngineName,
          items: [
            {
              _tag: 'snapshot',
              epoch,
              seq: 9,
              value: [question(), permission],
            },
          ],
        }),
      ),
      Command.expectExact(
        ShowNotification({
          notification: {
            title: 'Permission request · fabrica',
            body: 'fa-7 asks to use bash: not on the allow list',
            target: NotificationTarget.cases.Request.make({
              ref: permissionRef,
            }),
          },
        }),
      ),
      Command.resolve(ShowNotification, Message.CompletedShowNotification()),
    )
  })

  test('a request answered and asked again tells again', () => {
    const toldOnce = update(
      plainRun,
      Message.ReceivedAttentionToNotify({
        engine: localEngineName,
        items: arrived(question()),
      }),
    ).model
    story(
      update,
      given(toldOnce),
      message(
        Message.ReceivedAttentionToNotify({
          engine: localEngineName,
          items: [
            {
              _tag: 'patch',
              seq: 2,
              value: {
                upsert: [],
                remove: [
                  new AttentionClosed({
                    ref: questionRef,
                    by: Option.none(),
                    at: openedAt,
                  }),
                ],
              },
            },
          ],
        }),
      ),
      Command.expectNone(),
      message(
        Message.ReceivedAttentionToNotify({
          engine: localEngineName,
          items: arrived(question()),
        }),
      ),
      Command.expectExact(ShowNotification({ notification: questionTold })),
      Command.resolve(ShowNotification, Message.CompletedShowNotification()),
    )
  })
})

describe('questions --auto-answer answers at once', () => {
  const atOnce = watching(start(0))

  test('one it will answer at once tells nothing', () => {
    story(
      update,
      given(atOnce),
      message(
        Message.ReceivedAttentionToNotify({
          engine: localEngineName,
          items: arrived(question()),
        }),
      ),
      Command.expectNone(),
    )
  })

  test('one it leaves to the maintainer tells: consequential, maintainer-only, or without options', () => {
    for (const left of [
      question({ consequential: true }),
      question({ maintainerOnly: true }),
      question({ choices: Option.none() }),
    ]) {
      story(
        update,
        given(atOnce),
        message(
          Message.ReceivedAttentionToNotify({
            engine: localEngineName,
            items: arrived(left),
          }),
        ),
        Command.expectExact(ShowNotification({ notification: questionTold })),
        Command.resolve(ShowNotification, Message.CompletedShowNotification()),
      )
    }
  })

  test('with a wait, the maintainer may answer first, so it tells', () => {
    story(
      update,
      given(watching(start(600_000))),
      message(
        Message.ReceivedAttentionToNotify({
          engine: localEngineName,
          items: arrived(question()),
        }),
      ),
      Command.expectExact(ShowNotification({ notification: questionTold })),
      Command.resolve(ShowNotification, Message.CompletedShowNotification()),
    )
  })

  test('another project’s run answering at once doesn’t silence this one’s question', () => {
    story(
      update,
      given(atOnce),
      message(
        Message.ReceivedAttentionToNotify({
          engine: localEngineName,
          items: arrived({ ...question(), project: other }),
        }),
      ),
      Command.expectExact(
        ShowNotification({
          notification: {
            ...questionTold,
            title: 'Question · tutti',
            target: NotificationTarget.cases.Request.make({
              ref: AttentionRef.cases.question.make({
                project: other,
                ticket: TicketId.make('fa-q1'),
              }),
            }),
          },
        }),
      ),
      Command.resolve(ShowNotification, Message.CompletedShowNotification()),
    )
  })
})

describe('run events that notify', () => {
  const told = (...value: ReadonlyArray<RunEvent>) =>
    update(
      plainRun,
      Message.ReceivedRunEvents({
        engine: localEngineName,
        project,
        run,
        items: events(...value),
      }),
    )

  test('the run’s end tells how it ended', () => {
    story(
      update,
      given(plainRun),
      message(
        Message.ReceivedRunEvents({
          engine: localEngineName,
          project,
          run,
          items: events(
            RunEvent.cases.done.make({
              time,
              run,
              detail: 'READY_EMPTY',
              text: 'READY_EMPTY after 12 tickets',
            }),
            RunEvent.cases.end.make({ time, run, code: 0 }),
          ),
        }),
      ),
      Command.expectExact(
        ShowNotification({
          notification: {
            title: 'Run ended · fabrica',
            body: 'READY_EMPTY after 12 tickets',
            target: toProject,
          },
        }),
      ),
      Command.resolve(ShowNotification, Message.CompletedShowNotification()),
    )
  })

  test('an end without its reason tells the exit code', () => {
    expect(
      told(RunEvent.cases.end.make({ time, run, code: 7 })).commands?.map(
        command => command.args,
      ),
    ).toEqual([
      {
        notification: {
          title: 'Run ended · fabrica',
          body: 'It ended with exit code 7.',
          target: toProject,
        },
      },
    ])
  })

  test('a hold on something outside the run tells; a lifted one, or the machine budget, doesn’t', () => {
    for (const kind of [
      'ENVIRONMENT',
      'USAGE_LIMIT',
      'CREDENTIALS',
      'BUDGET',
    ] as const) {
      expect(told(hold(kind)).commands?.map(command => command.args)).toEqual([
        {
          notification: {
            title: 'Run held · fabrica',
            body: `HOLD: ${kind}`,
            target: toProject,
          },
        },
      ])
    }
    expect(
      told(hold('USAGE_LIMIT', true)).commands?.map(command => command.args),
    ).toEqual([])
    expect(
      told(hold('MACHINE')).commands?.map(command => command.args),
    ).toEqual([])
    expect(
      told(
        RunEvent.cases.drain.make({ time, run, text: 'drain' }),
      ).commands?.map(command => command.args),
    ).toEqual([])
  })

  test('the battery tells at 10%, not at 20%', () => {
    expect(
      told(battery(20, 20)).commands?.map(command => command.args),
    ).toEqual([])
    expect(
      told(battery(10, 10)).commands?.map(command => command.args),
    ).toEqual([
      {
        notification: {
          title: 'Battery at 10% · fabrica',
          body: 'the battery is at 10%, discharging',
          target: toProject,
        },
      },
    ])
  })

  test('the events so far tell nothing; a later snapshot tells only those past them', () => {
    const first = update(
      update(connected, receivedProjects(running)).model,
      Message.ReceivedRunEvents({
        engine: localEngineName,
        project,
        run,
        items: [
          {
            _tag: 'snapshot',
            epoch,
            seq: 0,
            value: [start(undefined), hold('USAGE_LIMIT'), battery(10, 10)],
          },
        ],
      }),
    )
    expect(first.commands?.map(command => command.args)).toEqual([])
    const again = update(
      first.model,
      Message.ReceivedRunEvents({
        engine: localEngineName,
        project,
        run,
        items: [
          {
            _tag: 'snapshot',
            epoch: StreamEpoch.make('epoch-2'),
            seq: 0,
            value: [
              start(undefined),
              hold('USAGE_LIMIT'),
              battery(10, 10),
              hold('CREDENTIALS'),
            ],
          },
        ],
      }),
    )
    expect(again.commands?.map(command => command.args)).toEqual([
      {
        notification: {
          title: 'Run held · fabrica',
          body: 'HOLD: CREDENTIALS',
          target: toProject,
        },
      },
    ])
  })

  test('a long text is cut to fit, an ellipsis ending it', () => {
    const long = 'x'.repeat(600)
    const [command] =
      told(
        RunEvent.cases.hold.make({
          time,
          run,
          hold: 'ENVIRONMENT',
          text: long,
        }),
      ).commands ?? []
    expect(command?.args).toMatchObject({
      notification: { body: `${'x'.repeat(499)}…` },
    })
    expect(titleMaxLength).toBeGreaterThan('Permission request · '.length)
  })
})

describe('the runs whose events are read', () => {
  test('a run going is read from the projects’ statuses; its events ending stop the reading', () => {
    const shown = update(connected, receivedProjects(running)).model
    expect(watchedRuns(shown.notify)).toEqual([
      { engine: localEngineName, project, run },
    ])
    const ended = update(
      shown,
      Message.EndedRunEvents({ engine: localEngineName, project, run }),
    ).model
    expect(watchedRuns(ended.notify)).toEqual([])
    // Still shown as running, it isn't read again; once idle, it is forgotten.
    const stillRunning = update(ended, receivedProjects(running)).model
    expect(watchedRuns(stillRunning.notify)).toEqual([])
    expect(stillRunning.notify.runs).toHaveLength(1)
    const idled = update(stillRunning, receivedProjects(idle)).model
    expect(idled.notify.runs).toEqual([])
  })

  test('the same runs keep the model as it is', () => {
    const shown = update(connected, receivedProjects(running)).model
    expect(
      receivedRuns(shown.notify, [{ engine: localEngineName, project, run }]),
    ).toBe(shown.notify)
  })

  test('events of a run not read are ignored', () => {
    story(
      update,
      given(connected),
      message(
        Message.ReceivedRunEvents({
          engine: localEngineName,
          project,
          run,
          items: events(RunEvent.cases.end.make({ time, run, code: 0 })),
        }),
      ),
      Command.expectNone(),
    )
  })
})

describe('a click on a notification', () => {
  const elsewhere: Model = {
    ...plainRun,
    screen: Screen.Backlog(),
    scope: Option.some(other),
  }

  test('focuses the request on the console, in its project', () => {
    story(
      update,
      given(elsewhere),
      message(
        Message.ClickedNotification({
          target: NotificationTarget.cases.Request.make({ ref: questionRef }),
        }),
      ),
      model(shown => {
        expect(shown.screen).toEqual(Screen.Console())
        expect(shown.scope).toEqual(Option.some(project))
        expect(shown.focusedRequest).toEqual(Option.some(questionRef))
      }),
    )
  })

  test('keeps every project in scope, where the request already shows', () => {
    story(
      update,
      given({ ...plainRun, screen: Screen.Settings() }),
      message(
        Message.ClickedNotification({
          target: NotificationTarget.cases.Request.make({ ref: permissionRef }),
        }),
      ),
      model(shown => {
        expect(shown.screen).toEqual(Screen.Console())
        expect(shown.scope).toEqual(Option.none())
        expect(shown.focusedRequest).toEqual(Option.some(permissionRef))
      }),
    )
  })

  test('on a run’s end, a hold or the battery, shows that project’s console', () => {
    story(
      update,
      given({ ...elsewhere, focusedRequest: Option.some(questionRef) }),
      message(Message.ClickedNotification({ target: toProject })),
      model(shown => {
        expect(shown.screen).toEqual(Screen.Console())
        expect(shown.scope).toEqual(Option.some(project))
        expect(shown.focusedRequest).toEqual(Option.none())
      }),
    )
  })

  test('a scope chosen afterwards drops the focus', () => {
    story(
      update,
      given(plainRun),
      message(
        Message.ClickedNotification({
          target: NotificationTarget.cases.Request.make({ ref: questionRef }),
        }),
      ),
      message(Message.SelectedScope({ project: Option.some(other) })),
      model(shown => {
        expect(shown.focusedRequest).toEqual(Option.none())
      }),
    )
  })
})
