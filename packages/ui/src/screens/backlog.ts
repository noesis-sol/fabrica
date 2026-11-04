import {
  Array,
  DateTime,
  Effect,
  HashSet,
  Option,
  Order,
  Queue,
  Schema,
  Stream,
} from 'effect'
import { Command, Update } from 'foldkit'
import * as AsyncData from 'foldkit/asyncData'
import { type Html, type HtmlBuilder, childAttributes } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import * as Mount from 'foldkit/mount'
import { modifyFields } from 'foldkit/struct'
import { defineView } from 'foldkit/submodel'

import {
  Edge,
  NotReadyReason,
  type Ticket,
  TicketChanges,
  TicketConflict,
  TicketId,
  type TicketRow,
  Why,
  draftedLabel,
  edgeWords,
} from '@fabrica/contracts'
import * as VirtualList from '@foldkit/ui/virtualList'

import { sayMoment } from '../app/clock'
import { EngineProject } from '../app/engine-project'
import { type EngineServices, requestProject } from '../app/engine-route'
import type { Role } from '../console/history'
import {
  Graph,
  drawGraph,
  focusTicket,
  graphKey,
  graphOf,
} from './backlog-graph'

// The Backlog screen (spec §18.4, H24, H40): the scoped project's epics and tickets, their links drawn
// as a graph, what is ready and why the rest isn't (`tickets.why`, in the log's words, H81), the
// questions, the deferred tickets, the tickets its run finished, and a sync's merge conflicts (§11.7);
// read-only, since the CLI and the run talk edit the backlog, but for a conflict's "use the other
// value". The tickets come from the backlog stream; what the engine says of them besides (the ready
// ones, each waiting one's reasons, the links, the conflicts) is asked as each frame of the stream
// comes, one request at a time, so a busy run's changes don't pile requests up. The list is
// virtualised (§18.5).

/** Which tickets the list shows. */
export const Section = Schema.Literals([
  'open',
  'epics',
  'ready',
  'waiting',
  'questions',
  'conflicts',
  'deferred',
  'finished',
  'closed',
])
export type Section = typeof Section.Type

/** The sections that list tickets; each conflict is a field of one, drawn with its values. */
export type TicketSection = Exclude<Section, 'conflicts'>

/** A section's name, as its tab says it. */
export const sectionTitle: Record<Section, string> = {
  open: 'Open',
  epics: 'Epics',
  ready: 'Ready',
  waiting: 'Waiting',
  questions: 'Questions',
  conflicts: 'Merge conflicts',
  deferred: 'Deferred',
  finished: 'Finished by the run',
  closed: 'Closed',
}

/** An open ticket that isn't ready, and why. */
export const Waiting = Schema.Struct({
  ticket: TicketId,
  reasons: Schema.NonEmptyArray(NotReadyReason),
})
export type Waiting = typeof Waiting.Type

/** What the engine says of a project's backlog besides its tickets. */
export const Facts = Schema.Struct({
  project: EngineProject,
  /** The tickets ready to dispatch, most urgent first. */
  ready: Schema.Array(TicketId),
  waiting: Schema.Array(Waiting),
  edges: Schema.Array(Edge),
  /** The questions whose options a talk drafted (§15.3). */
  drafted: Schema.Array(TicketId),
  /** The sync's merge conflicts still open, oldest first. */
  conflicts: Schema.Array(TicketConflict),
})
export type Facts = typeof Facts.Type

/** What the facts are asked of: the project, and its open tickets, whose reasons are asked. */
export const Ask = Schema.Struct({
  project: EngineProject,
  open: Schema.Array(TicketId),
})
export type Ask = typeof Ask.Type

/** Why a conflict's other value wasn't set. */
export const UseFailed = Schema.Struct({
  seq: TicketConflict.fields.seq,
  reason: Schema.String,
})
export type UseFailed = typeof UseFailed.Type

export const Model = Schema.Struct({
  list: VirtualList.Model,
  section: Section,
  selected: Schema.Option(TicketId),
  facts: AsyncData.Schema(Facts, Schema.String).schema,
  /** The project whose facts are being asked, while they are. */
  asking: Schema.Option(EngineProject),
  /** What to ask once the answer in flight comes: the backlog changed meanwhile. */
  again: Schema.Option(Ask),
  /** The conflict whose other value is being set, while it is; one at a time. */
  using: Schema.Option(TicketConflict.fields.seq),
  /** The conflict whose other value couldn't be set last, and why. */
  useFailed: Schema.Option(UseFailed),
})
export type Model = typeof Model.Type

/** A row's height: one 18px line with 5px above and below. */
export const rowHeightPx = 28

export const init = (): Model => ({
  list: VirtualList.init({ id: 'backlog', rowHeightPx }),
  section: 'open',
  selected: Option.none(),
  facts: AsyncData.Idle(),
  asking: Option.none(),
  again: Option.none(),
  using: Option.none(),
  useFailed: Option.none(),
})

