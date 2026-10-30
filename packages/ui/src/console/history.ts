import { Array, DateTime, Option, Schema } from 'effect'
import { Update } from 'foldkit'
import { type Html, type HtmlBuilder, childAttributes } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { type LocalTime, RunEvent } from '@fabrica/contracts'
import * as VirtualList from '@foldkit/ui/virtualList'

import { sameDay, sayMoment } from '../app/clock'
import { type EngineProject, projectKey } from '../app/engine-project'

// The console's History panel (spec §18.3; Appendix A.2, A.3): the scope's events from the event
// stream (§13.12), newest first, each a time in the viewer's zone (with the day when it isn't today,
// §7.7), a 6×6 dot in its role's colour and one line, cut. The line is the event's own, as the log says
// it; the kinds that only count or measure (a turn, a phase, the queue's size, a check's record, a
// usage window) have none. New events go on at the top, and the list is virtualised (§18.5): only the
// rows in view are drawn. Under All projects it shows every project's events, merged newest first by
// the moment each was recorded, each row marked with its project's chip.

/** A status role (§18.2): working, needs you, failed or set aside, merged or done, information. */
export type Role = 'c1' | 'c2' | 'c3' | 'c4' | 'c5'

/** What a row says: its role and its line. */
export interface HistoryLine {
  readonly role: Role
  readonly text: string
}

const line = (role: Role, text: string): Option.Option<HistoryLine> =>
  Option.some({ role, text: text.trim() })

/** Its role and line where `event` has one in History; none for the kinds that only count or measure. */
export const historyLine = (event: RunEvent): Option.Option<HistoryLine> =>
  RunEvent.match(event, {
    start: ({ branch }) => line('c1', `Run started on ${branch}`),
    dispatch: ({ text }) => line('c1', text),
    resumed: ({ ticket, why, text }) =>
      line('c1', `${ticket} ${text ?? `resumed: ${why.replaceAll('_', ' ')}`}`),

    closed: ({ text }) => line('c4', text),
    done: ({ text }) => line('c4', text),

    asked: ({ text }) => line('c2', text),
    battery: ({ threshold, text }) =>
      line(threshold === undefined ? 'c5' : 'c2', text),

    warn: ({ text }) => line('c3', text),
    deferred: ({ text }) => line('c3', text),
    hold: ({ lifted, text }) => line(lifted === true ? 'c5' : 'c3', text),
    usage_limit: ({ text }) => line('c3', text),
    credentials_hold: ({ text }) => line('c3', text),
    merge_conflict: ({ text }) => line('c3', text),
    stop: ({ text }) => line('c3', text),
    full_check: ({ detail, text }) =>
      line(
        detail === 'passed'
          ? 'c4'
          : detail === 'failed' || detail === 'timed out'
            ? 'c3'
            : 'c5',
        text,
      ),

    info: ({ text }) => line('c5', text),
    drain: ({ text }) => line('c5', text ?? 'Draining'),
    resume: ({ text }) => line('c5', text ?? 'Drain taken back'),
    probed: ({ text }) => line('c5', text),
    usage_limit_lifted: ({ text }) => line('c5', text),
    credentials_lifted: ({ text }) => line('c5', text),
    slept: ({ text }) => line('c5', text),
    answered: ({ text }) => line('c5', text),
    auto_answered: ({ text }) => line('c5', text),
    waits: ({ text }) => line('c5', text),
    reopened: ({ text }) => line('c5', text),
    requeued: ({ ticket, detail }) =>
      line('c5', `${ticket} requeued: ${detail}`),
    triage: ({ text }) => line('c5', text),
    organ: ({ organ, ticket, outcome }) =>
      line(
        'c5',
        `${organ}${ticket === undefined ? '' : ` on ${ticket}`}: ${outcome === 'answered' ? 'answered' : 'no result'}`,
      ),

    usage_window: () => Option.none(),
    check: () => Option.none(),
    end: () => Option.none(),
    phase: () => Option.none(),
    queue: () => Option.none(),
    settled: () => Option.none(),
    ticket_end: () => Option.none(),
    suspended: () => Option.none(),
    turn: () => Option.none(),
  })

