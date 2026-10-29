import { Data, Effect, Option, Result, Schema, SchemaIssue } from 'effect'

import {
  Actor,
  Edge,
  type EdgeKind,
  Imported,
  ImportedChange,
  LabelName,
  Note,
  NoteId,
  Question,
  QuestionChoices,
  Ticket,
  TicketId,
  TicketMetadata,
  type TicketStatus,
  TicketType,
  edgeWords,
} from '@fabrica/contracts'

import type { InvalidTicket, StoreFailed } from './errors'
import {
  DroppedEdge,
  type ImportedTicket,
  type WorkGraphShape,
} from './service'

// The Beads import (spec §11.6): a `bd export` JSONL file, one record a line, mapped onto the work
// graph's tickets as the Beads spike found the records (fab-mgi.2.9, bd 1.3.1), and brought in through
// `WorkGraph.importTickets`. IDs keep their prefix. A record's empty fields are left out, so every
// field but the ID, title, priority and times has a default. Lines of another `_type` (memories) are
// skipped. A file with any record the work graph can't hold is refused whole, with every problem;
// what the work graph has no place for (a link of a kind it lacks, a link to another project's ticket)
// is left out and said. The file is read in batches that yield.

/** The Beads file was refused: every problem with it, by line. */
export class BeadsRefused extends Data.TaggedError('BeadsRefused')<{
  readonly problems: readonly [string, ...Array<string>]
}> {
  override get message() {
    return `the Beads file was refused: ${this.problems.join('; ')}`
  }
}

/** What a Beads file holds, mapped: its tickets, the edges between them, and what was left out, in words. */
export interface BeadsBacklog {
  readonly tickets: ReadonlyArray<ImportedTicket>
  readonly edges: ReadonlyArray<Edge>
  readonly dropped: ReadonlyArray<string>
}

/** How many lines a batch reads before it yields. */
const readBatchSize = 500

const BeadsDependency = Schema.Struct({
  depends_on_id: Schema.String,
  type: Schema.String,
})

const BeadsComment = Schema.Struct({
  /** A UUID; pre-1.0 exports had an integer. */
  id: Schema.Union([Schema.String, Schema.Number]),
  text: Schema.String,
  created_at: Schema.DateTimeUtcFromString,
})

const optionalText = Schema.optionalKey(Schema.String)

/** An `issue` record of `bd export`, the fields the import reads. */
const BeadsIssue = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: optionalText,
  design: optionalText,
  acceptance_criteria: optionalText,
  notes: optionalText,
  status: optionalText,
  priority: Schema.Number,
  issue_type: optionalText,
  labels: Schema.optionalKey(Schema.Array(Schema.String)),
  dependencies: Schema.optionalKey(Schema.Array(BeadsDependency)),
  comments: Schema.optionalKey(Schema.Array(BeadsComment)),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  created_at: Schema.DateTimeUtcFromString,
  updated_at: Schema.DateTimeUtcFromString,
  defer_until: Schema.optionalKey(Schema.DateTimeUtcFromString),
  close_reason: optionalText,
  spec_id: optionalText,
  external_ref: optionalText,
})
type BeadsIssue = typeof BeadsIssue.Type

/** Beads' statuses as the work graph has them: blocking comes from edges, a hook is work under way. */
const statuses: Readonly<Record<string, TicketStatus>> = {
  open: 'open',
  in_progress: 'in_progress',
  deferred: 'deferred',
  closed: 'closed',
  blocked: 'open',
  pinned: 'open',
  hooked: 'in_progress',
}

/** Beads' link kinds as edges: `blocks` and `parent-child` point from the one depended on. */
const linkKinds: Readonly<
  Record<string, { readonly kind: EdgeKind; readonly fromDependent: boolean }>
> = {
  blocks: { kind: 'blocks', fromDependent: false },
  'parent-child': { kind: 'parent', fromDependent: false },
  'discovered-from': { kind: 'discovered_from', fromDependent: true },
  related: { kind: 'related', fromDependent: true },
  'relates-to': { kind: 'related', fromDependent: true },
}

/** The metadata keys a question's options sit in (orchestra-tnei.1), which become its question. */
const questionKeys = ['options', 'recommended', 'maintainer_only']

/** The label Beads marks a ticket for the maintainer with (`bd human`). */
const humanLabel = 'human'

/** How `bd human respond` writes the answer, as a comment. */
const responsePrefix = 'Response: '

const formatIssue = SchemaIssue.makeFormatterDefault()

const QuestionOptions = Schema.Struct({
  options: Schema.Array(
    Schema.Struct({ label: Schema.String, description: Schema.String }),
  ),
  recommended: Schema.Number,
  maintainer_only: Schema.optionalKey(Schema.Boolean),
})