export const Message = defineMessageUnion({
  ChoseSection: { section: Section },
  /** A ticket chosen in the list or the graph. */
  SelectedTicket: { ticket: TicketId },
  CompletedFocusGraph: {},
  GotListMessage: { message: VirtualList.Message },
  SucceededLoadFacts: { facts: Facts },
  FailedLoadFacts: { project: EngineProject, reason: Schema.String },
  /** "Use the other value" chosen on a conflict that has one to use. */
  ClickedUseOtherValue: {
    project: EngineProject,
    seq: TicketConflict.fields.seq,
    ticket: TicketId,
    changes: TicketChanges,
  },
  SucceededUseOtherValue: { seq: TicketConflict.fields.seq },
  FailedUseOtherValue: UseFailed.fields,
})
export type Message = typeof Message.Type

/** How many `tickets.why` requests go at once. */
const whyConcurrency = 4

/** The ready tickets and the links, then why each open ticket that isn't ready isn't. */
export const LoadFacts = Command.define('LoadFacts', {
  args: { ask: Ask },
  messages: [Message.SucceededLoadFacts, Message.FailedLoadFacts],
  execute: ({ ask: { project, open } }) =>
    requestProject(project, client =>
      Effect.gen(function* () {
        const [ready, edges, drafted, conflicts] = yield* Effect.all(
          [
            client.rpc['tickets.ready']({ project: project.project }),
            client.rpc['tickets.edges']({ project: project.project }),
            client.rpc['tickets.list']({
              project: project.project,
              filter: {
                status: Option.none(),
                type: Option.some(['question']),
                labels: Option.some([draftedLabel]),
                parent: Option.none(),
              },
            }),
            client.rpc['tickets.conflicts']({ project: project.project }),
          ],
          { concurrency: 'unbounded' },
        )
        const readyIds = HashSet.fromIterable(ready.map(ticket => ticket.id))
        const waiting = yield* Effect.forEach(
          open.filter(ticket => !HashSet.has(readyIds, ticket)),
          ticket =>
            client.rpc['tickets.why']({
              project: project.project,
              ticket,
            }).pipe(
              Effect.map(why =>
                Why.match(why, {
                  ready: () => Option.none<Waiting>(),
                  not_ready: ({ reasons }) => Option.some({ ticket, reasons }),
                }),
              ),
              // Gone since the backlog was sent: the next frame leaves it out.
              Effect.catchTag('TicketNotFound', () =>
                Effect.succeed(Option.none<Waiting>()),
              ),
            ),
          { concurrency: whyConcurrency },
        )
        return {
          project,
          ready: ready.map(ticket => ticket.id),
          waiting: Array.getSomes(waiting),
          edges,
          drafted: drafted.map(ticket => ticket.id),
          conflicts,
        }
      }),
    ).pipe(
      Effect.map(facts => Message.SucceededLoadFacts({ facts })),
      Effect.catch(reason =>
        Effect.succeed(Message.FailedLoadFacts({ project, reason })),
      ),
    ),
})

/**
 * Sets a conflict's field to the value the merge didn't keep. The change comes back on the backlog
 * stream, whose frame asks the facts again, without the conflict.
 */
export const UseOtherValue = Command.define('UseOtherValue', {
  args: {
    project: EngineProject,
    seq: TicketConflict.fields.seq,
    ticket: TicketId,
    changes: TicketChanges,
  },
  messages: [Message.SucceededUseOtherValue, Message.FailedUseOtherValue],
  execute: ({ project, seq, ticket, changes }) =>
    requestProject(project, client =>
      client.rpc['tickets.update']({
        project: project.project,
        ticket,
        changes,
      }),
    ).pipe(
      Effect.as(Message.SucceededUseOtherValue({ seq })),
      Effect.catch(reason =>
        Effect.succeed(Message.FailedUseOtherValue({ seq, reason })),
      ),
    ),
})

/** Selects the chosen ticket in the graph drawn and centres it there. */
export const FocusGraph = Command.define('FocusGraph', {
  args: { ticket: TicketId },
  messages: [Message.CompletedFocusGraph],
  execute: ({ ticket }) =>
    focusTicket(ticket).pipe(Effect.as(Message.CompletedFocusGraph())),
})

/** Draws the graph in its element, the chosen ticket selected in it, a tapped ticket chosen. */
export const DrawGraph = Mount.defineStream('DrawGraph', {
  args: { graph: Graph, selected: Schema.Option(TicketId) },
  messages: [Message.SelectedTicket],
  execute: ({ element, graph, selected }) =>
    Stream.callback<TicketId>(queue =>
      drawGraph({
        element,
        graph,
        selected,
        onTap: ticket => {
          Queue.offerUnsafe(queue, ticket)
        },
      }),
    ).pipe(Stream.map(ticket => Message.SelectedTicket({ ticket }))),
})

/** What the screen's Commands need: the engine connection. */
export type Requires = EngineServices

type Return = Update.Return<Model, Message, Requires>

