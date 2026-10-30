import { Array, Match, Option, Schema } from 'effect'

import {
  type AttentionClosed,
  AttentionRef,
  type AttentionRequest,
  type HoldKind,
  ProjectId,
  type ProjectStatus,
  type RunEvent,
  RunId,
  attentionKey,
} from '@fabrica/contracts'

import { EngineProject } from './engine-project'

// The app's system notifications (spec §18.5, §7.7, §15.2): a question, a permission request, a run's
// end, a hold, and the battery at 10%, each told once, as it arrives; nothing for what was already
// there when the app started listening, nor for a question the run's `--auto-answer` answers at once.
// The renderer decides here what to tell and asks main to show it through the preload's validated
// `notify`; a click on one comes back as its target, which the console focuses: the request, or the
// project its run belongs to, each named with its engine. This module imports nothing but `effect`, the
// contracts and engine-project.ts, which imports nothing more, so the preload and main decode with the
// same schemas.

/** What a click on a notification focuses: an attention request on an engine, or a project's run. */
export const NotificationTarget = Schema.TaggedUnion({
  Request: { engine: Schema.String, ref: AttentionRef },
  Project: EngineProject.fields,
})
export type NotificationTarget = typeof NotificationTarget.Type

/** The most a notification's title holds. */
export const titleMaxLength = 120

/** The most a notification's body holds. */
export const bodyMaxLength = 500

/** A system notification, as the page asks main to show it. */
export const DesktopNotification = Schema.Struct({
  title: Schema.NonEmptyString.check(Schema.isMaxLength(titleMaxLength)),
  body: Schema.String.check(Schema.isMaxLength(bodyMaxLength)),
  target: NotificationTarget,
})
export type DesktopNotification = typeof DesktopNotification.Type

/** A run whose events are read for what to tell. */
export const RunWatch = Schema.Struct({
  /** The name of the engine it runs on, as the sidebar's rows say it. */
  engine: Schema.String,
  project: ProjectId,
  run: RunId,
  /** How many of its events have been read: none until its first snapshot, which tells nothing. */
  read: Schema.Option(Schema.Int),
  /** Started with `--auto-answer` answering at once (§15.2). */
  autoAnswersAtOnce: Schema.Boolean,
  /** How it ended, as its `done` or `stop` record says, once one has come. */
  ending: Schema.Option(Schema.String),
  /** Its events have ended: its run is over, or can't be read. */
  ended: Schema.Boolean,
})
export type RunWatch = typeof RunWatch.Type

/** An engine's open attention requests, from its stream's first snapshot, which tells nothing. */
export const EngineOpen = Schema.Struct({
  engine: Schema.String,
  /** The keys of the engine's open attention requests. */
  keys: Schema.Array(Schema.String),
})
export type EngineOpen = typeof EngineOpen.Type

export const Model = Schema.Struct({
  /** Each engine's open attention requests: an engine is missing until its first snapshot. */
  open: Schema.Array(EngineOpen),
  runs: Schema.Array(RunWatch),
})
export type Model = typeof Model.Type

export const init = (): Model => ({ open: [], runs: [] })

/** A model and the notifications to show. */
export interface Told {
  readonly model: Model
  readonly notifications: ReadonlyArray<DesktopNotification>
}

/** The name a project, named with its engine, is told by. */
export type ProjectName = (project: EngineProject) => string

