import {
  Data,
  DateTime,
  Effect,
  Option,
  Order,
  Record,
  Schema,
  SchemaIssue,
  SchemaTransformation,
} from 'effect'

import {
  EngineId,
  LabelName,
  Line,
  Note,
  RunId,
  Text,
  Ticket,
  TicketId,
} from '@fabrica/contracts'

import { CodePoints, sortedUnique } from './code-points'
import { HlcFromString } from './hlc'

// The tickets ref's files (spec §11.3, §11.7): `tickets/<id>.json`, one a ticket, its labels, edges
// and notes inside; `tombstones/<id>.json`, one a deleted ticket; `meta.json`, the ID prefix and the
// layout's version; `lease.json`, the run lease (§11.5). Every file is canonical: UTF-8, LF, two-space
// indent, a trailing newline, keys in code point order, every field present (`null` or `[]` when
// empty), lists of IDs sorted and each once, one to a line, times ISO 8601 in UTC with milliseconds.
// The same state always encodes to the same bytes, so a sync with nothing changed writes nothing.
//
// Versions: `meta.json`'s `layout` is the ref's layout, each file's `v` its record's shape. A reader
// takes its version and every older one, upgraded in memory through Schema transformations (a
// version's reader decodes it into the newest record); a writer writes the newest. A layout or a
// record newer than the engine is refused, so an engine never writes an older format over a newer one.

/** The ref's layout this engine reads and writes. */
export const layoutVersion = 1

/** What a file of the ref holds. */
export type RecordKind = 'ticket' | 'tombstone' | 'meta' | 'lease'

/** A file that doesn't decode: not UTF-8, not JSON, or not its record (spec §11.7: it is quarantined). */
export class RecordUndecodable extends Data.TaggedError('RecordUndecodable')<{
  readonly kind: RecordKind
  readonly issue: string
}> {
  override get message() {
    return `a ${this.kind} file doesn't decode: ${this.issue}`
  }
}

/** A file written by a newer engine: its record's version is past the newest this engine reads. */
export class RecordTooNew extends Data.TaggedError('RecordTooNew')<{
  readonly kind: RecordKind
  readonly version: number
  readonly newest: number
}> {
  override get message() {
    return `a ${this.kind} file is version ${this.version}; this engine reads up to ${this.newest}: update the engine`
  }
}

/** The ref's layout is newer than this engine's: sync stops and asks for an update (spec §11.7). */
export class LayoutTooNew extends Data.TaggedError('LayoutTooNew')<{
  readonly layout: number
}> {
  override get message() {
    return `the tickets ref has layout ${this.layout}; this engine knows up to ${layoutVersion}: update the engine`
  }
}

/** A record holding something JSON can't: a value of a ticket's metadata that isn't JSON. */
export class RecordUnencodable extends Data.TaggedError('RecordUnencodable')<{
  readonly kind: RecordKind
  readonly issue: string
}> {
  override get message() {
    return `a ${this.kind} record doesn't encode: ${this.issue}`
  }
}

// --- Canonical JSON --------------------------------------------------------------------------

/**
 * `value` as canonical JSON text: two-space indent, LF, keys in code point order, a trailing newline.
 * Throws a `TypeError` on what JSON can't hold (`undefined`, a function, a number that isn't finite).
 */
export const canonicalJson = (value: unknown): string =>
  `${writeJson(value, '')}\n`

const writeJson = (value: unknown, indent: string): string => {
  if (value === null || typeof value === 'boolean') return String(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${value} isn't JSON`)
    return JSON.stringify(value)
  }
  const inner = `${indent}  `
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const items = value.map(item => `${inner}${writeJson(item, inner)}`)
    return `[\n${items.join(',\n')}\n${indent}]`
  }
  if (typeof value === 'object' && isPlainObject(value)) {
    const keys = Object.keys(value).sort(CodePoints)
    if (keys.length === 0) return '{}'
    const entries = keys.map(
      key =>
        `${inner}${JSON.stringify(key)}: ${writeJson(Reflect.get(value, key), inner)}`,
    )
    return `{\n${entries.join(',\n')}\n${indent}}`
  }
  throw new TypeError(`${typeof value} isn't JSON`)
}