/** As the screen opens or its project changes: nothing of another project's backlog kept. */
export const opened = (model: Model): Model =>
  modifyFields(model, {
    selected: () => Option.none(),
    facts: () => AsyncData.Idle(),
    asking: () => Option.none(),
    again: () => Option.none(),
    using: () => Option.none(),
    useFailed: () => Option.none(),
  })

const ask = (model: Model, next: Ask): Return => ({
  model: modifyFields(model, {
    facts: facts =>
      Option.getOrElse(AsyncData.revalidateOrLoad(facts), () => facts),
    asking: () => Option.some(next.project),
    again: () => Option.none(),
  }),
  commands: [LoadFacts({ ask: next })],
})

/** The project's backlog changed: its facts asked, or asked again once the answer in flight comes. */
export const receivedBacklog = (
  model: Model,
  {
    project,
    tickets,
  }: {
    readonly project: EngineProject
    readonly tickets: ReadonlyArray<Ticket>
  },
): Return => {
  const next: Ask = {
    project,
    open: tickets
      .filter(ticket => ticket.status === 'open')
      .map(ticket => ticket.id),
  }
  return Option.contains(model.asking, project)
    ? { model: modifyFields(model, { again: () => Option.some(next) }) }
    : ask(model, next)
}

/** An answer came for `project`: the next ask goes, if the backlog changed meanwhile. */
const answered = (
  model: Model,
  project: EngineProject,
  facts: Model['facts'],
): Return =>
  Option.contains(model.asking, project)
    ? Option.match(model.again, {
        onNone: () => ({
          model: modifyFields(model, {
            facts: () => facts,
            asking: () => Option.none(),
          }),
        }),
        onSome: next => ask(modifyFields(model, { facts: () => facts }), next),
      })
    : { model }

const foldList = Update.foldChild({
  update: VirtualList.update,
  read: (model: Model) => Option.some(model.list),
  write: (model: Model, list: VirtualList.Model) =>
    modifyFields(model, { list: () => list }),
  toParentMessage: (message: VirtualList.Message) =>
    Message.GotListMessage({ message }),
})

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    ChoseSection: ({ section }) => ({
      model:
        section === model.section
          ? model
          : modifyFields(model, { section: () => section }),
    }),
    SelectedTicket: ({ ticket }) =>
      Option.contains(model.selected, ticket)
        ? { model }
        : {
            model: modifyFields(model, { selected: () => Option.some(ticket) }),
            commands: [FocusGraph({ ticket })],
          },
    CompletedFocusGraph: () => ({ model }),
    GotListMessage: ({ message }) => foldList(model, message),
    SucceededLoadFacts: ({ facts }) =>
      answered(model, facts.project, AsyncData.succeed(facts)),
    FailedLoadFacts: ({ project, reason }) =>
      answered(model, project, AsyncData.fail(reason)),
    ClickedUseOtherValue: ({ project, seq, ticket, changes }) =>
      Option.isSome(model.using)
        ? { model }
        : {
            model: modifyFields(model, {
              using: () => Option.some(seq),
              useFailed: () => Option.none(),
            }),
            commands: [UseOtherValue({ project, seq, ticket, changes })],
          },
    SucceededUseOtherValue: ({ seq }) =>
      Option.contains(model.using, seq)
        ? { model: modifyFields(model, { using: () => Option.none() }) }
        : { model },
    FailedUseOtherValue: ({ seq, reason }) =>
      Option.contains(model.using, seq)
        ? {
            model: modifyFields(model, {
              using: () => Option.none(),
              useFailed: () => Option.some({ seq, reason }),
            }),
          }
        : { model },
  })

// What the screen shows: each ticket's mark, the sections' rows, the graph and the chosen ticket.

/** A ticket's status mark (§18.5): its role colour, a glyph beside it, and its word, so colour isn't alone. */
export interface Mark {
  readonly role: Role
  readonly glyph: string
  readonly word: string
}

const factsOf = (
  facts: Model['facts'],
  project: Option.Option<EngineProject>,
): Option.Option<Facts> =>
  Option.filter(AsyncData.getData(facts), loaded =>
    Option.contains(project, loaded.project),
  )

/** The tickets `facts` has ready, and those it has waiting with their reasons. */
export interface Readiness {
  readonly ready: HashSet.HashSet<TicketId>
  readonly waiting: ReadonlyMap<TicketId, Waiting['reasons']>
}

export const readinessOf = (
  facts: Option.Option<Facts>,
): Option.Option<Readiness> =>
  Option.map(facts, ({ ready, waiting }) => ({
    ready: HashSet.fromIterable(ready),
    waiting: new Map(waiting.map(({ ticket, reasons }) => [ticket, reasons])),
  }))

