import { DateTime, Layer, Option, Schema } from 'effect'
import { Runtime } from 'foldkit'

import {
  AttentionRequest,
  EngineId,
  HostLoad,
  MessageId,
  ProjectId,
  ProjectRunState,
  ProjectStatus,
  RunEvent,
  RunId,
  RunView,
  StreamEpoch,
  TalkId,
  UsageWindow,
  protocolVersion,
} from '@fabrica/contracts'

import { dayOf } from '../../src/app/clock'
import { Connection } from '../../src/app/connection'
import { AppHost, noAppHost } from '../../src/app/host'
import { Model, initialModel } from '../../src/app/model'
import { layerNotifier, silentNotifier } from '../../src/app/notifier'
import { layerThemeHost, themeHostOf } from '../../src/app/theme-host'
import { update } from '../../src/app/update'
import { view } from '../../src/app/view'
import * as Sidebar from '../../src/console/sidebar'
import * as TalkPanel from '../../src/console/talk-panel'
import { Theme, applyTheme, defaultTheme } from '../../src/theme/theme'

// The console's scene for the look test (spec §18.2, §24): fixture data as close to the handoff's
// reference (design/console/reference.png) as Fabrica's model allows, so that what still differs is
// the look and not the content. Seven projects named as the reference names its sessions, the first
// selected with a run of four tickets in progress, the reference's conversation as its run talk, the
// reference's four History events, its three attention cards, and its title bar's host load. Fabrica's own departures (the "All projects" row, the
// stats row's items and run controls, the usage windows, native window controls, lower-case ticket IDs)
// are the spec's, and the look test masks them.

const engine = EngineId.make('e-1')
const run = RunId.make('r-1')

/** Thursday 29 October 2026, 10:45 UTC: the scene's now, in UTC so that its times read the same anywhere. */
const at = Date.UTC(2026, 9, 29, 10, 45, 0)
const now = DateTime.makeZonedUnsafe(at, { timeZone: 'UTC' })

const minutes = (n: number): number => n * 60_000

/** The reference's sessions as projects: a name, a Base and the run's state its row shows. */
const projectRows: ReadonlyArray<
  readonly [name: string, base: string, run: ProjectRunState]
> = [
  [
    'Auth refresh rewrite',
    'feat/auth-rt',
    ProjectRunState.cases.waiting.make({ run, overnight: false, needsYou: 3 }),
  ],
  [
    'Billing webhooks',
    'fix/stripe-retry',
    ProjectRunState.cases.running.make({
      run: RunId.make('r-2'),
      overnight: false,
    }),
  ],
  [
    'Search indexer perf',
    'perf/indexer',
    ProjectRunState.cases.running.make({
      run: RunId.make('r-3'),
      overnight: false,
    }),
  ],
  [
    'Onboarding copy pass',
    'chore/copy',
    ProjectRunState.cases.waiting.make({
      run: RunId.make('r-4'),
      overnight: false,
      needsYou: 1,
    }),
  ],
  [
    'Postgres 17 migration',
    'ops/pg17',
    ProjectRunState.cases.waiting.make({
      run: RunId.make('r-5'),
      overnight: false,
      needsYou: 1,
    }),
  ],
  [
    'Flaky e2e triage',
    'test/e2e-flake',
    ProjectRunState.cases.running.make({
      run: RunId.make('r-6'),
      overnight: false,
    }),
  ],
  ['Dark mode tokens', 'feat/dark', ProjectRunState.cases.idle.make({})],
]

const projectIds = projectRows.map((_, index) =>
  ProjectId.make(`p-${index + 1}`),
)

/** The project the sidebar has selected: the first, as the reference selects its first session. */
const project = projectIds[0] ?? ProjectId.make('p-1')

const projects = projectRows.map(
  ([name, base, state], index) =>
    new ProjectStatus({
      project: projectIds[index] ?? project,
      name,
      base,
      setUp: true,
      trusted: true,
      run: state,
      ready: 0,
    }),
)

const gb = 1024 ** 3

/** The reference's title bar: 11.2 of 32 GB, 47% CPU on 10 cores, 6 of them busy. */
const load = Schema.decodeUnknownSync(Schema.toCodecJson(HostLoad))({
  sampledAt: at,
  memory: {
    used: Math.round(11.2 * gb),
    total: 32 * gb,
    pressure: 'normal',
  },
  swapping: false,
  load1: 4.7,
  cores: 10,
  busyCores: 6,
  workers: [],
  mergeCheck: null,
})