/** A project's chip, as the sidebar draws it: its colour and its two-digit label. */
export interface Chip {
  readonly role: Role
  readonly label: string
}

/** One project's events, newest first, and the chip its rows carry: none in a project's own scope. */
export interface ProjectEvents {
  /** The project, named with its engine. */
  readonly project: EngineProject
  readonly events: ReadonlyArray<RunEvent>
  readonly chip: Option.Option<Chip>
}

/**
 * A row of the list: its event's time and line and its project's chip, keyed by the event's project
 * and its place in the run's stream.
 */
export interface HistoryRow extends HistoryLine {
  readonly key: string
  readonly time: LocalTime
  readonly chip: Option.Option<Chip>
}

const momentOf = (time: LocalTime): DateTime.Utc => DateTime.makeUnsafe(time)

/** One project's rows, newest first as its events are kept: each event that has a line. */
const projectRows = ({
  project,
  events,
  chip,
}: ProjectEvents): ReadonlyArray<HistoryRow> =>
  Array.getSomes(
    Array.map(events, (event, index) =>
      Option.map(historyLine(event), said => ({
        ...said,
        key: `${projectKey(project)}:${event.run}:${events.length - 1 - index}`,
        time: event.time,
        chip,
      })),
    ),
  )

/**
 * Two lists of rows, each newest first, merged newest first by the moment each was recorded (times of
 * engines in different zones compare as instants); on a tie, `newer`'s row first, and each list keeps
 * its own order.
 */
const mergeRows = (
  newer: ReadonlyArray<HistoryRow>,
  older: ReadonlyArray<HistoryRow>,
): ReadonlyArray<HistoryRow> => {
  const merged: Array<HistoryRow> = []
  let a = 0
  let b = 0
  for (;;) {
    const left = newer[a]
    const right = older[b]
    if (left === undefined || right === undefined) {
      return [...merged, ...newer.slice(a), ...older.slice(b)]
    }
    if (DateTime.isLessThan(momentOf(left.time), momentOf(right.time))) {
      merged.push(right)
      b += 1
    } else {
      merged.push(left)
      a += 1
    }
  }
}

const noRows: ReadonlyArray<HistoryRow> = []

/** The rows of every project's events, newest first: each event that has a line. */
export const historyRows = (
  projects: ReadonlyArray<ProjectEvents>,
): ReadonlyArray<HistoryRow> =>
  Array.reduce(projects, noRows, (rows, project) =>
    mergeRows(rows, projectRows(project)),
  )

/**
 * A row's height: 5px above and below the 12px text's line (Appendix A.2), the handoff's reference
 * drawing the first row's dot 86px above the fourth's.
 */
export const rowHeightPx = 86 / 3

/** The time column's width: a time, or a day and a time (`Wed 28 Oct 23:30`) once the oldest row isn't today's. */
export const timeWidth = { today: '40px', otherDay: '116px' }

/**
 * A row's time in the viewer's zone, with its day when it isn't today (`sayMoment`, §7.7); before the
 * first tick tells the viewer's day, the time as it was recorded, in its own zone.
 */
export const historyTime = (
  time: LocalTime,
  today: Option.Option<DateTime.Zoned>,
): string =>
  Option.match(today, {
    onNone: () => time.slice(11, 16),
    onSome: day => sayMoment(momentOf(time), day),
  })

const onToday = (
  time: LocalTime,
  today: Option.Option<DateTime.Zoned>,
): boolean =>
  Option.match(today, {
    onNone: () => true,
    onSome: day => sameDay(momentOf(time), day),
  })

const dotColour: Record<Role, string> = {
  c1: 'bg-c1',
  c2: 'bg-c2',
  c3: 'bg-c3',
  c4: 'bg-c4',
  c5: 'bg-c5',
}

export const Model = Schema.Struct({ list: VirtualList.Model })
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  GotListMessage: { message: VirtualList.Message },
})
export type Message = typeof Message.Type

export const init = (): Model => ({
  list: VirtualList.init({ id: 'history', rowHeightPx }),
})

const foldList = Update.foldChild({
  update: VirtualList.update,
  read: (model: Model) => Option.some(model.list),
  write: (model: Model, list: VirtualList.Model) =>
    modifyFields(model, { list: () => list }),
  toParentMessage: (message: VirtualList.Message) =>
    Message.GotListMessage({ message }),
})