/** A ticket's mark: closed, at work, deferred, the maintainer's, ready, or waiting. */
export const markOf = (
  ticket: Ticket,
  readiness: Option.Option<Readiness>,
): Mark => {
  switch (ticket.status) {
    case 'closed':
      return { role: 'c4', glyph: '✓', word: 'closed' }
    case 'in_progress':
      return { role: 'c1', glyph: '●', word: 'in progress' }
    case 'deferred':
      return { role: 'c3', glyph: '‖', word: 'deferred' }
    case 'open':
      return ticket.type === 'question'
        ? { role: 'c2', glyph: '?', word: 'for you' }
        : ticket.type === 'manual'
          ? { role: 'c2', glyph: '!', word: 'your task' }
          : Option.match(readiness, {
              onNone: () => ({ role: 'c5', glyph: '·', word: 'open' }),
              onSome: ({ ready }) =>
                HashSet.has(ready, ticket.id)
                  ? { role: 'c5', glyph: '○', word: 'ready' }
                  : { role: 'c5', glyph: '◌', word: 'waiting' },
            })
  }
}

/** A row of the list. */
export interface BacklogRow {
  readonly ticket: TicketId
  readonly title: string
  /** `task · P2`. */
  readonly kind: string
  readonly mark: Mark
  /** What the row says on its right: why it waits, until when, how far an epic is. */
  readonly note: string
}

/** What the rows are made from. */
export interface RowInputs {
  readonly tickets: ReadonlyArray<Ticket>
  readonly facts: Option.Option<Facts>
  /** The scoped run's ticket rows, the only part of its view the screen draws; none without a run. */
  readonly runTickets: ReadonlyArray<TicketRow>
  readonly today: Option.Option<DateTime.Zoned>
}

/** Most urgent first, then oldest, as the engine lists them. */
const byUrgency: Order.Order<Ticket> = Order.combineAll([
  Order.mapInput(Order.Number, (ticket: Ticket) => ticket.priority),
  Order.mapInput(DateTime.Order, (ticket: Ticket) => ticket.createdAt),
  Order.mapInput(Order.String, (ticket: Ticket) => ticket.id),
])

const newestFirst: Order.Order<Ticket> = Order.flip(
  Order.mapInput(DateTime.Order, (ticket: Ticket) => ticket.updatedAt),
)

/** `fa-12`, `fa-12 and fa-13`, `fa-12, fa-13 and fa-14`. */
const ticketList = (tickets: Array.NonEmptyReadonlyArray<TicketId>): string =>
  tickets.length === 1
    ? Array.headNonEmpty(tickets)
    : `${Array.initNonEmpty(tickets).join(', ')} and ${Array.lastNonEmpty(tickets)}`

/** An epic's progress: how many of its children are closed. */
const epicNote = (
  epic: Ticket,
  edges: ReadonlyArray<Edge>,
  closed: HashSet.HashSet<TicketId>,
): string => {
  const children = edges.filter(
    edge => edge.kind === 'parent' && edge.from === epic.id,
  )
  return children.length === 0
    ? 'no tickets yet'
    : `${children.filter(edge => HashSet.has(closed, edge.to)).length} of ${children.length} closed`
}

/** The tickets a question holds up: those it blocks. */
const questionNote = (question: Ticket, edges: ReadonlyArray<Edge>): string =>
  Option.match(
    Array.match(
      edges.filter(edge => edge.kind === 'blocks' && edge.from === question.id),
      {
        onEmpty: () => Option.none(),
        onNonEmpty: blocked => Option.some(Array.map(blocked, edge => edge.to)),
      },
    ),
    {
      onNone: () =>
        Option.isSome(question.question) &&
        Option.isSome(question.question.value.answer)
          ? 'answered'
          : 'waits on you',
      onSome: held =>
        `${ticketList(held)} ${held.length === 1 ? 'waits' : 'wait'} on it`,
    },
  )

const deferNote = (
  ticket: Ticket,
  today: Option.Option<DateTime.Zoned>,
): string =>
  Option.match(ticket.deferUntil, {
    onNone: () => 'until undeferred',
    onSome: until =>
      `until ${Option.match(today, {
        onNone: () => DateTime.formatIso(until).slice(0, 16).replace('T', ' '),
        onSome: day => sayMoment(until, day),
      })}`,
  })

const closedNote = (ticket: Ticket): string =>
  Option.match(ticket.resolution, {
    onNone: () => 'closed',
    onSome: resolution => resolution.replaceAll('_', ' '),
  })

const rowOf = (ticket: Ticket, mark: Mark, note: string): BacklogRow => ({
  ticket: ticket.id,
  title: ticket.title,
  kind: `${ticket.type} · P${ticket.priority}`,
  mark,
  note,
})

/** A run's finished ticket: merged, or closed without a change. */
const finishedRow = (row: TicketRow): Option.Option<BacklogRow> =>
  row.phase._tag === 'merged' || row.phase._tag === 'no_change'
    ? Option.some({
        ticket: row.ticket,
        title: row.title,
        kind: `${row.type} · P${row.priority}`,
        mark: { role: 'c4', glyph: '✓', word: 'finished' },
        note: row.phase._tag === 'merged' ? 'merged' : 'no change',
      })
    : Option.none()

