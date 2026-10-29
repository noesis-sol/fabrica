import { Data, DateTime, Effect, Option, Schema } from 'effect'
import { Argument, Command, Flag } from 'effect/cli'

import {
  Edge,
  EdgeKind,
  LabelName,
  Line,
  ModelOverride,
  NoteId,
  Priority,
  Resolution,
  Text,
  Ticket,
  TicketDetail,
  TicketId,
  type TicketMetadata,
  TicketType,
  Why,
  edgeWords,
} from '@fabrica/contracts'

import { versionLine } from '../version'
import { printAnswer } from './output'
import { sanitise, sanitiseLine } from './sanitise'
import { ticketsImport } from './tickets-import'
import {
  type TicketsRefused,
  projectFlag,
  refused,
  withProject,
} from './tickets-project'

export { projectHolding, TicketsRefused } from './tickets-project'

// `fabrica tickets list|show|create|update|close|reopen|defer|dep|label|note|ready|why` (spec §19,
// §11): the backlog of a project, through the engine's Backlog group, every change the maintainer's.
// The project is `--project <id>`, or the one whose checkout holds the folder the command runs in.
// `create --files` gives the files a ticket will change, its footprint (§13.4). `why` says each reason
// in the engine's words. `rebuild` waits for the tickets ref (M4), and says so; `import --beads` is
// its own file's. Values the engine sends are printed one to a line.

/** `fabrica tickets rebuild`, which the tickets ref (M4) brings. */
export class RebuildWaits extends Data.TaggedError('RebuildWaits')<{}> {
  override get message() {
    return `\`fabrica tickets rebuild\` is not in ${versionLine} yet: it rebuilds the backlog from the tickets ref, which comes with sync (M4)`
  }
}

/** `value` decoded by `schema`, or refused as not `what`. */
const decoded = <A>(
  schema: Schema.Decoder<A>,
  value: unknown,
  what: string,
): Effect.Effect<A, TicketsRefused> =>
  Option.match(Schema.decodeUnknownOption(schema)(value), {
    onNone: () =>
      Effect.fail(
        refused(
          `${sanitiseLine(typeof value === 'string' ? value : JSON.stringify(value))} isn't ${what}`,
        ),
      ),
    onSome: Effect.succeed,
  })

const ticketIdOf = (text: string) =>
  Option.match(TicketId.makeOption(text), {
    onNone: () =>
      Effect.fail(refused(`${sanitiseLine(text)} isn't a ticket's ID`)),
    onSome: Effect.succeed,
  })

/** Each given value decoded, as a flag that may be given several times gives them. */
const decodedAll = <A>(
  schema: Schema.Decoder<A>,
  values: ReadonlyArray<string>,
  what: string,
) => Effect.forEach(values, value => decoded(schema, value, what))

/** An optional flag's value decoded. */
const decodedOption = <A>(
  schema: Schema.Decoder<A>,
  value: Option.Option<unknown>,
  what: string,
) =>
  Option.match(value, {
    onNone: () => Effect.succeed(Option.none<A>()),
    onSome: given => Effect.map(decoded(schema, given, what), Option.some),
  })

/** `--files`, given once for each file or with commas between them. */
const filesOf = (given: ReadonlyArray<string>): ReadonlyArray<string> =>
  given
    .flatMap(each => each.split(','))
    .map(file => file.trim())
    .filter(file => file !== '')

/** A ticket's metadata with its files set. */
const withFiles = (
  metadata: TicketMetadata,
  files: ReadonlyArray<string>,
): Effect.Effect<TicketMetadata, TicketsRefused> =>
  Effect.map(decodedAll(Text, files, 'a file'), each => ({
    ...metadata,
    files: Option.some(each),
  }))

const noMetadata: TicketMetadata = {
  files: Option.none(),
  spec: Option.none(),
  predicted_files: Option.none(),
  result_kind: Option.none(),
}

const ticketArgument = Argument.String('ticket').pipe(
  Argument.withDescription("The ticket's ID"),
)

