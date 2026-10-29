import { Array, Data, Option, Schema } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import {
  AttentionRequest,
  Phase,
  type TicketId,
  type TicketRow,
  factsOf,
} from '@fabrica/contracts'

import { waitingWords } from './waiting'

// The console's Up next column (spec §18.3, H81): while nothing needs the maintainer, the queue takes
// the attention column's place, the ready tickets first, then each waiting one with why in words as
// the log says them (`waits for fa-12 to merge`, `touches src/auth/refresh.ts, like running fa-7`,
// `waits for the solo ticket fa-9`), a ticket waiting on a question showing the question, then
// `+N more`. A ready ticket is tagged Ready and a waiting one Waiting, so neither rests on colour
// alone (§18.2).

export const Model = Schema.Struct({})
export type Model = typeof Model.Type

export const init = (): Model => ({})

/** How many of the queue's tickets the column lists; the rest are `+N more`. */
export const shownAtMost = 8

/** A ticket's place in the queue: ready for a slot, or waiting, with why in words. */
export type Place = Data.TaggedEnum<{
  Ready: {}
  Waiting: { readonly why: string }
}>
export const Place = Data.taggedEnum<Place>()

/** The question `question` in words, with its own title where the attention requests have it. */
const questionWords = (
  question: TicketId,
  attention: ReadonlyArray<AttentionRequest>,
): string =>
  Option.match(
    Array.findFirst(
      attention.filter(AttentionRequest.guards.question),
      request => request.ticket === question,
    ),
    {
      onNone: () => `waits on the question ${question}`,
      onSome: request => `waits on the question ${question}: ${request.title}`,
    },
  )

/**
 * A ticket's place in the queue, as its phase says; none for a ticket out of it. The queue is what the
 * phase table counts in the queue (H58), each one's words from `waiting` (H81), so the stats row's count
 * and hover and this column agree; a ticket waiting on a question waits too, with the question.
 */
export const placeOf = (
  phase: Phase,
  attention: ReadonlyArray<AttentionRequest>,
): Option.Option<Place> =>
  factsOf(phase).counts === 'in_queue'
    ? Option.some(
        Option.match(waitingWords(phase), {
          onNone: () => Place.Ready(),
          onSome: why => Place.Waiting({ why }),
        }),
      )
    : Phase.guards.asked(phase)
      ? Option.some(
          Place.Waiting({ why: questionWords(phase.question, attention) }),
        )
      : Option.none()

/** A ticket in the queue and its place. */
export interface Entry {
  readonly row: TicketRow
  readonly place: Place
}

/** The queue, the ready tickets first, then the waiting ones, each in the run view's order. */
export const queue = (
  tickets: ReadonlyArray<TicketRow>,
  attention: ReadonlyArray<AttentionRequest>,
): ReadonlyArray<Entry> => {
  const entries = tickets.flatMap(row =>
    Option.match(placeOf(row.phase, attention), {
      onNone: () => [],
      onSome: place => [{ row, place }],
    }),
  )
  const isReady = (entry: Entry) => Place.$is('Ready')(entry.place)
  return [
    ...entries.filter(isReady),
    ...entries.filter(entry => !isReady(entry)),
  ]
}

/** What the frame gives Up next, from the scoped run's view (none without a run): its ticket rows, and its attention requests, for questions' titles. */
export interface Config {
  readonly tickets: ReadonlyArray<TicketRow>
  readonly attention: ReadonlyArray<AttentionRequest>
}

const tag = <Message>(place: Place, h: HtmlBuilder<Message>): Html =>
  h.span(
    [
      h.DataAttribute('place', place._tag),
      h.Class(
        Place.$match(place, {
          Ready: () => 'rounded-button bg-c5 font-extrabold text-ink',
          Waiting: () =>
            'rounded-button border border-line font-extrabold text-muted',
        }),
      ),
      h.Style({ fontSize: '11px', padding: '2px 6px' }),
    ],
    [place._tag],
  )

const entryView = <Message>(entry: Entry, h: HtmlBuilder<Message>): Html =>
  h.keyed('li')(
    entry.row.ticket,
    [
      h.DataAttribute('entry', entry.row.ticket),
      h.Class('flex flex-col border border-line bg-panel'),
      h.Style({ padding: '10px 14px', gap: '6px' }),
    ],
    [
      h.div(
        [h.Class('flex items-center gap-8')],
        [
          tag(entry.place, h),
          h.span(
            [h.Class('font-mono text-muted'), h.Style({ fontSize: '12px' })],
            [entry.row.ticket],
          ),
        ],
      ),
      h.span(
        [h.Class('truncate font-bold'), h.Style({ fontSize: '14px' })],
        [entry.row.title],
      ),
      Place.$match(entry.place, {
        Ready: () => h.empty,
        Waiting: ({ why }) =>
          h.span(
            [
              h.DataAttribute('reason', ''),
              h.Class('text-muted'),
              h.Style({ fontSize: '13px' }),
            ],
            [why],
          ),
      }),
    ],
  )

export const view = <Message>(
  _model: Model,
  config: Config,
  h: HtmlBuilder<Message>,
): Html => {
  const entries = queue(config.tickets, config.attention)
  const more = entries.length - shownAtMost
  return h.div(
    [h.Class('flex flex-col gap-8')],
    [
      h.div(
        [
          h.Class('flex items-center gap-8 border-b-2 border-c5'),
          h.Style({ paddingBottom: '8px' }),
        ],
        [
          h.h2(
            [h.Class('font-extrabold'), h.Style({ fontSize: '14px' })],
            ['Up next'],
          ),
          h.span(
            [
              h.DataAttribute('count', 'queue'),
              h.Class('font-bold text-c5'),
              h.Style({ fontSize: '12px' }),
            ],
            [String(entries.length)],
          ),
        ],
      ),
      entries.length === 0
        ? h.p(
            [h.Class('text-muted'), h.Style({ fontSize: '13px' })],
            ['Nothing in the queue.'],
          )
        : h.ul(
            [h.Class('flex flex-col gap-8')],
            entries.slice(0, shownAtMost).map(entry => entryView(entry, h)),
          ),
      more > 0
        ? h.p(
            [
              h.DataAttribute('more', String(more)),
              h.Class('text-muted'),
              h.Style({ fontSize: '13px' }),
            ],
            [`+${more} more`],
          )
        : h.empty,
    ],
  )
}