const isPlainObject = (value: object): boolean => {
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

/** A file's text: its bytes as UTF-8, refused when they aren't. */
const fileText = (
  kind: RecordKind,
  file: string | Uint8Array,
): Effect.Effect<string, RecordUndecodable> =>
  typeof file === 'string'
    ? Effect.succeed(file)
    : Effect.try({
        try: () => utf8.decode(file),
        catch: () => new RecordUndecodable({ kind, issue: 'not UTF-8' }),
      })

const parseJson = (
  kind: RecordKind,
  text: string,
): Effect.Effect<unknown, RecordUndecodable> =>
  Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: cause => new RecordUndecodable({ kind, issue: String(cause) }),
  })

const Version = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/** A record's version, `v`, read before the rest so a newer one is refused as such. */
const Versioned = Schema.Struct({ v: Version })

/**
 * A record's codec: the newest record's schema (what is written), and a reader for each version
 * from 1, each decoding its version into the newest record.
 */
const recordCodec = <Value, Record_>({
  kind,
  newest,
  readers,
  fromRecord,
  toRecord,
}: {
  readonly kind: RecordKind
  readonly newest: Schema.Codec<Record_, unknown>
  readonly readers: ReadonlyArray<Schema.Decoder<Record_>>
  readonly fromRecord: (
    record: Record_,
  ) => Effect.Effect<Value, SchemaIssue.Issue>
  readonly toRecord: (value: Value) => Record_
}) => {
  const encodeRecord = Schema.encodeEffect(newest)
  const undecodable = (error: Schema.SchemaError | SchemaIssue.Issue) =>
    new RecordUndecodable({
      kind,
      issue: Schema.isSchemaError(error) ? error.message : String(error),
    })
  return {
    encode: (value: Value): Effect.Effect<string, RecordUnencodable> =>
      encodeRecord(toRecord(value)).pipe(
        Effect.flatMap(encoded =>
          Effect.try({
            try: () => canonicalJson(encoded),
            catch: cause => cause,
          }),
        ),
        Effect.mapError(
          cause => new RecordUnencodable({ kind, issue: String(cause) }),
        ),
      ),
    decodeJson: (
      json: unknown,
    ): Effect.Effect<Value, RecordUndecodable | RecordTooNew> =>
      Schema.decodeUnknownEffect(Versioned)(json).pipe(
        Effect.mapError(undecodable),
        Effect.flatMap(
          ({ v }): Effect.Effect<Value, RecordUndecodable | RecordTooNew> => {
            const reader = readers[v - 1]
            return reader === undefined
              ? Effect.fail(
                  new RecordTooNew({
                    kind,
                    version: v,
                    newest: readers.length,
                  }),
                )
              : Schema.decodeUnknownEffect(reader)(json).pipe(
                  Effect.flatMap(fromRecord),
                  Effect.mapError(undecodable),
                )
          },
        ),
      ),
  }
}

const decodeFile =
  <Value, E>(
    kind: RecordKind,
    decodeJson: (json: unknown) => Effect.Effect<Value, E>,
  ) =>
  (file: string | Uint8Array): Effect.Effect<Value, E | RecordUndecodable> =>
    fileText(kind, file).pipe(
      Effect.flatMap(text => parseJson(kind, text)),
      Effect.flatMap(decodeJson),
    )

// --- Times and lists -------------------------------------------------------------------------

/** A moment, written ISO 8601 in UTC with milliseconds: `2026-10-29T12:00:00.000Z`. */
export const IsoMoment = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u, {
    expected:
      'a time in UTC with milliseconds, such as 2026-10-29T12:00:00.000Z',
  }),
).pipe(
  Schema.decodeTo(
    Schema.DateTimeUtc,
    SchemaTransformation.dateTimeUtcFromString,
  ),
)