/** The rows of `section`. */
export const rowsOf = (
  section: TicketSection,
  { tickets, facts, runTickets, today }: RowInputs,
): ReadonlyArray<BacklogRow> => {
  const readiness = readinessOf(facts)
  const edges = Option.match(facts, {
    onNone: () => [],
    onSome: loaded => loaded.edges,
  })
  const mark = (ticket: Ticket) => markOf(ticket, readiness)
  const byId = new Map(tickets.map(ticket => [ticket.id, ticket]))
  const reasonsOf = (ticket: Ticket) =>
    Option.flatMap(readiness, ({ waiting }) =>
      Option.fromUndefinedOr(waiting.get(ticket.id)),
    )
  const waitNote = (ticket: Ticket): string =>
    Option.match(reasonsOf(ticket), {
      onNone: () => '',
      onSome: reasons => reasons.map(reason => reason.words).join('; '),
    })
  const closedIds = HashSet.fromIterable(
    tickets
      .filter(ticket => ticket.status === 'closed')
      .map(ticket => ticket.id),
  )
  /** What an open ticket's row says, by its kind and state. */
  const openNote = (ticket: Ticket): string =>
    ticket.type === 'epic'
      ? epicNote(ticket, edges, closedIds)
      : ticket.type === 'question'
        ? questionNote(ticket, edges)
        : ticket.status === 'deferred'
          ? deferNote(ticket, today)
          : waitNote(ticket)
  const sorted = Array.sort(tickets, byUrgency)
  switch (section) {
    case 'open':
      return sorted
        .filter(ticket => ticket.status !== 'closed')
        .map(ticket => rowOf(ticket, mark(ticket), openNote(ticket)))
    case 'epics':
      return sorted
        .filter(ticket => ticket.type === 'epic')
        .map(ticket =>
          rowOf(ticket, mark(ticket), epicNote(ticket, edges, closedIds)),
        )
    case 'ready':
      return Option.match(facts, {
        onNone: () => [],
        onSome: ({ ready }) =>
          Array.getSomes(
            ready.map(id =>
              Option.map(Option.fromUndefinedOr(byId.get(id)), ticket =>
                rowOf(ticket, mark(ticket), 'ready'),
              ),
            ),
          ),
      })
    case 'waiting':
      return sorted
        .filter(ticket => Option.isSome(reasonsOf(ticket)))
        .map(ticket => rowOf(ticket, mark(ticket), waitNote(ticket)))
    case 'questions':
      return sorted
        .filter(
          ticket => ticket.type === 'question' && ticket.status !== 'closed',
        )
        .map(ticket => rowOf(ticket, mark(ticket), questionNote(ticket, edges)))
    case 'deferred':
      return sorted
        .filter(ticket => ticket.status === 'deferred')
        .map(ticket => rowOf(ticket, mark(ticket), deferNote(ticket, today)))
    case 'finished':
      return Array.getSomes(runTickets.map(finishedRow))
    case 'closed':
      return Array.sort(
        tickets.filter(ticket => ticket.status === 'closed'),
        newestFirst,
      ).map(ticket => rowOf(ticket, mark(ticket), closedNote(ticket)))
  }
}

/** What the frame gives the screen. */
export interface ViewInputs {
  /** The scoped project; none with every project. */
  readonly project: Option.Option<EngineProject>
  /** Its tickets, none before the stream's first snapshot. */
  readonly tickets: Option.Option<ReadonlyArray<Ticket>>
  /** The scoped run's ticket rows, whose finished ones it lists; none without a run. */
  readonly runTickets: ReadonlyArray<TicketRow>
  readonly today: Option.Option<DateTime.Zoned>
}

const markClass: Record<Role, string> = {
  c1: 'text-c1',
  c2: 'text-c2',
  c3: 'text-c3',
  c4: 'text-c4',
  c5: 'text-c5',
}

const panel =
  'flex min-h-0 flex-col overflow-hidden rounded-card border border-line bg-panel'

const panelHeader = (title: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('border-b border-line'), h.Style({ padding: '8px 12px' })],
    [h.h2([h.Class('font-extrabold'), h.Style({ fontSize: '13px' })], [title])],
  )

const notice = (text: string, h: HtmlBuilder<Message>): Html =>
  h.p([h.Class('text-xs text-muted'), h.Style({ padding: '6px 12px' })], [text])

const markView = (mark: Mark, h: HtmlBuilder<Message>): Html =>
  h.span(
    [
      h.DataAttribute('mark', mark.role),
      h.Title(mark.word),
      h.Class(`font-mono ${markClass[mark.role]}`),
    ],
    [mark.glyph],
  )

