import { DateTime, Option } from 'effect'
import * as fc from 'fast-check'

import {
  type Actor,
  Assignee,
  CommitHash,
  EngineId,
  LabelName,
  ModelOverride,
  Note,
  NoteId,
  Question,
  QuestionChoices,
  QuestionOption,
  SessionId,
  Ticket,
  TicketId,
  TicketResult,
  type TicketStatus,
  type TicketType,
} from '@fabrica/contracts'

import {
  type ClockedField,
  type Clocks,
  Hlc,
  TicketFile,
  byClockedField,
  clockedFields,
  later,
  tick,
  zero,
} from '../src/ticketsref'

// fast-check arbitraries for the tickets ref's tests: tickets and their files, clocks, and a side's
// edits of a base ticket, made as an engine makes them (every changed field at a clock past the base's).

export const engines = ['fe-a', 'fe-b', 'fe-c'].map(id => EngineId.make(id))
export const engineArb = fc.constantFrom(...engines)

/** Text with something besides whitespace, any code points (astral ones too). */
const textArb = fc
  .string({ unit: 'binary', minLength: 1, maxLength: 10 })
  .filter(text => /\S/u.test(text))
const lineArb = textArb.filter(text => !/[\n\r]/u.test(text))

/** An optional value, as the contracts keep it. */
const optionArb = <A>(arb: fc.Arbitrary<A>): fc.Arbitrary<Option.Option<A>> =>
  fc
    .option(arb, { nil: undefined })
    .map(value => (value === undefined ? Option.none() : Option.some(value)))

export const momentArb = fc
  .integer({ min: 0, max: 4_102_444_800_000 })
  .map(millis => DateTime.makeUnsafe(millis))

export const hlcArb = fc
  .record({
    wall: fc.integer({ min: 0, max: 2_000_000_000_000 }),
    counter: fc.nat(3),
    engine: engineArb,
  })
  .map(clock => new Hlc(clock))

const sessionArb = fc.constantFrom('s-1', 's-2').map(id => SessionId.make(id))

const actorArb: fc.Arbitrary<Actor> = fc.oneof(
  fc.constant<Actor>({ _tag: 'maintainer' }),
  sessionArb.map((session): Actor => ({ _tag: 'worker', session })),
  engineArb.map((engine): Actor => ({ _tag: 'engine', engine })),
)

export const labelPool = ['solo', 'area-ui', 'area-engine', 'human'].map(
  label => LabelName.make(label),
)
const labelArb = fc.oneof(
  fc.constantFrom(...labelPool),
  fc
    .string({ unit: 'binary', minLength: 1, maxLength: 6 })
    .filter(label => /^\S+$/u.test(label))
    .map(label => LabelName.make(label)),
)

export const subject = TicketId.make('fa-subject')
export const ticketPool = ['fa-a1', 'fa-b2', 'fa-c3', 'fa-d4.1'].map(id =>
  TicketId.make(id),
)
const ticketIdArb = fc
  .stringMatching(/^[a-z0-9]{2,6}$/u)
  .map(random => TicketId.make(`fa-${random}`))

export const noteArb = (ticketId: TicketId): fc.Arbitrary<Note> =>
  fc
    .record({
      id: fc.stringMatching(/^[a-z0-9]{8}$/u).map(id => NoteId.make(id)),
      author: actorArb,
      body: textArb,
      at: momentArb,
    })
    .map(note => new Note({ ...note, ticketId }))

const engineMetadataKeys = new Set([
  'files',
  'spec',
  'predicted_files',
  'result_kind',
])

const metadataArb = fc
  .record({
    files: optionArb(fc.array(textArb, { maxLength: 3 })),
    spec: optionArb(textArb),
    rest: fc.dictionary(
      fc
        .string({ unit: 'binary', maxLength: 6 })
        .filter(key => !engineMetadataKeys.has(key)),
      // As a file holds it: JSON has no -0.
      fc
        .jsonValue({ maxDepth: 2 })
        .map((value): unknown => JSON.parse(JSON.stringify(value))),
      { maxKeys: 3 },
    ),
  })
  .map(({ files, spec, rest }) => ({
    ...rest,
    files,
    spec,
    predicted_files: Option.none(),
    result_kind: Option.none(),
  }))