/** `text` cut to `max` characters, an ellipsis ending it where it was cut. */
const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`

const notification = ({
  title,
  body,
  target,
}: {
  readonly title: string
  readonly body: string
  readonly target: NotificationTarget
}): DesktopNotification => ({
  title: clip(title, titleMaxLength),
  body: clip(body, bodyMaxLength),
  target,
})

/** A run, with the name of the engine it runs on. */
export interface EngineRun {
  readonly engine: string
  readonly project: ProjectId
  readonly run: RunId
}

/** The projects' runs, each on its engine, while they go: running, or waiting on the maintainer. */
export const liveRuns = (
  statuses: ReadonlyArray<{
    readonly engine: string
    readonly status: ProjectStatus
  }>,
): ReadonlyArray<EngineRun> =>
  statuses.flatMap(({ engine, status: { project, run } }) =>
    run._tag === 'idle' ? [] : [{ engine, project, run: run.run }],
  )

const sameRun =
  (a: EngineRun) =>
  (b: EngineRun): boolean =>
    a.engine === b.engine && a.project === b.project && a.run === b.run

/**
 * The runs `live` (from the projects' statuses) joined to those watched: a new one is watched from its
 * first snapshot; one whose events have ended is dropped once its project no longer shows it.
 */
export const receivedRuns = (
  model: Model,
  live: ReadonlyArray<EngineRun>,
): Model => {
  const added = live.filter(run => !model.runs.some(sameRun(run)))
  const kept = model.runs.filter(
    watch => !watch.ended || live.some(sameRun(watch)),
  )
  return added.length === 0 && kept.length === model.runs.length
    ? model
    : {
        ...model,
        runs: [
          ...kept,
          ...added.map(({ engine, project, run }) => ({
            engine,
            project,
            run,
            read: Option.none(),
            autoAnswersAtOnce: false,
            ending: Option.none(),
            ended: false,
          })),
        ],
      }
}

/** The runs whose events are read: those watched whose events haven't ended. */
export const watchedRuns = (model: Model): ReadonlyArray<EngineRun> =>
  model.runs
    .filter(watch => !watch.ended)
    .map(({ engine, project, run }) => ({ engine, project, run }))

/** Whether the run of `question`'s project on `engine` answers it at once, so it is told nothing (§15.2). */
const answeredAtOnce = (
  model: Model,
  engine: string,
  question: Extract<AttentionRequest, { readonly _tag: 'question' }>,
): boolean =>
  Option.isSome(question.choices) &&
  !question.consequential &&
  !question.maintainerOnly &&
  model.runs.some(
    watch =>
      watch.engine === engine &&
      watch.project === question.project &&
      !watch.ended &&
      watch.autoAnswersAtOnce,
  )

/** What a request that has just arrived tells: a question or a permission request; nothing else. */
const requestNotification = (
  model: Model,
  engine: string,
  request: AttentionRequest,
  name: ProjectName,
): Option.Option<DesktopNotification> =>
  Match.valueTags(request, {
    question: question =>
      answeredAtOnce(model, engine, question)
        ? Option.none()
        : Option.some(
            notification({
              title: `Question · ${name({ engine, project: question.project })}`,
              body: question.title,
              target: NotificationTarget.cases.Request.make({
                engine,
                ref: AttentionRef.cases.question.make({
                  project: question.project,
                  ticket: question.ticket,
                }),
              }),
            }),
          ),
    permission: permission =>
      Option.some(
        notification({
          title: `Permission request · ${name({ engine, project: permission.project })}`,
          body: `${permission.ticket} asks to use ${permission.tool}: ${permission.why}`,
          target: NotificationTarget.cases.Request.make({
            engine,
            ref: AttentionRef.cases.permission.make({
              project: permission.project,
              id: permission.id,
            }),
          }),
        }),
      ),
    task: () => Option.none(),
    review: () => Option.none(),
  })

/** The attention stream's items: what wasn't open before tells, except in the first snapshot. */
export type AttentionItem =
  | {
      readonly _tag: 'snapshot'
      readonly value: ReadonlyArray<AttentionRequest>
    }
  | {
      readonly _tag: 'patch'
      readonly value: {
        readonly upsert: ReadonlyArray<AttentionRequest>
        readonly remove: ReadonlyArray<AttentionClosed>
      }
    }

/** The keys of `engine`'s open attention requests: none until its first snapshot. */
const openOn = (
  model: Model,
  engine: string,
): Option.Option<ReadonlyArray<string>> =>
  Option.map(
    Array.findFirst(model.open, entry => entry.engine === engine),
    entry => entry.keys,
  )

/** `model` with `engine`'s open attention requests now `keys`; the other engines' kept. */
const withOpen = (
  model: Model,
  engine: string,
  keys: ReadonlyArray<string>,
): Model => ({
  ...model,
  open: Option.isSome(openOn(model, engine))
    ? model.open.map(entry =>
        entry.engine === engine ? { engine, keys } : entry,
      )
    : [...model.open, { engine, keys }],
})

/**
 * `items` of the attention stream of every project on the engine named `engine`, read for the requests
 * that have just arrived there.
 */
export const receivedAttention = (
  model: Model,
  engine: string,
  items: ReadonlyArray<AttentionItem>,
  name: ProjectName,
): Told =>
  Array.reduce<AttentionItem, Told>(
    items,
    { model, notifications: [] },
    (told, item) => {
      const open = openOn(told.model, engine)
      const arrived = (requests: ReadonlyArray<AttentionRequest>) =>
        Option.match(open, {
          onNone: () => [],
          onSome: keys =>
            requests.filter(request => !keys.includes(attentionKey(request))),
        })
      const [requests, nextOpen] =
        item._tag === 'snapshot'
          ? [
              arrived(item.value),
              item.value.map(request => attentionKey(request)),
            ]
          : [
              arrived(item.value.upsert),
              Option.match(open, {
                onNone: () => [],
                onSome: keys => {
                  const gone = item.value.remove.map(({ ref }) =>
                    attentionKey(ref),
                  )
                  const upserted = item.value.upsert.map(request =>
                    attentionKey(request),
                  )
                  return [
                    ...keys.filter(
                      key => !gone.includes(key) && !upserted.includes(key),
                    ),
                    ...upserted.filter(key => !gone.includes(key)),
                  ]
                },
              }),
            ]
      const next: Model =
        Option.isNone(open) && item._tag === 'patch'
          ? told.model
          : withOpen(told.model, engine, nextOpen)
      return {
        model: next,
        notifications: [
          ...told.notifications,
          ...requests.flatMap(request =>
            Option.toArray(requestNotification(next, engine, request, name)),
          ),
        ],
      }
    },
  )

/** The holds told: those that wait on something outside the run. A drain or a stop is the maintainer's own, a stop's end is told as the run's, and the machine budget lifts as soon as a worker ends. */
const toldHolds: ReadonlyArray<HoldKind> = [
  'ENVIRONMENT',
  'USAGE_LIMIT',
  'CREDENTIALS',
  'BUDGET',
]

/** The battery level told, of the two the engine warns at (§7.7). */
const toldBatteryThreshold = 10

/** `watch` after `event`, and what the event tells. */
const readEvent = (
  watch: RunWatch,
  event: RunEvent,
  name: ProjectName,
): readonly [RunWatch, Option.Option<DesktopNotification>] => {
  const project = { engine: watch.engine, project: watch.project }
  const target = NotificationTarget.cases.Project.make(project)
  return Match.value(event).pipe(
    Match.discriminators('kind')({
      start: ({ auto_answer }) =>
        [
          { ...watch, autoAnswersAtOnce: auto_answer === 0 },
          Option.none(),
        ] as const,
      done: ({ text }) =>
        [{ ...watch, ending: Option.some(text) }, Option.none()] as const,
      stop: ({ text }) =>
        [{ ...watch, ending: Option.some(text) }, Option.none()] as const,
      end: ({ code }) =>
        [
          { ...watch, ended: true },
          Option.some(
            notification({
              title: `Run ended · ${name(project)}`,
              body: Option.getOrElse(
                watch.ending,
                () => `It ended with exit code ${code}.`,
              ),
              target,
            }),
          ),
        ] as const,
      hold: ({ hold, lifted, text }) =>
        [
          watch,
          lifted !== true && toldHolds.includes(hold)
            ? Option.some(
                notification({
                  title: `Run held · ${name(project)}`,
                  body: text,
                  target,
                }),
              )
            : Option.none(),
        ] as const,
      battery: ({ level, threshold, text }) =>
        [
          watch,
          threshold === toldBatteryThreshold
            ? Option.some(
                notification({
                  title: `Battery at ${level}% · ${name(project)}`,
                  body: text,
                  target,
                }),
              )
            : Option.none(),
        ] as const,
    }),
    Match.orElse(() => [watch, Option.none()] as const),
  )
}

/** A watch after the events read, and what they told. */
type WatchRead = readonly [RunWatch, ReadonlyArray<DesktopNotification>]

/** `events` read into `watch`, with what they tell. */
const readEvents = (
  watch: RunWatch,
  events: ReadonlyArray<RunEvent>,
  name: ProjectName,
): WatchRead =>
  Array.reduce<RunEvent, WatchRead>(
    events,
    [watch, []],
    ([current, told], event) => {
      const [next, notification] = readEvent(current, event, name)
      return [next, [...told, ...Option.toArray(notification)]] as const
    },
  )

/** The run events stream's items: a snapshot of every event so far, or the events after them. */
export interface RunEventsItem {
  readonly _tag: 'snapshot' | 'patch'
  readonly value: ReadonlyArray<RunEvent>
}

/**
 * `items` of the events of `run`: the first snapshot is read for the run's settings and tells nothing;
 * a later snapshot tells the events past those read, and a patch its events.
 */
export const receivedRunEvents = (
  model: Model,
  {
    engine,
    project,
    run,
    items,
  }: EngineRun & { readonly items: ReadonlyArray<RunEventsItem> },
  name: ProjectName,
): Told => {
  const at = model.runs.findIndex(sameRun({ engine, project, run }))
  const watch = model.runs[at]
  if (watch === undefined) {
    return { model, notifications: [] }
  }
  const [read, notifications] = Array.reduce<RunEventsItem, WatchRead>(
    items,
    [watch, []],
    ([current, told], item) => {
      const fresh =
        item._tag === 'patch'
          ? item.value
          : Option.match(current.read, {
              onNone: () => [],
              onSome: count => item.value.slice(count),
            })
      const [settled] =
        item._tag === 'snapshot' && Option.isNone(current.read)
          ? readEvents(current, item.value, name)
          : [current]
      const [next, notified] = readEvents(settled, fresh, name)
      return [
        {
          ...next,
          read: Option.some(
            item._tag === 'snapshot'
              ? item.value.length
              : Option.getOrElse(current.read, () => 0) + item.value.length,
          ),
        },
        [...told, ...notified],
      ] as const
    },
  )
  return {
    model: {
      ...model,
      runs: model.runs.map((current, index) => (index === at ? read : current)),
    },
    notifications,
  }
}

/** The events of `run` ended: it is no longer read, and dropped once its project shows it no more. */
export const endedRunEvents = (model: Model, run: EngineRun): Model => ({
  ...model,
  runs: model.runs.map(watch =>
    sameRun(run)(watch) ? { ...watch, ended: true } : watch,
  ),
})

/** The preload's notifications, as the page reaches them: `window.fabrica.notifications`. */
export interface NotificationsApi {
  /** Asks main to show `notification`; main shows nothing while the app's window has focus. */
  readonly notify: (notification: DesktopNotification) => void
  /** Calls `listener` with the target of each notification clicked; the function returned stops it. */
  readonly onClick: (
    listener: (target: NotificationTarget) => void,
  ) => () => void
}