// --- Ticket files ----------------------------------------------------------------------------

/**
 * A ticket's links in its file: the tickets it blocks, is the parent of, was discovered from, and is
 * related to (each edge is kept once, in its `from` ticket's file).
 */
export const FileEdges = Schema.Struct({
  blocks: Schema.Array(TicketId),
  discovered_from: Schema.Array(TicketId),
  parent: Schema.Array(TicketId),
  related: Schema.Array(TicketId),
})
export type FileEdges = typeof FileEdges.Type

/** The ticket's fields that change, each with the clock of its last change (spec §11.3). */
const clockFields = {
  type: HlcFromString,
  title: HlcFromString,
  description: HlcFromString,
  design: HlcFromString,
  acceptance: HlcFromString,
  status: HlcFromString,
  resolution: HlcFromString,
  priority: HlcFromString,
  deferUntil: HlcFromString,
  assignee: HlcFromString,
  model: HlcFromString,
  metadata: HlcFromString,
  result: HlcFromString,
  question: HlcFromString,
  mergedCommit: HlcFromString,
  closeReason: HlcFromString,
} satisfies Record<
  Exclude<keyof Ticket, 'id' | 'createdAt' | 'updatedAt'>,
  typeof HlcFromString
>

/** A field of a ticket that carries a clock: every one but its ID and its two times. */
export type ClockedField = keyof typeof clockFields

/** The fields that carry a clock. */
export const clockedFields: ReadonlyArray<ClockedField> =
  Record.keys(clockFields)

/** A value for each field that carries a clock. */
export const byClockedField = <A>(
  f: (field: ClockedField) => A,
): Record<ClockedField, A> => Record.map(clockFields, (_, field) => f(field))

/**
 * Each changing field's clock, and the clock of the ticket's last reopen, if it was ever reopened: a
 * reopen after a close wins over the close by its clock (spec §11.4).
 */
export const Clocks = Schema.Struct({
  ...clockFields,
  reopened: Schema.OptionFromNullOr(HlcFromString),
})
export type Clocks = typeof Clocks.Type

/** A ticket file in memory: the ticket, its labels, the edges from it, its notes, its clocks. */
export class TicketFile extends Schema.Class<TicketFile>('TicketFile')(
  Schema.Struct({
    ticket: Ticket,
    labels: Schema.Array(LabelName),
    edges: FileEdges,
    notes: Schema.Array(Note),
    clocks: Clocks,
  }).check(
    Schema.makeFilter(({ ticket, edges, notes }) =>
      Object.values(edges).some(ids => ids.includes(ticket.id))
        ? { path: ['edges'], issue: 'a ticket is never linked to itself' }
        : notes.some(note => note.ticketId !== ticket.id)
          ? {
              path: ['notes'],
              issue: `a note in ${ticket.id}'s file is on another ticket`,
            }
          : undefined,
    ),
  ),
) {}

/** A note as its ticket's file holds it: `{id, author, body, at}`. */
const NoteRecord = Schema.Struct({
  id: Note.fields.id,
  author: Note.fields.author,
  body: Note.fields.body,
  at: IsoMoment,
})

/** A ticket's fields as its file writes them: the contracts' schema's, its times ISO. */
const ticketFields = {
  ...Ticket.fields,
  deferUntil: Schema.OptionFromNullOr(IsoMoment),
  createdAt: IsoMoment,
  updatedAt: IsoMoment,
}

const encodeTicketFields = Schema.encodeSync(Schema.Struct(ticketFields))

/**
 * Each changing field of a ticket as its file writes it, in canonical text. Throws where
 * `encodeTicketFile` fails, on metadata that isn't JSON.
 */
export const fieldTexts = (ticket: Ticket): Record<ClockedField, string> => {
  const encoded = encodeTicketFields(ticket)
  return byClockedField(field => canonicalJson(encoded[field]))
}