const questionArb = fc
  .record({
    choices: optionArb(
      fc
        .array(fc.record({ label: lineArb, tradeOff: lineArb }), {
          minLength: 2,
          maxLength: 4,
        })
        .chain(options =>
          fc.nat(options.length - 1).map(
            recommended =>
              new QuestionChoices({
                options: options.map(option => new QuestionOption(option)),
                recommended,
              }),
          ),
        ),
    ),
    consequential: fc.boolean(),
    maintainerOnly: fc.boolean(),
    answer: optionArb(textArb),
  })
  .map(question => new Question(question))

const types: ReadonlyArray<TicketType> = [
  'task',
  'bug',
  'feature',
  'chore',
  'epic',
  'question',
  'manual',
]
const statuses: ReadonlyArray<TicketStatus> = [
  'open',
  'in_progress',
  'deferred',
  'closed',
]

/** What a ticket holds besides its ID and times: the fields that carry a clock. */
export type TicketContent = Pick<Ticket, ClockedField>

export const contentArb: fc.Arbitrary<TicketContent> = fc
  .record({
    type: fc.constantFrom(...types),
    title: textArb,
    description: optionArb(fc.string({ unit: 'binary', maxLength: 12 })),
    design: optionArb(fc.string({ maxLength: 12 })),
    acceptance: optionArb(fc.string({ maxLength: 12 })),
    status: fc.constantFrom(...statuses),
    resolution: optionArb(
      fc.constantFrom(
        'done',
        'no_change',
        'cancelled',
        'superseded',
        'answered',
      ),
    ),
    priority: fc.integer({ min: 0, max: 4 }),
    deferUntil: optionArb(momentArb),
    assignee: optionArb(
      fc
        .record({ engine: engineArb, session: sessionArb })
        .map(claim => new Assignee(claim)),
    ),
    model: optionArb(
      fc
        .constantFrom('anthropic/claude-opus-5-5', 'openai/gpt-6:high')
        .map(model => ModelOverride.make(model)),
    ),
    metadata: metadataArb,
    result: optionArb(
      textArb.map(summary => TicketResult.cases.summary.make({ summary })),
    ),
    question: questionArb,
    mergedCommit: optionArb(
      fc.stringMatching(/^[0-9a-f]{40}$/u).map(hash => CommitHash.make(hash)),
    ),
    closeReason: optionArb(fc.string({ maxLength: 12 })),
  })
  .map(({ question, ...content }) => ({
    ...content,
    question:
      content.type === 'question' ? Option.some(question) : Option.none(),
  }))

const clocksArb: fc.Arbitrary<Clocks> = fc
  .record({
    fields: fc.array(hlcArb, {
      minLength: clockedFields.length,
      maxLength: clockedFields.length,
    }),
    reopened: optionArb(hlcArb),
  })
  .map(({ fields, reopened }) => ({
    ...byClockedField(
      field =>
        fields[clockedFields.indexOf(field)] ?? zero(EngineId.make('fe-a')),
    ),
    reopened,
  }))

/** Any ticket file, its lists in any order, with repeats. */
export const ticketFileArb: fc.Arbitrary<TicketFile> = fc
  .record({
    id: ticketIdArb,
    content: contentArb,
    createdAt: momentArb,
    updatedAt: momentArb,
    labels: fc.array(labelArb, { maxLength: 4 }),
    edges: fc.record({
      blocks: fc.array(ticketIdArb, { maxLength: 3 }),
      discovered_from: fc.array(ticketIdArb, { maxLength: 2 }),
      parent: fc.array(ticketIdArb, { maxLength: 2 }),
      related: fc.array(ticketIdArb, { maxLength: 2 }),
    }),
    clocks: clocksArb,
  })
  .chain(file =>
    fc.array(noteArb(file.id), { maxLength: 3 }).map(notes => ({
      ...file,
      notes,
    })),
  )
  .map(
    ({ id, content, createdAt, updatedAt, labels, edges, notes, clocks }) => {
      const others = (ids: ReadonlyArray<TicketId>) =>
        ids.filter(other => other !== id)
      return new TicketFile({
        ticket: new Ticket({ id, ...content, createdAt, updatedAt }),
        labels,
        edges: {
          blocks: others(edges.blocks),
          discovered_from: others(edges.discovered_from),
          parent: others(edges.parent),
          related: others(edges.related),
        },
        notes,
        clocks,
      })
    },
  )

const subsetArb = <A>(items: ReadonlyArray<A>): fc.Arbitrary<Array<A>> =>
  fc.subarray([...items])