const usageWindow = (window: string, utilization: number): UsageWindow =>
  Schema.decodeUnknownSync(Schema.toCodecJson(UsageWindow))({
    provider: 'anthropic',
    window,
    utilization,
    resetsAt: null,
  })

const decodeRequest = Schema.decodeUnknownSync(
  Schema.toCodecJson(AttentionRequest),
)

/** The reference's attention cards: an approval, a question and a review, as the stream sends them. */
const attentionJson = [
  {
    _tag: 'permission',
    project,
    id: 'perm-1',
    ticket: 'eng-377',
    session: 's-377',
    tool: 'bash',
    input: { command: 'pnpm db:migrate --env prod' },
    shown: { _tag: 'command', lines: ['pnpm db:migrate --env prod'] },
    why: 'Destructive migration needs approval before running on prod.',
    openedAt: at - minutes(14),
  },
  {
    _tag: 'question',
    project,
    ticket: 'eng-405',
    title: 'Rotate refresh tokens on reuse?',
    description:
      'Spec is ambiguous: revoke the whole family or only the one token?',
    choices: {
      options: [
        {
          label: 'The whole family',
          tradeOff: 'Safer; signs every device out',
        },
        {
          label: 'Only the one token',
          tradeOff: 'Gentler; a stolen family lives on',
        },
      ],
      recommended: 0,
    },
    consequential: false,
    maintainerOnly: false,
    blocks: ['eng-401'],
    askedFrom: 'eng-401',
    openedAt: at - minutes(9),
  },
  {
    _tag: 'review',
    project,
    ticket: 'eng-419',
    title: 'Welcome email tone',
    reason: 'CHECKS_FAILED',
    openedAt: at - minutes(2),
  },
]

const attention: ReadonlyArray<AttentionRequest> = attentionJson.map(json =>
  decodeRequest(json),
)

/** A ticket in progress, in `phase`, started `elapsed` minutes ago. */
const ticketRow = (
  ticket: string,
  title: string,
  phase: unknown,
  elapsed: number,
) => ({
  ticket,
  title,
  type: 'task',
  priority: 2,
  phase,
  since: at - minutes(elapsed),
  startedAt: at - minutes(elapsed),
  solo: false,
  handBacks: { resolve: 0, fix: 0 },
})

const workerRow = (ticket: string, tool: string, argument: string) => ({
  ticket,
  session: `s-${ticket}`,
  model: 'claude-opus-5-5',
  startedAt: at - minutes(30),
  action: { tool, argument, at: at - 5_000 },
  context: null,
  steered: false,
})

/** The selected project's run: the reference's four tickets in progress, its counts and tokens. */
const runView = Schema.decodeUnknownSync(Schema.toCodecJson(RunView))({
  header: {
    run,
    project,
    engine,
    mode: { _tag: 'tickets' },
    state: 'running',
    startedAt: at - minutes(90),
    offline: false,
    autoAnswer: false,
  },
  totals: {
    live: 4,
    slots: 4,
    counts: {
      in_queue: 2,
      working: 3,
      waiting_to_merge: 1,
      needs_you: 3,
      set_aside: 1,
      carried_over: 0,
      done: 23,
    },
    tokens: {
      input: 900_000,
      output: 300_000,
      cache_write: 0,
      cache_read: 0,
    },
    costUsd: null,
  },
  tickets: [
    ticketRow(
      'eng-412',
      'Retry failed Stripe webhooks',
      { _tag: 'working' },
      18,
    ),
    ticketRow(
      'eng-398',
      'Batch writes in search indexer',
      { _tag: 'verifying', round: 1 },
      66,
    ),
    ticketRow(
      'eng-421',
      'Quarantine flaky checkout spec',
      { _tag: 'waiting_to_merge', place: 1 },
      27,
    ),
    ticketRow('eng-430', 'Map tokens to dark palette', { _tag: 'working' }, 4),
  ],
  workers: [
    workerRow('eng-412', 'edit', 'src/stripe/retry.test.ts'),
    workerRow('eng-398', 'bash', 'pnpm bench indexer'),
    workerRow('eng-430', 'read', 'src/theme/tokens.css'),
  ],
  queue: { merging: null, train: null, waiting: ['eng-421'] },
  holds: [],
  banners: [],
  attention: attentionJson,
  load: null,
  steps: [],
})