const words: Record<Ticket['status'], string> = {
  open: 'open',
  in_progress: 'in progress',
  deferred: 'deferred',
  closed: 'closed',
}

/** The tickets as rows: ID, status, priority, type and title, in columns. */
const ticketRows = (tickets: ReadonlyArray<Ticket>, none: string): string => {
  if (tickets.length === 0) return none
  const rows = tickets.map(ticket => [
    sanitiseLine(ticket.id),
    words[ticket.status],
    `P${ticket.priority}`,
    ticket.type,
    sanitiseLine(ticket.title),
  ])
  const widths = [0, 1, 2, 3].map(column =>
    Math.max(...rows.map(row => row[column]?.length ?? 0)),
  )
  return rows
    .map(row =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n')
}

/** A text field, indented under its name. */
const block = (name: string, text: Option.Option<string>) =>
  Option.match(text, {
    onNone: () => [],
    onSome: value => [
      `${name}:`,
      ...sanitise(value)
        .split('\n')
        .map(line => `  ${line}`.trimEnd()),
    ],
  })

const detailText = ({ ticket, labels, edges, notes }: TicketDetail): string =>
  [
    `${sanitiseLine(ticket.id)}  ${sanitiseLine(ticket.title)}`,
    `type      ${ticket.type}`,
    `status    ${words[ticket.status]}${Option.match(ticket.resolution, {
      onNone: () => '',
      onSome: resolution => ` (${resolution})`,
    })}${Option.match(ticket.deferUntil, {
      onNone: () => '',
      onSome: until => ` until ${DateTime.formatIso(until)}`,
    })}`,
    `priority  ${ticket.priority}`,
    ...(labels.length === 0
      ? []
      : [`labels    ${labels.map(sanitiseLine).join(', ')}`]),
    ...Option.match(ticket.metadata.files, {
      onNone: () => [],
      onSome: files => [`files     ${files.map(sanitiseLine).join(', ')}`],
    }),
    ...Option.match(ticket.model, {
      onNone: () => [],
      onSome: model => [`model     ${sanitiseLine(model)}`],
    }),
    ...edges.map(edge => `link      ${sanitiseLine(edgeWords(edge))}`),
    ...block('description', ticket.description),
    ...block('design', ticket.design),
    ...block('acceptance', ticket.acceptance),
    ...Option.match(ticket.closeReason, {
      onNone: () => [],
      onSome: reason => [`closed    ${sanitiseLine(reason)}`],
    }),
    ...(notes.length === 0
      ? []
      : [
          'notes:',
          ...notes.map(
            note =>
              `  ${DateTime.formatIso(note.at)} ${note.author._tag}: ${sanitiseLine(note.body)}`,
          ),
        ]),
  ].join('\n')

const list = Command.make(
  'list',
  {
    project: projectFlag,
    status: Flag.Literals('status', [
      'open',
      'in_progress',
      'deferred',
      'closed',
    ]).pipe(
      Flag.withDescription(
        'Only tickets with this status; given again for more',
      ),
      Flag.atLeast(0),
    ),
    type: Flag.Literals('type', TicketType.literals).pipe(
      Flag.withDescription('Only tickets of this type; given again for more'),
      Flag.atLeast(0),
    ),
    label: Flag.String('label').pipe(
      Flag.withDescription(
        'Only tickets with this label; given again, with every one',
      ),
      Flag.atLeast(0),
    ),
    parent: Flag.String('parent').pipe(
      Flag.withDescription('Only the children of this ticket'),
      Flag.optional,
    ),
  },
  options =>
    withProject(options.project, (client, project) =>
      Effect.gen(function* () {
        const labels = yield* decodedAll(LabelName, options.label, 'a label')
        const parent = yield* Option.match(options.parent, {
          onNone: () => Effect.succeed(Option.none<TicketId>()),
          onSome: text => Effect.map(ticketIdOf(text), Option.some),
        })
        const [firstStatus, ...statuses] = options.status
        const [firstType, ...types] = options.type
        const [firstLabel, ...moreLabels] = labels
        return yield* client.rpc['tickets.list']({
          project,
          filter: {
            status:
              firstStatus === undefined
                ? Option.none()
                : Option.some([firstStatus, ...statuses]),
            type:
              firstType === undefined
                ? Option.none()
                : Option.some([firstType, ...types]),
            labels:
              firstLabel === undefined
                ? Option.none()
                : Option.some([firstLabel, ...moreLabels]),
            parent,
          },
        })
      }),
    ).pipe(
      Effect.flatMap(value =>
        printAnswer({
          schema: Schema.Array(Ticket),
          value,
          text: tickets => ticketRows(tickets, 'no tickets'),
        }),
      ),
    ),
).pipe(Command.withDescription('The tickets'))

const show = Command.make(
  'show',
  { project: projectFlag, ticket: ticketArgument },
  options =>
    withProject(options.project, (client, project) =>
      Effect.flatMap(ticketIdOf(options.ticket), ticket =>
        client.rpc['tickets.show']({ project, ticket }),
      ),
    ).pipe(
      Effect.flatMap(value =>
        printAnswer({ schema: TicketDetail, value, text: detailText }),
      ),
    ),
).pipe(Command.withDescription('A ticket'))

const textFlag = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.optional)