/** What a ticket's question decoding came to: a question, none asked, or options that don't make one. */
type Asked = Data.TaggedEnum<{
  Asked: { readonly question: Question }
  NotAsked: {}
  Unasked: { readonly reason: string }
}>
const Asked = Data.taggedEnum<Asked>()

/** The question a human ticket with options asks, its answer from how Beads closed it. */
const askedOf = (
  issue: BeadsIssue,
  labels: ReadonlyArray<string>,
): Effect.Effect<Asked> => {
  const metadata = issue.metadata ?? {}
  if (!labels.includes(humanLabel) || !Object.hasOwn(metadata, 'options')) {
    return Effect.succeed(Asked.NotAsked())
  }
  return Effect.gen(function* () {
    const { options, recommended, maintainer_only } =
      yield* decodeQuestionOptions(metadata)
    const choices = yield* decodeChoices({
      options: options.map(({ label, description }) => ({
        label,
        tradeOff: description,
      })),
      recommended,
    })
    return Question.make({
      choices: Option.some(choices),
      consequential: false,
      maintainerOnly: maintainer_only ?? false,
      answer: answerOf(issue),
    })
  }).pipe(
    Effect.match({
      onFailure: error => Asked.Unasked({ reason: error.message }),
      onSuccess: question => Asked.Asked({ question }),
    }),
  )
}

const decodeQuestionOptions = Schema.decodeUnknownEffect(QuestionOptions)
const decodeChoices = Schema.decodeUnknownEffect(QuestionChoices)

/** A closed question's answer: `bd human respond`'s last response, or the reason another close gave. */
const answerOf = (issue: BeadsIssue): Option.Option<string> => {
  if (issue.status !== 'closed') return Option.none()
  if (issue.close_reason === 'Responded') {
    const response = (issue.comments ?? [])
      .filter(({ text }) => text.startsWith(responsePrefix))
      .at(-1)
    return blankless(response?.text.slice(responsePrefix.length))
  }
  return issue.close_reason === 'Dismissed'
    ? Option.none()
    : blankless(issue.close_reason)
}

/** The text, unless it is left out or blank. */
const blankless = (text: string | undefined): Option.Option<string> =>
  text === undefined || text.trim() === '' ? Option.none() : Option.some(text)

/** How a closed Beads ticket ended: a dismissed question cancelled, an answered one answered. */
const resolutionOf = (issue: BeadsIssue, question: boolean) =>
  question && issue.close_reason === 'Dismissed'
    ? 'cancelled'
    : question
      ? 'answered'
      : 'done'

/** A record's ticket and its links, and what it left out. */
interface Mapped {
  readonly imported: ImportedTicket
  readonly edges: ReadonlyArray<Edge>
  readonly dropped: ReadonlyArray<string>
}