export const update = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    GotListMessage: ({ message }) => foldList(model, message),
  })

/** What the frame gives the panel. */
export interface Inputs<ParentMessage> {
  /** The scope's events, each project's newest first, from its first snapshot. */
  readonly events: ReadonlyArray<ProjectEvents>
  /** The start of the viewer's day, in their zone; none before the first tick. */
  readonly today: Option.Option<DateTime.Zoned>
  readonly toParentMessage: (message: Message) => ParentMessage
}

const rowView = <ParentMessage>(
  row: HistoryRow,
  today: Option.Option<DateTime.Zoned>,
  width: string,
  h: HtmlBuilder<ParentMessage>,
): Html =>
  h.div(
    [
      h.DataAttribute('history-role', row.role),
      h.Title(row.text),
      h.Class('grid items-center gap-8 text-xs'),
      h.Style({
        gridTemplateColumns: Option.isSome(row.chip)
          ? `${width} 6px 16px minmax(0,1fr)`
          : `${width} 6px minmax(0,1fr)`,
        padding: '5px 12px',
        lineHeight: `${rowHeightPx - 10}px`,
      }),
    ],
    [
      h.time(
        [h.Class('font-mono text-muted'), h.Datetime(row.time)],
        [historyTime(row.time, today)],
      ),
      h.span([
        h.AriaHidden(true),
        h.DataAttribute('history-dot', row.role),
        h.Class(dotColour[row.role]),
        h.Style({ width: '6px', height: '6px' }),
      ]),
      Option.match(row.chip, {
        onNone: () => h.empty,
        onSome: chip =>
          h.span(
            [
              h.DataAttribute('history-chip', chip.role),
              h.Class(
                `flex items-center justify-center rounded-button font-extrabold text-ink ${dotColour[chip.role]}`,
              ),
              h.Style({ width: '16px', height: '16px', fontSize: '9px' }),
            ],
            [chip.label],
          ),
      }),
      h.span(
        [
          h.DataAttribute('history-line', ''),
          h.Class('overflow-hidden text-ellipsis whitespace-nowrap'),
        ],
        [row.text],
      ),
    ],
  )

const header = <ParentMessage>(
  today: boolean,
  h: HtmlBuilder<ParentMessage>,
): Html =>
  h.div(
    [
      h.Class('flex items-center border-b border-line'),
      h.Style({ padding: '8px 12px' }),
    ],
    [
      h.h2(
        [h.Class('font-extrabold'), h.Style({ fontSize: '13px' })],
        ['History'],
      ),
      today
        ? h.span([h.Class('ml-auto text-xs text-muted')], ['Today'])
        : h.empty,
    ],
  )

const notice = <ParentMessage>(
  text: string,
  h: HtmlBuilder<ParentMessage>,
): Html =>
  h.p([h.Class('text-xs text-muted'), h.Style({ padding: '5px 12px' })], [text])

export const view = <ParentMessage>(
  model: Model,
  { events, today, toParentMessage }: Inputs<ParentMessage>,
  h: HtmlBuilder<ParentMessage>,
): Html => {
  const rows = historyRows(events)
  const oldest = Array.last(rows)
  const allToday = Option.match(oldest, {
    onNone: () => true,
    onSome: row => onToday(row.time, today),
  })
  return h.div(
    [h.Class('flex min-h-0 flex-1 flex-col')],
    [
      header(Option.isSome(oldest) && allToday, h),
      rows.length === 0
        ? notice('No events yet', h)
        : h.submodel({
            slotId: 'history-list',
            model: model.list,
            view: VirtualList.view<HistoryRow>(),
            viewInputs: {
              items: rows,
              itemToKey: row => row.key,
              itemToView: row =>
                rowView(
                  row,
                  today,
                  allToday ? timeWidth.today : timeWidth.otherDay,
                  h,
                ),
              containerClassName: 'min-h-0 flex-1',
              containerAttributes: childAttributes([h.AriaLabel('Events')]),
            },
            toParentMessage: message =>
              toParentMessage(Message.GotListMessage({ message })),
          }),
    ],
  )
}