const priorityFlag = Flag.Int('priority').pipe(
  Flag.withDescription('0, the most urgent, to 4; 2 where it isn’t given'),
  Flag.optional,
)

const modelFlag = textFlag('model', 'The provider/model to work it with')

const filesFlag = Flag.String('files').pipe(
  Flag.withDescription(
    'The files it will change, its footprint: given again for more, or with commas between them',
  ),
  Flag.atLeast(0),
)

/** `fabrica tickets create`'s and `update`'s answer: the ticket's ID. */
const IdAnswer = Schema.Struct({ id: TicketId })

const create = Command.make(
  'create',
  {
    project: projectFlag,
    title: Argument.String('title').pipe(
      Argument.withDescription("The ticket's title"),
    ),
    type: Flag.Literals('type', TicketType.literals).pipe(
      Flag.withDescription('Its type'),
      Flag.withDefault('task' as const),
    ),
    description: textFlag('description', 'What it is for'),
    design: textFlag('design', 'How it is to be done'),
    acceptance: textFlag('acceptance', 'When it is done'),
    priority: priorityFlag,
    label: Flag.String('label').pipe(
      Flag.withDescription('A label; given again for more'),
      Flag.atLeast(0),
    ),
    parent: textFlag('parent', 'Its parent: it is filed as the next child'),
    files: filesFlag,
    model: modelFlag,
  },
  options =>
    withProject(options.project, (client, project) =>
      Effect.gen(function* () {
        const title = yield* decoded(
          Line,
          options.title,
          'a title: one line, not blank',
        )
        const priority = yield* decodedOption(
          Priority,
          options.priority,
          'a priority from 0 to 4',
        )
        const labels = yield* decodedAll(LabelName, options.label, 'a label')
        const parent = yield* Option.match(options.parent, {
          onNone: () => Effect.succeed(Option.none<TicketId>()),
          onSome: text => Effect.map(ticketIdOf(text), Option.some),
        })
        const model = yield* decodedOption(
          ModelOverride,
          options.model,
          'a provider/model',
        )
        const files = filesOf(options.files)
        const metadata =
          files.length === 0
            ? Option.none()
            : Option.some(yield* withFiles(noMetadata, files))
        return yield* client.rpc['tickets.create']({
          project,
          ticket: {
            type: options.type,
            title,
            description: options.description,
            design: options.design,
            acceptance: options.acceptance,
            priority,
            labels: labels.length === 0 ? Option.none() : Option.some(labels),
            parent,
            metadata,
            model,
          },
        })
      }),
    ).pipe(
      Effect.flatMap(value =>
        printAnswer({
          schema: IdAnswer,
          value,
          text: ({ id }) => `created ${sanitiseLine(id)}`,
        }),
      ),
    ),
).pipe(Command.withDescription('Creates a ticket'))

/** The fields `update --clear` empties. */
const clearable = ['description', 'design', 'acceptance', 'model'] as const