/** A ticket file's record, version 1: the ticket's fields, its times ISO, beside its labels, edges, notes and clocks. */
const TicketRecordV1 = Schema.Struct({
  ...ticketFields,
  labels: Schema.Array(LabelName),
  edges: FileEdges,
  notes: Schema.Array(NoteRecord),
  clocks: Clocks,
  v: Schema.Literal(1),
})
type TicketRecord = typeof TicketRecordV1.Type

const noteJson = Schema.encodeSync(NoteRecord)

/** Notes in their file's order: by time, then by ID. */
const NoteOrder: Order.Order<Note> = Order.combine(
  Order.mapInput(DateTime.Order, (note: Note) => note.at),
  Order.mapInput(CodePoints, (note: Note) => note.id),
)

/**
 * Notes, one for each ID, in their file's order. Two notes with the same ID (two engines' copies of
 * one note) keep the one whose canonical encoding sorts first, so every engine keeps the same.
 */
export const notesById = (notes: Iterable<Note>): Array<Note> => {
  const byId = new Map<string, { readonly note: Note; readonly json: string }>()
  for (const note of notes) {
    const json = canonicalJson(noteJson(note))
    const kept = byId.get(note.id)
    if (kept === undefined || CodePoints(json, kept.json) < 0)
      byId.set(note.id, { note, json })
  }
  return [...byId.values()].map(({ note }) => note).sort(NoteOrder)
}

/** A ticket file in its canonical form: labels and edges sorted and each once, notes one an ID, in order. */
export const canonicalTicketFile = (file: TicketFile): TicketFile =>
  new TicketFile({
    ticket: file.ticket,
    labels: sortedUnique(file.labels),
    edges: {
      blocks: sortedUnique(file.edges.blocks),
      discovered_from: sortedUnique(file.edges.discovered_from),
      parent: sortedUnique(file.edges.parent),
      related: sortedUnique(file.edges.related),
    },
    notes: notesById(file.notes),
    clocks: file.clocks,
  })

const ticketRecord = (file: TicketFile): TicketRecord => {
  const { ticket, labels, edges, notes, clocks } = canonicalTicketFile(file)
  return {
    ...ticket,
    labels,
    edges,
    notes: notes.map(({ id, author, body, at }) => ({ id, author, body, at })),
    clocks,
    v: 1,
  }
}

const encodeTicketRecord = Schema.encodeSync(TicketRecordV1)

/**
 * A ticket file's canonical text, at once: two files are the same state exactly when their texts are.
 * Throws where `encodeTicketFile` fails, on metadata that isn't JSON.
 */
export const ticketFileText = (file: TicketFile): string =>
  canonicalJson(encodeTicketRecord(ticketRecord(file)))

const ticketCodec = recordCodec<TicketFile, TicketRecord>({
  kind: 'ticket',
  newest: TicketRecordV1,
  readers: [TicketRecordV1],
  fromRecord: ({ labels, edges, notes, clocks, v: _v, ...fields }) =>
    Ticket.makeEffect(fields).pipe(
      Effect.flatMap(ticket =>
        Effect.forEach(notes, note =>
          Note.makeEffect({ ...note, ticketId: ticket.id }),
        ).pipe(
          Effect.flatMap(notes =>
            TicketFile.makeEffect({ ticket, labels, edges, notes, clocks }),
          ),
        ),
      ),
      Effect.map(canonicalTicketFile),
    ),
  toRecord: ticketRecord,
})

/** A ticket file's canonical text. */
export const encodeTicketFile = ticketCodec.encode

/** A ticket file, from its bytes or text; read as canonical whatever order its lists were in. */
export const decodeTicketFile = decodeFile('ticket', ticketCodec.decodeJson)

// --- Tombstones ------------------------------------------------------------------------------

/** A deleted ticket (spec §11.7): its ID and the clock of its deletion, which names the engine that deleted it. */
export class Tombstone extends Schema.Class<Tombstone>('Tombstone')({
  id: TicketId,
  clock: HlcFromString,
}) {}

const TombstoneRecordV1 = Schema.Struct({
  ...Tombstone.fields,
  v: Schema.Literal(1),
})