const rowView = (
  row: BacklogRow,
  selected: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed('button')(
    row.ticket,
    [
      h.Type('button'),
      h.OnClick(Message.SelectedTicket({ ticket: row.ticket })),
      h.AriaPressed(selected ? 'true' : 'false'),
      h.AriaLabel(`${row.ticket} ${row.title}: ${row.mark.word}`),
      h.Title(row.note === '' ? row.title : `${row.title}: ${row.note}`),
      h.Class(
        `grid w-full items-center gap-8 text-left text-xs hover:bg-line/40 ${selected ? 'bg-line/60 font-bold' : ''}`,
      ),
      h.Style({
        gridTemplateColumns: '12px 72px minmax(0,1fr) minmax(0,40%)',
        padding: '5px 12px',
      }),
    ],
    [
      markView(row.mark, h),
      h.span([h.Class('font-mono text-muted')], [row.ticket]),
      h.span(
        [h.Class('overflow-hidden text-ellipsis whitespace-nowrap')],
        [row.title],
      ),
      h.span(
        [
          h.DataAttribute('note', ''),
          h.Class(
            'overflow-hidden text-right text-ellipsis whitespace-nowrap text-muted',
          ),
        ],
        [row.note],
      ),
    ],
  )

const sectionTabs = (
  model: Model,
  countOf: (section: Section) => number,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Role('group'), h.AriaLabel('Sections'), h.Class('flex flex-wrap gap-6')],
    Section.literals.map(section =>
      h.button(
        [
          h.Type('button'),
          h.AriaPressed(section === model.section ? 'true' : 'false'),
          h.OnClick(Message.ChoseSection({ section })),
          h.Class(
            `rounded-button border px-10 py-4 text-xs ${section === model.section ? 'border-c1 font-bold' : 'border-line text-muted'}`,
          ),
        ],
        [`${sectionTitle[section]} ${countOf(section)}`],
      ),
    ),
  )

const listView = (
  model: Model,
  rows: ReadonlyArray<BacklogRow>,
  waitingForFacts: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [h.AriaLabel(sectionTitle[model.section]), h.Class(panel)],
    [
      panelHeader(sectionTitle[model.section], h),
      rows.length === 0
        ? notice(waitingForFacts ? 'Asking the engine…' : 'No tickets here', h)
        : h.submodel({
            slotId: 'backlog-list',
            model: model.list,
            view: VirtualList.view<BacklogRow>(),
            viewInputs: {
              items: rows,
              itemToKey: row => row.ticket,
              itemToView: row =>
                rowView(row, Option.contains(model.selected, row.ticket), h),
              containerClassName: 'min-h-0 flex-1',
              containerAttributes: childAttributes([h.AriaLabel('Tickets')]),
            },
            toParentMessage: message => Message.GotListMessage({ message }),
          }),
    ],
  )

/** How much of a conflict's value is shown; the whole of it on hover. */
const conflictValueLength = 600

/** A conflict's value in words: text as it is, nothing as such, anything else as its JSON. */
export const sayConflictValue = (value: Schema.Json): string =>
  value === null || value === ''
    ? '(nothing)'
    : typeof value === 'string'
      ? value
      : JSON.stringify(value, null, 2)

const conflictValueView = (
  label: string,
  value: Schema.Json,
  h: HtmlBuilder<Message>,
): Html => {
  const said = sayConflictValue(value)
  return h.div(
    [h.DataAttribute('conflict-value', label), h.Class('flex gap-8 text-xs')],
    [
      h.span([h.Class('shrink-0 font-bold text-muted')], [label]),
      h.span(
        [h.Title(said), h.Class('min-w-0 break-words whitespace-pre-wrap')],
        [
          said.length > conflictValueLength
            ? `${said.slice(0, conflictValueLength)}…`
            : said,
        ],
      ),
    ],
  )
}