const update = Command.make(
  'update',
  {
    project: projectFlag,
    ticket: ticketArgument,
    title: textFlag('title', 'Its title'),
    description: textFlag('description', 'What it is for'),
    design: textFlag('design', 'How it is to be done'),
    acceptance: textFlag('acceptance', 'When it is done'),
    priority: priorityFlag,
    model: modelFlag,
    files: filesFlag,
    clear: Flag.Literals('clear', clearable).pipe(
      Flag.withDescription('Empties the field; given again for more'),
      Flag.atLeast(0),
    ),
  },
  options =>
    withProject(options.project, (client, project) =>
      Effect.gen(function* () {
        const ticket = yield* ticketIdOf(options.ticket)
        const title = yield* decodedOption(
          Line,
          options.title,
          'a title: one line, not blank',
        )
        const priority = yield* decodedOption(
          Priority,
          options.priority,
          'a priority from 0 to 4',
        )
        const model = yield* decodedOption(
          ModelOverride,
          options.model,
          'a provider/model',
        )
        const files = filesOf(options.files)
        const cleared = new Set(options.clear)
        /** A field set where it is given, emptied where `--clear` names it, left out otherwise. */
        const change = <A>(
          name: (typeof clearable)[number],
          value: Option.Option<A>,
        ) =>
          Option.isSome(value)
            ? { [name]: value }
            : cleared.has(name)
              ? { [name]: Option.none<A>() }
              : {}
        const metadata =
          files.length === 0
            ? {}
            : {
                metadata: yield* withFiles(
                  (yield* client.rpc['tickets.show']({ project, ticket }))
                    .ticket.metadata,
                  files,
                ),
              }
        const changes = {
          ...Option.match(title, {
            onNone: () => ({}),
            onSome: value => ({ title: value }),
          }),
          ...change('description', options.description),
          ...change('design', options.design),
          ...change('acceptance', options.acceptance),
          ...Option.match(priority, {
            onNone: () => ({}),
            onSome: value => ({ priority: value }),
          }),
          ...change('model', model),
          ...metadata,
        }
        if (Object.keys(changes).length === 0)
          return yield* refused(
            'nothing to change: give a field to set or --clear',
          )
        yield* client.rpc['tickets.update']({ project, ticket, changes })
        return { id: ticket }
      }),
    ).pipe(
      Effect.flatMap(value =>
        printAnswer({
          schema: IdAnswer,
          value,
          text: ({ id }) => `updated ${sanitiseLine(id)}`,
        }),
      ),
    ),
).pipe(Command.withDescription('Updates a ticket'))

const close = Command.make(
  'close',
  {
    project: projectFlag,
    ticket: ticketArgument,
    resolution: Flag.Literals('resolution', Resolution.literals).pipe(
      Flag.withDescription('How it ended'),
      Flag.withDefault('done' as const),
    ),
    reason: textFlag('reason', 'Why it closes'),
  },
  options =>
    withProject(options.project, (client, project) =>
      Effect.gen(function* () {
        const ticket = yield* ticketIdOf(options.ticket)
        const reason = yield* decodedOption(Text, options.reason, 'a reason')
        yield* client.rpc['tickets.close']({
          project,
          ticket,
          resolution: options.resolution,
          reason,
        })
        return { id: ticket }
      }),
    ).pipe(
      Effect.flatMap(value =>
        printAnswer({
          schema: IdAnswer,
          value,
          text: ({ id }) => `closed ${sanitiseLine(id)}`,
        }),
      ),
    ),
).pipe(Command.withDescription('Closes a ticket'))

const reopen = Command.make(
  'reopen',
  { project: projectFlag, ticket: ticketArgument },
  options =>
    withProject(options.project, (client, project) =>
      Effect.gen(function* () {
        const ticket = yield* ticketIdOf(options.ticket)
        yield* client.rpc['tickets.update']({
          project,
          ticket,
          changes: { status: 'open' },
        })
        return { id: ticket }
      }),
    ).pipe(
      Effect.flatMap(value =>
        printAnswer({
          schema: IdAnswer,
          value,
          text: ({ id }) => `reopened ${sanitiseLine(id)}`,
        }),
      ),
    ),
).pipe(
  Command.withDescription(
    'Reopens a closed ticket, or undefers a deferred one',
  ),
)