const decodeEvent = Schema.decodeUnknownSync(Schema.toCodecJson(RunEvent))

/** An event of the run, recorded at `time` (hh:mm, UTC). */
const event = (time: string, fields: object): RunEvent =>
  decodeEvent({ v: 1, time: `2026-10-29T${time}:00.000+00:00`, run, ...fields })

/** The reference's History, oldest first as the stream sends it. */
const events: ReadonlyArray<RunEvent> = [
  event('10:20', {
    kind: 'warn',
    ticket: 'eng-421',
    text: 'eng-421 hit a CI failure · retrying',
  }),
  event('10:31', {
    kind: 'closed',
    ticket: 'eng-401',
    title: 'Rate-limit headers',
    detail: 'merged',
    text: 'eng-401 merged · rate-limit headers',
  }),
  event('10:38', {
    kind: 'asked',
    ticket: 'eng-401',
    title: 'Rate-limit headers',
    question: 'eng-405',
    detail: 'eng-405 Rotate refresh tokens on reuse?',
    text: 'eng-401 asked for approval · eng-377',
  }),
  event('10:42', {
    kind: 'closed',
    ticket: 'eng-412',
    title: 'Retry failed Stripe webhooks',
    detail: 'pr',
    text: 'eng-412 opened PR 812 · Stripe retries',
  }),
]

/** The reference's conversation, as the selected project's run talk, with the context it used. */
const talkPanel: TalkPanel.Model = {
  ...TalkPanel.init(),
  run: TalkPanel.Run.Open({
    conversation: {
      talk: TalkId.make('t-run'),
      project,
      mode: 'run',
      model: 'claude',
      lines: [
        {
          _tag: 'said',
          id: MessageId.make('m-1'),
          role: 'user',
          text: 'Hold the indexer work until the sessions-table migration is approved.',
        },
        {
          _tag: 'said',
          id: MessageId.make('m-2'),
          role: 'assistant',
          text: 'Paused Agent 03 on ENG-398. Resumes once ENG-377 is approved.',
        },
      ],
      context: Option.some(14_000),
      ended: false,
    },
  }),
}

/** The scene's Model: connected, the first project selected, every stream's latest value in. */
export const consoleScene = (): Model => {
  const base = initialModel({ platform: 'darwin', release: '0.0.0' })
  return {
    ...base,
    connection: Connection.Up({
      engine,
      release: '0.1.0',
      protocol: protocolVersion,
    }),
    scope: Option.some(project),
    now: Option.some(now),
    today: Option.some(dayOf(now)),
    load: Option.some(load),
    usage: Option.some([
      usageWindow('five_hour', 0.41),
      usageWindow('seven_day', 0.12),
    ]),
    runView: Option.some(runView),
    attention: Option.some(attention),
    events: [{ project, events: [...events].reverse() }],
    console: {
      ...base.console,
      talkPanel,
      sidebar: Sidebar.receivedProjects(base.console.sidebar, {
        engine,
        name: 'local',
        items: [
          {
            _tag: 'snapshot',
            epoch: StreamEpoch.make('epoch-1'),
            seq: 0,
            value: projects,
          },
        ],
      }),
    },
  }
}

/**
 * Draws the scene in `target`'s document, in `theme`: the console's own update and view over the
 * scene's Model, with nothing connected, no notifications and no app around it.
 */
export const mountConsoleScene = (target: Window, theme: Theme): void => {
  applyTheme(target.document.documentElement, theme)
  const model = consoleScene()
  const application = Runtime.makeApplication({
    Model,
    init: () => ({ model }),
    update,
    view,
    container: target.document.getElementById('root'),
    resources: Layer.mergeAll(
      layerNotifier(silentNotifier),
      Layer.succeed(AppHost, noAppHost),
      layerThemeHost(themeHostOf(target)),
    ),
  })
  Runtime.run(application)
}

const decodeTheme = Schema.decodeUnknownOption(Theme)

/** Draws the scene in the theme `target`'s address names (`?theme=classic`), or the default one. */
export const mountConsoleSceneFrom = (target: Window): void =>
  mountConsoleScene(
    target,
    Option.getOrElse(
      decodeTheme(new URLSearchParams(target.location.search).get('theme')),
      () => defaultTheme,
    ),
  )