const conflictView = (
  conflict: TicketConflict,
  {
    project,
    title,
    using,
    failed,
  }: {
    readonly project: EngineProject
    readonly title: Option.Option<string>
    readonly using: Option.Option<number>
    readonly failed: Option.Option<string>
  },
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed('li')(
    String(conflict.seq),
    [
      h.AriaLabel(`${conflict.ticket} ${conflict.field}`),
      h.Class('flex flex-col gap-4 border-b border-line'),
      h.Style({ padding: '10px 12px' }),
    ],
    [
      h.div(
        [h.Class('flex items-center gap-8 text-xs')],
        [
          h.button(
            [
              h.Type('button'),
              h.OnClick(Message.SelectedTicket({ ticket: conflict.ticket })),
              h.Class('font-mono text-muted hover:underline'),
            ],
            [conflict.ticket],
          ),
          h.span(
            [h.Class('overflow-hidden text-ellipsis whitespace-nowrap')],
            [Option.getOrElse(title, () => '')],
          ),
          h.span([h.Class('ml-auto font-mono font-bold')], [conflict.field]),
        ],
      ),
      conflictValueView('Kept', conflict.kept, h),
      conflictValueView('Other', conflict.other, h),
      Option.match(conflict.useOther, {
        onNone: () => notice('The app can’t set this value', h),
        onSome: changes =>
          h.button(
            [
              h.Type('button'),
              h.Disabled(Option.isSome(using)),
              h.OnClick(
                Message.ClickedUseOtherValue({
                  project,
                  seq: conflict.seq,
                  ticket: conflict.ticket,
                  changes,
                }),
              ),
              h.Class(
                'self-start rounded-button border border-line px-10 py-4 text-xs',
              ),
            ],
            [
              Option.contains(using, conflict.seq)
                ? 'Using the other value…'
                : 'Use the other value',
            ],
          ),
      }),
      Option.match(failed, {
        onNone: () => h.empty,
        onSome: reason =>
          h.p(
            [h.Role('alert'), h.Class('text-xs text-c3')],
            [`The other value wasn't set: ${reason}`],
          ),
      }),
    ],
  )

const conflictsView = (
  model: Model,
  facts: Option.Option<Facts>,
  tickets: ReadonlyArray<Ticket>,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [h.AriaLabel(sectionTitle.conflicts), h.Class(panel)],
    [
      panelHeader(sectionTitle.conflicts, h),
      Option.match(facts, {
        onNone: () => notice('Asking the engine…', h),
        onSome: ({ project, conflicts }) =>
          conflicts.length === 0
            ? notice('No merge conflicts', h)
            : h.ul(
                [
                  h.AriaLabel('Conflicts'),
                  h.Class('min-h-0 flex-1 overflow-auto'),
                ],
                conflicts.map(conflict =>
                  conflictView(
                    conflict,
                    {
                      project,
                      title: Option.map(
                        Array.findFirst(
                          tickets,
                          ticket => ticket.id === conflict.ticket,
                        ),
                        ticket => ticket.title,
                      ),
                      using: model.using,
                      failed: Option.flatMap(
                        model.useFailed,
                        ({ seq, reason }) =>
                          seq === conflict.seq
                            ? Option.some(reason)
                            : Option.none(),
                      ),
                    },
                    h,
                  ),
                ),
              ),
      }),
    ],
  )

const graphView = (
  graph: Option.Option<Graph>,
  selected: Option.Option<TicketId>,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [h.AriaLabel('Graph'), h.Class(`${panel} flex-1`)],
    [
      panelHeader('Graph', h),
      Option.match(graph, {
        onNone: () => notice('Asking the engine for the links…', h),
        onSome: drawn =>
          drawn.nodes.length === 0
            ? notice('No open tickets to draw', h)
            : h.keyed('div')(graphKey(drawn), [
                h.OnMount(DrawGraph({ graph: drawn, selected })),
                h.Role('img'),
                h.AriaLabel(
                  `${drawn.nodes.length} tickets and ${drawn.edges.length} links`,
                ),
                h.DataAttribute('graph-nodes', String(drawn.nodes.length)),
                h.Class('min-h-0 flex-1'),
              ]),
      }),
    ],
  )

const field = (label: string, value: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex flex-col gap-4')],
    [
      h.h3([h.Class('text-xs font-bold text-muted')], [label]),
      h.p([h.Class('text-xs whitespace-pre-wrap')], [value]),
    ],
  )

/** How much of a description the detail shows. */
const descriptionLength = 600

const detailView = (
  ticket: Ticket,
  facts: Option.Option<Facts>,
  h: HtmlBuilder<Message>,
): Html => {
  const readiness = readinessOf(facts)
  const mark = markOf(ticket, readiness)
  const links = Option.match(facts, {
    onNone: () => [],
    onSome: loaded =>
      loaded.edges.filter(
        edge => edge.from === ticket.id || edge.to === ticket.id,
      ),
  })
  const reasons = Option.flatMap(readiness, ({ waiting }) =>
    Option.fromUndefinedOr(waiting.get(ticket.id)),
  )
  return h.div(
    [
      h.Class('flex flex-col gap-10 overflow-auto'),
      h.Style({ padding: '10px 12px' }),
    ],
    [
      h.div(
        [h.Class('flex items-center gap-8 text-xs')],
        [
          markView(mark, h),
          h.span([h.Class('font-mono')], [ticket.id]),
          h.span(
            [h.Class('text-muted')],
            [`${ticket.type} · P${ticket.priority}`],
          ),
          h.span([h.Class(`ml-auto ${markClass[mark.role]}`)], [mark.word]),
        ],
      ),
      h.p([h.Class('text-sm font-bold')], [ticket.title]),
      Option.match(ticket.description, {
        onNone: () => h.empty,
        onSome: description =>
          h.p(
            [h.Class('text-xs whitespace-pre-wrap text-muted')],
            [
              description.length > descriptionLength
                ? `${description.slice(0, descriptionLength)}…`
                : description,
            ],
          ),
      }),
      Option.match(reasons, {
        onNone: () => h.empty,
        onSome: said =>
          h.section(
            [h.AriaLabel('Why it isn’t ready'), h.Class('flex flex-col gap-4')],
            [
              h.h3(
                [h.Class('text-xs font-bold text-muted')],
                ['Why it isn’t ready'],
              ),
              h.ul(
                [h.Class('flex flex-col gap-2 text-xs')],
                said.map(reason => h.li([], [reason.words])),
              ),
            ],
          ),
      }),
      Option.match(ticket.question, {
        onNone: () => h.empty,
        onSome: question =>
          Option.match(question.answer, {
            onSome: answer => field('Answer', answer, h),
            onNone: () =>
              Option.match(question.choices, {
                onNone: () => h.empty,
                onSome: ({ options, recommended }) =>
                  h.section(
                    [h.AriaLabel('Options'), h.Class('flex flex-col gap-4')],
                    [
                      h.h3(
                        [h.Class('text-xs font-bold text-muted')],
                        ['Options'],
                      ),
                      Option.exists(facts, loaded =>
                        loaded.drafted.includes(ticket.id),
                      )
                        ? h.p(
                            [
                              h.DataAttribute('drafted', ''),
                              h.Class('text-xs text-c5'),
                            ],
                            ['Drafted by the answer talk, not by who asked.'],
                          )
                        : h.empty,
                      h.ol(
                        [h.Class('flex flex-col gap-2 text-xs')],
                        options.map((option, index) =>
                          h.li(
                            [],
                            [
                              `${option.label}${index === recommended ? ' (recommended)' : ''}: ${option.tradeOff}`,
                            ],
                          ),
                        ),
                      ),
                    ],
                  ),
              }),
          }),
      }),
      links.length === 0
        ? h.empty
        : h.section(
            [h.AriaLabel('Links'), h.Class('flex flex-col gap-4')],
            [
              h.h3([h.Class('text-xs font-bold text-muted')], ['Links']),
              h.ul(
                [h.Class('flex flex-col gap-2 font-mono text-xs')],
                links.map(edge => h.li([], [edgeWords(edge)])),
              ),
            ],
          ),
    ],
  )
}

const chosenView = (
  model: Model,
  tickets: ReadonlyArray<Ticket>,
  facts: Option.Option<Facts>,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [h.AriaLabel('Ticket'), h.Class(panel), h.Style({ maxHeight: '50%' })],
    [
      panelHeader('Ticket', h),
      Option.match(
        Option.flatMap(model.selected, id =>
          Array.findFirst(tickets, ticket => ticket.id === id),
        ),
        {
          onNone: () => notice('Choose a ticket in the list or the graph', h),
          onSome: ticket => detailView(ticket, facts, h),
        },
      ),
    ],
  )

const backlogView = (
  model: Model,
  inputs: ViewInputs,
  tickets: ReadonlyArray<Ticket>,
  h: HtmlBuilder<Message>,
): Html => {
  const facts = factsOf(model.facts, inputs.project)
  const rowInputs: RowInputs = {
    tickets,
    facts,
    runTickets: inputs.runTickets,
    today: inputs.today,
  }
  const rows =
    model.section === 'conflicts' ? [] : rowsOf(model.section, rowInputs)
  const countOf = (section: Section): number =>
    section === 'conflicts'
      ? Option.match(facts, {
          onNone: () => 0,
          onSome: ({ conflicts }) => conflicts.length,
        })
      : section === model.section
        ? rows.length
        : rowsOf(section, rowInputs).length
  const readiness = readinessOf(facts)
  const graph = Option.map(facts, ({ edges }) =>
    graphOf({
      tickets,
      edges,
      markOf: ticket => markOf(ticket, readiness),
    }),
  )
  return h.div(
    [h.Class('flex min-h-0 flex-1 flex-col gap-12')],
    [
      sectionTabs(model, countOf, h),
      AsyncData.isFailure(model.facts)
        ? h.p(
            [h.Role('alert'), h.Class('text-xs text-c3')],
            [
              `The engine couldn't say what is ready: ${Option.getOrElse(AsyncData.getError(model.facts), () => '')}`,
            ],
          )
        : h.empty,
      h.div(
        [
          h.Class('grid min-h-0 flex-1 gap-16'),
          h.Style({ gridTemplateColumns: 'minmax(0,1fr) 380px' }),
        ],
        [
          model.section === 'conflicts'
            ? conflictsView(model, facts, tickets, h)
            : listView(model, rows, Option.isNone(facts), h),
          h.div(
            [h.Class('flex min-h-0 flex-col gap-12')],
            [
              graphView(graph, model.selected, h),
              chosenView(model, tickets, facts, h),
            ],
          ),
        ],
      ),
    ],
  )
}

export const view = defineView<Model, Message, ViewInputs>((model, inputs, h) =>
  Option.match(inputs.project, {
    onNone: () =>
      notice('Choose a project in the sidebar to see its backlog.', h),
    onSome: () =>
      Option.match(inputs.tickets, {
        onNone: () => notice('Reading the backlog…', h),
        onSome: tickets => backlogView(model, inputs, tickets, h),
      }),
  }),
)