/** `fabrica tickets defer`'s answer. */
const DeferredAnswer = Schema.Struct({
  id: TicketId,
  until: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
})

const defer = Command.make(
  'defer',
  {
    project: projectFlag,
    ticket: ticketArgument,
    until: textFlag(
      'until',
      'When it is due again, an ISO 8601 time; until reopened where it isn’t given',
    ),
  },
  options =>
    withProject(options.project, (client, project) =>
      Effect.gen(function* () {
        const ticket = yield* ticketIdOf(options.ticket)
        const until = yield* Option.match(options.until, {
          onNone: () => Effect.succeed(Option.none<DateTime.Utc>()),
          onSome: text =>
            Option.match(DateTime.make(text), {
              onNone: () =>
                Effect.fail(
                  refused(`${sanitiseLine(text)} isn't an ISO 8601 time`),
                ),
              onSome: at => Effect.succeed(Option.some(DateTime.toUtc(at))),
            }),
        })
        yield* client.rpc['tickets.update']({
          project,
          ticket,
          changes: { status: 'deferred', deferUntil: until },
        })
        return { id: ticket, until }
      }),
    ).pipe(
      Effect.flatMap(value =>
        printAnswer({
          schema: DeferredAnswer,
          value,
          text: ({ id, until }) =>
            `deferred ${sanitiseLine(id)}${Option.match(until, {
              onNone: () => '',
              onSome: at => ` until ${DateTime.formatIso(at)}`,
            })}`,
        }),
      ),
    ),
).pipe(Command.withDescription('Defers a ticket'))

/** `fabrica tickets dep add|remove`'s answer: the link. */
const EdgeAnswer = Schema.Struct({ edge: Edge })

const depCommand = (name: 'add' | 'remove') =>
  Command.make(
    name,
    {
      project: projectFlag,
      from: Argument.String('from').pipe(
        Argument.withDescription('The ticket the link is from'),
      ),
      to: Argument.String('to').pipe(
        Argument.withDescription('The ticket the link is to'),
      ),
      kind: Flag.Literals('kind', EdgeKind.literals).pipe(
        Flag.withDescription(
          'blocks: <from> blocks <to>; parent: <from> is the parent of <to>; discovered_from: <from> was discovered from <to>; related',
        ),
        Flag.withDefault('blocks' as const),
      ),
    },
    options =>
      withProject(options.project, (client, project) =>
        Effect.gen(function* () {
          const from = yield* ticketIdOf(options.from)
          const to = yield* ticketIdOf(options.to)
          const edge = yield* decoded(
            Edge,
            { from, to, kind: options.kind },
            'a link: a ticket is never linked to itself',
          )
          yield* name === 'add'
            ? client.rpc['tickets.dep.add']({ project, edge })
            : client.rpc['tickets.dep.remove']({ project, edge })
          return { edge }
        }),
      ).pipe(
        Effect.flatMap(value =>
          printAnswer({
            schema: EdgeAnswer,
            value,
            text: ({ edge }) =>
              `${name === 'add' ? 'linked' : 'unlinked'}: ${edgeWords(edge)}`,
          }),
        ),
      ),
  ).pipe(
    Command.withDescription(
      name === 'add' ? 'Links two tickets' : 'Unlinks two tickets',
    ),
  )

const dep = Command.make('dep').pipe(
  Command.withDescription("A ticket's links"),
  Command.withSubcommands([depCommand('add'), depCommand('remove')]),
)

/** `fabrica tickets label`'s answer. */
const LabelAnswer = Schema.Struct({
  id: TicketId,
  add: Schema.Array(LabelName),
  remove: Schema.Array(LabelName),
})