/** The record as a ticket, or the problem that keeps it out. */
const mapIssue = Effect.fnUntraced(function* (
  issue: BeadsIssue,
): Effect.fn.Return<Mapped, string> {
  const ticketId = yield* Option.match(TicketId.makeOption(issue.id), {
    onNone: () =>
      Effect.fail(
        "its ID isn't a ticket ID: a prefix of lower-case letters and digits, `-`, then its own part",
      ),
    onSome: Effect.succeed,
  })
  const dropped: Array<string> = []

  const rawLabels = issue.labels ?? []
  const asked = yield* askedOf(issue, rawLabels)
  const question = Asked.$match(asked, {
    Asked: ({ question }) => Option.some(question),
    NotAsked: () => Option.none<Question>(),
    Unasked: () => Option.none<Question>(),
  })
  const beadsType = issue.issue_type ?? 'task'
  const shared = sharedType(beadsType)
  const type: TicketType = Option.isSome(question)
    ? 'question'
    : Option.getOrElse(shared, () => 'task' as const)
  if (Asked.$is('Unasked')(asked)) {
    dropped.push(
      `${ticketId}: labelled ${humanLabel}, but its options don't make a question (${asked.reason}); kept as a ${type}`,
    )
  }

  const labels: Array<LabelName> = []
  const typeLabel = Option.isSome(shared) ? [] : [beadsType]
  for (const label of [...rawLabels, ...typeLabel]) {
    Option.match(LabelName.makeOption(label), {
      onNone: () =>
        dropped.push(
          `${ticketId}'s label ${JSON.stringify(label)}: a label is one word`,
        ),
      onSome: name => {
        if (!labels.includes(name)) labels.push(name)
      },
    })
  }

  const beadsStatus = issue.status ?? 'open'
  const known = Option.fromUndefinedOr(
    Object.hasOwn(statuses, beadsStatus) ? statuses[beadsStatus] : undefined,
  )
  const mapped = Option.getOrElse(known, () => 'open' as const)
  const deferUntil =
    mapped === 'open' || mapped === 'deferred'
      ? Option.fromUndefinedOr(issue.defer_until)
      : Option.none()
  const status: TicketStatus =
    mapped === 'open' && Option.isSome(deferUntil) ? 'deferred' : mapped

  const entries: Array<readonly [string, unknown]> = []
  for (const [key, value] of Object.entries(issue.metadata ?? {})) {
    if (Option.isSome(question) && questionKeys.includes(key)) continue
    const kept = metadataEntry(key, value)
    entries.push(kept)
    if (kept[0] !== key) {
      dropped.push(
        `${ticketId}'s metadata ${key}: not what the engine reads there; kept as ${kept[0]}`,
      )
    }
  }
  const metadata = yield* decodeMetadata({
    ...Object.fromEntries(entries),
    ...(issue.spec_id === undefined ? {} : { spec_id: issue.spec_id }),
    ...(issue.external_ref === undefined
      ? {}
      : { external_ref: issue.external_ref }),
    ...(Option.isSome(known) ? {} : { beads_status: beadsStatus }),
  }).pipe(
    Effect.mapError(error => `its metadata doesn't decode: ${error.message}`),
  )

  const ticket = yield* Ticket.makeEffect({
    id: ticketId,
    type,
    title: issue.title,
    description: blankless(issue.description),
    design: blankless(issue.design),
    acceptance: blankless(issue.acceptance_criteria),
    status,
    resolution:
      status === 'closed'
        ? Option.some(resolutionOf(issue, Option.isSome(question)))
        : Option.none(),
    priority: issue.priority,
    deferUntil,
    assignee: Option.none(),
    model: Option.none(),
    metadata,
    result: Option.none(),
    question,
    mergedCommit: Option.none(),
    closeReason:
      status === 'closed' ? blankless(issue.close_reason) : Option.none(),
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
  }).pipe(Effect.mapError(formatIssue))

  const notes: Array<Note> = []
  for (const comment of issue.comments ?? []) {
    if (comment.text.trim() === '') continue
    const noteId = yield* Option.match(
      NoteId.makeOption(
        typeof comment.id === 'number'
          ? `${ticketId}.comment-${comment.id}`
          : comment.id,
      ),
      {
        onNone: () =>
          Effect.fail(
            `its comment ${JSON.stringify(comment.id)} has no usable ID`,
          ),
        onSome: Effect.succeed,
      },
    )
    notes.push(
      Note.make({
        id: noteId,
        ticketId,
        author: maintainer,
        body: comment.text,
        at: comment.created_at,
      }),
    )
  }
  for (const body of Option.toArray(blankless(issue.notes))) {
    notes.push(
      Note.make({
        id: NoteId.make(`${ticketId}.notes`),
        ticketId,
        author: maintainer,
        body,
        at: issue.updated_at,
      }),
    )
  }

  const edges: Array<Edge> = []
  for (const dependency of issue.dependencies ?? []) {
    const link = `${ticketId}'s ${dependency.type} link to ${dependency.depends_on_id}`
    const linkKind = Object.hasOwn(linkKinds, dependency.type)
      ? linkKinds[dependency.type]
      : undefined
    if (linkKind === undefined) {
      dropped.push(`${link}: the work graph has no such link`)
      continue
    }
    const other = TicketId.makeOption(dependency.depends_on_id)
    if (Option.isNone(other)) {
      dropped.push(`${link}: ${dependency.depends_on_id} isn't a ticket ID`)
      continue
    }
    const edge = Edge.makeOption(
      linkKind.fromDependent
        ? { from: ticketId, to: other.value, kind: linkKind.kind }
        : { from: other.value, to: ticketId, kind: linkKind.kind },
    )
    if (Option.isSome(edge)) edges.push(edge.value)
    else dropped.push(`${link}: a ticket is never linked to itself`)
  }

  return { imported: { ticket, labels, notes }, edges, dropped }
})

const decodeMetadata = Schema.decodeUnknownEffect(TicketMetadata)

const metadataDecodes = (key: string, value: unknown): boolean =>
  Option.isSome(Schema.decodeUnknownOption(TicketMetadata)({ [key]: value }))

/**
 * A Beads metadata key and its value as the engine keeps them. A key the engine reads whose value
 * it can't read there is taken from JSON text where it is that (tutti writes `predicted_files` as a
 * JSON list in a string), and otherwise kept as it is under `beads_<key>`.
 */