const tombstoneCodec = recordCodec<Tombstone, typeof TombstoneRecordV1.Type>({
  kind: 'tombstone',
  newest: TombstoneRecordV1,
  readers: [TombstoneRecordV1],
  fromRecord: ({ v: _v, ...fields }) => Tombstone.makeEffect(fields),
  toRecord: ({ id, clock }) => ({ id, clock, v: 1 }),
})

/** A tombstone's canonical text. */
export const encodeTombstone = tombstoneCodec.encode

/** A tombstone, from its bytes or text. */
export const decodeTombstone = decodeFile(
  'tombstone',
  tombstoneCodec.decodeJson,
)

// --- meta.json -------------------------------------------------------------------------------

/** A ticket ID prefix: what starts a ticket ID before its `-`, such as `fa`. */
export const TicketPrefix = Schema.String.check(
  Schema.makeFilter((prefix: string) =>
    Option.isSome(TicketId.makeOption(`${prefix}-0`))
      ? undefined
      : 'a ticket ID prefix: lower-case letters and digits, words joined by -',
  ),
)

/** `meta.json`: the ref's layout and the project's ticket ID prefix. */
export class TicketsMeta extends Schema.Class<TicketsMeta>('TicketsMeta')({
  layout: Schema.Literal(layoutVersion),
  prefix: TicketPrefix,
}) {}

const MetaRecordV1 = Schema.Struct({
  ...TicketsMeta.fields,
  v: Schema.Literal(1),
})

const metaCodec = recordCodec<TicketsMeta, typeof MetaRecordV1.Type>({
  kind: 'meta',
  newest: MetaRecordV1,
  readers: [MetaRecordV1],
  fromRecord: ({ v: _v, ...fields }) => TicketsMeta.makeEffect(fields),
  toRecord: ({ layout, prefix }) => ({ layout, prefix, v: 1 }),
})

/** The ref's layout, read before the rest of `meta.json`, so a newer one is refused as such. */
const Layout = Schema.Struct({ layout: Version })

/** `meta.json`'s canonical text. */
export const encodeMeta = metaCodec.encode

/** `meta.json`, from its bytes or text; a layout newer than this engine's is refused. */
export const decodeMeta = decodeFile('meta', json =>
  Schema.decodeUnknownEffect(Layout)(json).pipe(
    Effect.mapError(
      error => new RecordUndecodable({ kind: 'meta', issue: error.message }),
    ),
    Effect.flatMap(
      ({
        layout,
      }): Effect.Effect<
        TicketsMeta,
        LayoutTooNew | RecordTooNew | RecordUndecodable
      > =>
        layout > layoutVersion
          ? Effect.fail(new LayoutTooNew({ layout }))
          : metaCodec.decodeJson(json),
    ),
  ),
)

// --- lease.json ------------------------------------------------------------------------------

/**
 * The run lease (spec §11.5): the engine running the project, its name and host, its run, when the
 * run started, when the lease was last renewed, and when it expires.
 */
export class RunLease extends Schema.Class<RunLease>('RunLease')({
  engine: EngineId,
  name: Line,
  host: Text,
  run: RunId,
  startedAt: Schema.DateTimeUtc,
  renewedAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
}) {}

const LeaseRecordV1 = Schema.Struct({
  ...RunLease.fields,
  startedAt: IsoMoment,
  renewedAt: IsoMoment,
  expiresAt: IsoMoment,
  v: Schema.Literal(1),
})

const leaseCodec = recordCodec<RunLease, typeof LeaseRecordV1.Type>({
  kind: 'lease',
  newest: LeaseRecordV1,
  readers: [LeaseRecordV1],
  fromRecord: ({ v: _v, ...fields }) => RunLease.makeEffect(fields),
  toRecord: lease => ({ ...lease, v: 1 }),
})

/** `lease.json`'s canonical text. */
export const encodeLease = leaseCodec.encode

/** `lease.json`, from its bytes or text. */
export const decodeLease = decodeFile('lease', leaseCodec.decodeJson)