const label = Command.make(
  'label',
  {
    project: projectFlag,
    ticket: ticketArgument,
    add: Flag.String('add').pipe(
      Flag.withDescription('A label to add; given again for more'),
      Flag.atLeast(0),
    ),
    remove: Flag.String('remove').pipe(
      Flag.withDescription('A label to remove; given again for more'),
      Flag.atLeast(0),
    ),
  },
  options =>
    withProject(options.project, (client, project) =>
      Effect.gen(function* () {
        const ticket = yield* ticketIdOf(options.ticket)
        const add = yield* decodedAll(LabelName, options.add, 'a label')
        const remove = yield* decodedAll(LabelName, options.remove, 'a label')
        if (add.length === 0 && remove.length === 0)
          return yield* refused('no labels to change: give --add or --remove')
        yield* client.rpc['tickets.label']({ project, ticket, add, remove })
        return { id: ticket, add, remove }
      }),
    ).pipe(
      Effect.flatMap(value =>
        printAnswer({
          schema: LabelAnswer,
          value,
          text: ({ id, add, remove }) =>
            `labels of ${sanitiseLine(id)}: ${[
              ...add.map(each => `+${sanitiseLine(each)}`),
              ...remove.map(each => `-${sanitiseLine(each)}`),
            ].join(' ')}`,
        }),
      ),
    ),
).pipe(Command.withDescription("A ticket's labels"))

/** `fabrica tickets note`'s answer. */
const NoteAnswer = Schema.Struct({ id: TicketId, note: NoteId })

const note = Command.make(
  'note',
  {
    project: projectFlag,
    ticket: ticketArgument,
    body: Argument.String('text').pipe(Argument.withDescription('The note')),
  },
  options =>
    withProject(options.project, (client, project) =>
      Effect.gen(function* () {
        const ticket = yield* ticketIdOf(options.ticket)
        const body = yield* decoded(Text, options.body, 'a note: it is blank')
        const { id } = yield* client.rpc['tickets.note']({
          project,
          ticket,
          body,
        })
        return { id: ticket, note: id }
      }),
    ).pipe(
      Effect.flatMap(value =>
        printAnswer({
          schema: NoteAnswer,
          value,
          text: ({ id, note }) =>
            `noted ${sanitiseLine(id)}: ${sanitiseLine(note)}`,
        }),
      ),
    ),
).pipe(Command.withDescription('Adds a note to a ticket'))

const ready = Command.make('ready', { project: projectFlag }, options =>
  withProject(options.project, (client, project) =>
    client.rpc['tickets.ready']({ project }),
  ).pipe(
    Effect.flatMap(value =>
      printAnswer({
        schema: Schema.Array(Ticket),
        value,
        text: tickets => ticketRows(tickets, 'no tickets are ready'),
      }),
    ),
  ),
).pipe(Command.withDescription('The tickets ready to start'))

const why = Command.make(
  'why',
  { project: projectFlag, ticket: ticketArgument },
  options =>
    withProject(options.project, (client, project) =>
      Effect.flatMap(ticketIdOf(options.ticket), ticket =>
        Effect.map(client.rpc['tickets.why']({ project, ticket }), answer => ({
          ticket,
          answer,
        })),
      ),
    ).pipe(
      Effect.flatMap(({ ticket, answer }) =>
        printAnswer({
          schema: Why,
          value: answer,
          text: Why.match({
            ready: () => `${sanitiseLine(ticket)} is ready`,
            not_ready: ({ reasons }) =>
              [
                `${sanitiseLine(ticket)} isn't ready:`,
                ...reasons.map(({ words }) => `- ${sanitiseLine(words)}`),
              ].join('\n'),
          }),
        }),
      ),
    ),
).pipe(Command.withDescription("Why a ticket isn't ready"))

const rebuild = Command.make('rebuild', {}, () =>
  Effect.fail(new RebuildWaits()),
).pipe(Command.withDescription('Rebuilds the backlog from its ref'))

export const tickets = Command.make('tickets').pipe(
  Command.withDescription('The backlog'),
  Command.withSubcommands([
    list,
    show,
    create,
    update,
    close,
    reopen,
    defer,
    dep,
    label,
    note,
    ready,
    why,
    rebuild,
    ticketsImport,
  ]),
)