/** A base ticket, `subject`, its every field last changed at one clock. */
export const baseArb: fc.Arbitrary<TicketFile> = fc
  .record({
    content: contentArb,
    createdAt: momentArb,
    labels: subsetArb(labelPool),
    blocks: subsetArb(ticketPool),
    related: subsetArb(ticketPool),
    notes: fc.array(noteArb(subject), { maxLength: 2 }),
    clock: hlcArb,
    reopened: optionArb(hlcArb),
  })
  .map(
    ({ content, createdAt, labels, blocks, related, notes, clock, reopened }) =>
      new TicketFile({
        ticket: new Ticket({
          id: subject,
          ...content,
          createdAt,
          updatedAt: createdAt,
        }),
        labels,
        edges: { blocks, discovered_from: [], parent: [], related },
        notes,
        clocks: {
          ...byClockedField(() => clock),
          reopened: Option.map(reopened, early => hlcBefore(early, clock)),
        },
      }),
  )

/** A clock no later than `clock`: a reopen the base had before its last change. */
const hlcBefore = (early: Hlc, clock: Hlc): Hlc =>
  later(early, clock) === early ? clock : early

/** The latest clock in a file. */
const latestClock = (file: TicketFile): Hlc =>
  clockedFields.reduce(
    (latest, field) => later(latest, file.clocks[field]),
    file.clocks.type,
  )

/**
 * One side's edits of `base`, made by one engine: some fields set (each at a clock past the base's,
 * the wall clock maybe behind), labels and edges added and removed, notes added.
 */
export const editArb = (base: TicketFile): fc.Arbitrary<TicketFile> =>
  fc
    .record({
      engine: engineArb,
      content: contentArb,
      fields: subsetArb(clockedFields),
      walls: fc.array(fc.integer({ min: -5, max: 5 }), {
        minLength: clockedFields.length,
        maxLength: clockedFields.length,
      }),
      addLabels: subsetArb(labelPool),
      removeLabels: subsetArb(base.labels),
      addBlocks: subsetArb(ticketPool),
      removeBlocks: subsetArb(base.edges.blocks),
      notes: fc.array(noteArb(subject), { maxLength: 2 }),
      updated: fc.nat(1000),
    })
    .map(edit => {
      const has = (field: ClockedField) => edit.fields.includes(field)
      // A type and its question change together, so the ticket stays one the schema takes.
      const fields: ReadonlyArray<ClockedField> =
        has('type') || has('question')
          ? [...new Set([...edit.fields, 'type' as const, 'question' as const])]
          : edit.fields
      let last = latestClock(base)
      const clocks: Record<ClockedField, Hlc> = byClockedField(
        field => base.clocks[field],
      )
      fields.forEach((field, index) => {
        last = tick({
          engine: edit.engine,
          last,
          now: last.wall + (edit.walls[index] ?? 0),
        })
        clocks[field] = last
      })
      const take = <F extends ClockedField>(field: F): TicketContent[F] =>
        fields.includes(field) ? edit.content[field] : base.ticket[field]
      const status = take('status')
      const reopened =
        fields.includes('status') &&
        base.ticket.status === 'closed' &&
        status !== 'closed'
          ? Option.some(clocks.status)
          : base.clocks.reopened
      return new TicketFile({
        ticket: new Ticket({
          ...base.ticket,
          type: take('type'),
          title: take('title'),
          description: take('description'),
          design: take('design'),
          acceptance: take('acceptance'),
          status,
          resolution: take('resolution'),
          priority: take('priority'),
          deferUntil: take('deferUntil'),
          assignee: take('assignee'),
          model: take('model'),
          metadata: take('metadata'),
          result: take('result'),
          question: take('question'),
          mergedCommit: take('mergedCommit'),
          closeReason: take('closeReason'),
          updatedAt: DateTime.add(base.ticket.updatedAt, {
            milliseconds: edit.updated,
          }),
        }),
        labels: [
          ...base.labels.filter(label => !edit.removeLabels.includes(label)),
          ...edit.addLabels,
        ],
        edges: {
          ...base.edges,
          blocks: [
            ...base.edges.blocks.filter(id => !edit.removeBlocks.includes(id)),
            ...edit.addBlocks,
          ],
        },
        notes: [...base.notes, ...edit.notes],
        clocks: { ...clocks, reopened },
      })
    })

/** A base ticket and two sides' edits of it. */
export const threeWayArb = baseArb.chain(base =>
  fc.record({
    base: fc.constant(base),
    ours: editArb(base),
    theirs: editArb(base),
    holder: optionArb(engineArb),
  }),
)