const metadataEntry = (
  key: string,
  value: unknown,
): readonly [string, unknown] => {
  if (metadataDecodes(key, value)) return [key, value]
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (metadataDecodes(key, parsed)) return [key, parsed]
    } catch {
      // Not JSON: kept as it is, below.
    }
  }
  return [`beads_${key}`, value]
}

/** Every import is the maintainer's: Beads' authors are names, which an actor doesn't carry. */
const maintainer = Actor.cases.maintainer.make({})

/** The type Beads and the work graph share, if they do; a Beads ticket of another becomes a task labelled with its type. */
const sharedType = (type: string): Option.Option<TicketType> =>
  Option.filter(
    Schema.decodeUnknownOption(TicketType)(type),
    each => each !== 'question' && each !== 'manual',
  )

/** A line's record, or the problem with it; none for a line the import skips (blank, or not an issue). */
const readLine = (
  line: string,
): Effect.Effect<Option.Option<BeadsIssue>, string> => {
  if (line.trim() === '') return Effect.succeed(Option.none())
  return Effect.try({
    try: (): unknown => JSON.parse(line),
    catch: () => 'not JSON',
  }).pipe(
    Effect.flatMap(record =>
      record === null || typeof record !== 'object' || Array.isArray(record)
        ? Effect.fail('not a JSON object')
        : '_type' in record && record._type !== 'issue'
          ? Effect.succeed(Option.none())
          : decodeIssue(record).pipe(
              Effect.mapBoth({
                onFailure: error => error.message,
                onSuccess: Option.some,
              }),
            ),
    ),
  )
}

const decodeIssue = Schema.decodeUnknownEffect(BeadsIssue)

/** The Beads file's tickets and edges, or every problem that keeps it out, by line. */
export const readBeads = Effect.fn('Beads.read')(function* (
  text: string,
): Effect.fn.Return<BeadsBacklog, BeadsRefused> {
  const tickets: Array<ImportedTicket> = []
  const edges: Array<Edge> = []
  const dropped: Array<string> = []
  const problems: Array<string> = []
  const lineOf = new Map<string, number>()
  for (const [index, line] of text.split('\n').entries()) {
    if (index > 0 && index % readBatchSize === 0) yield* Effect.yieldNow
    const number = index + 1
    const read = yield* readLine(line).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<Mapped>()),
          onSome: issue => {
            const first = lineOf.get(issue.id)
            if (first !== undefined) {
              return Effect.fail(`${issue.id} is on line ${first} too`)
            }
            lineOf.set(issue.id, number)
            return mapIssue(issue).pipe(
              Effect.mapBoth({
                onFailure: problem => `${issue.id}: ${problem}`,
                onSuccess: Option.some,
              }),
            )
          },
        }),
      ),
      Effect.result,
    )
    if (Result.isFailure(read)) {
      problems.push(`line ${number}: ${read.failure}`)
    } else {
      for (const mapped of Option.toArray(read.success)) {
        tickets.push(mapped.imported)
        edges.push(...mapped.edges)
        dropped.push(...mapped.dropped)
      }
    }
  }
  const [first, ...rest] = problems
  if (first !== undefined) {
    return yield* new BeadsRefused({ problems: [first, ...rest] })
  }
  return { tickets, edges, dropped }
})

/** An edge the work graph left out, in words. */
const droppedWords = DroppedEdge.$match({
  Missing: ({ edge, id }) =>
    `${edgeWords(edge)}: neither the file nor the project has ${id}`,
  Cycle: ({ edge }) => `${edgeWords(edge)}: it would close a cycle`,
})

/**
 * Imports the Beads file into the work graph, the actor's change: refused whole when a record can't
 * be read, otherwise its tickets created or merged, and what was left out said.
 */
export const importBeads = Effect.fn('Beads.import')(function* (options: {
  readonly graph: WorkGraphShape
  readonly text: string
  readonly actor: Actor
}): Effect.fn.Return<Imported, BeadsRefused | InvalidTicket | StoreFailed> {
  const backlog = yield* readBeads(options.text)
  const outcome = yield* options.graph.importTickets({
    tickets: backlog.tickets,
    edges: backlog.edges,
    actor: options.actor,
  })
  return Imported.make({
    created: outcome.created.length,
    merged: outcome.merged.length,
    changed: outcome.merged.flatMap(({ id, fields }) => {
      const [first, ...rest] = fields
      return first === undefined
        ? []
        : [ImportedChange.make({ ticket: id, fields: [first, ...rest] })]
    }),
    dropped: [
      ...backlog.dropped,
      ...outcome.deleted.map(
        id => `${id}: the project deleted it, so it stays deleted`,
      ),
      ...outcome.dropped.map(droppedWords),
    ],
  })
})
