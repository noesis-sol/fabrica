import { DateTime, Effect, Exit, Option, Schema } from 'effect'

import { describe, expect, expectTypeOf, it } from '@effect/vitest'

import { NoteId } from './ids'
import {
  Actor,
  Edge,
  Label,
  Note,
  ResultKind,
  Ticket,
  TicketChange,
  TicketEvent,
  TicketMetadata,
  TicketResult,
} from './ticket'

const createdAt = 1_793_000_000_000
const updatedAt = 1_793_000_060_000
const merged = 'eda8c7a0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6'

/** A task as the store's row decodes, every optional field empty. */
const task = {
  id: 'fab-mgi.3.1',
  type: 'task',
  title: 'Contracts: the ticket model schemas',
  description: null,
  design: null,
  acceptance: null,
  status: 'open',
  resolution: null,
  priority: 1,
  deferUntil: null,
  assignee: null,
  model: null,
  metadata: {},
  result: null,
  question: null,
  mergedCommit: null,
  closeReason: null,
  createdAt,
  updatedAt,
}

const choices = (count: number, recommended: unknown) => ({
  options: Array.from({ length: count }, (_, index) => ({
    label: `Option ${index + 1}`,
    tradeOff: `What option ${index + 1} costs`,
  })),
  recommended,
})

const question = (questionFields: Record<string, unknown>) => ({
  ...task,
  id: 'fab-q1x2',
  type: 'question',
  title: 'Keep the test file next to its module?',
  question: {
    choices: choices(2, 0),
    consequential: false,
    maintainerOnly: false,
    answer: null,
    ...questionFields,
  },
})

const decode = Schema.decodeUnknownEffect(Ticket)
const encode = Schema.encodeEffect(Ticket)

const refuses = (input: unknown) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(decode(input))
    expect(Exit.isFailure(exit)).toBe(true)
  })

describe('Ticket', () => {
  it.effect('decodes an open task, its empty fields as None', () =>
    Effect.gen(function* () {
      const ticket = yield* decode(task)
      expect(ticket).toBeInstanceOf(Ticket)
      expect(ticket.id).toBe('fab-mgi.3.1')
      expect(ticket.priority).toBe(1)
      expect(Option.isNone(ticket.assignee)).toBe(true)
      expect(Option.isNone(ticket.metadata.files)).toBe(true)
      expect(DateTime.toEpochMillis(ticket.createdAt)).toBe(createdAt)
      expect(yield* encode(ticket)).toEqual(task)
    }),
  )

  it.effect('round-trips a closed, merged ticket with every field set', () =>
    Effect.gen(function* () {
      const closed = {
        ...task,
        description: 'Define the schemas.',
        design: 'Effect Schema classes.',
        acceptance: 'The checks pass.',
        status: 'closed',
        resolution: 'done',
        priority: 0,
        deferUntil: createdAt,
        assignee: { engine: 'engine-1', session: 'session-1' },
        model: 'anthropic/claude-opus-5-5',
        metadata: {
          files: ['packages/contracts/src/ticket.ts'],
          spec: 'docs/spec/fabrica-spec.md',
          predicted_files: ['packages/contracts/src/index.ts'],
          result_kind: 'contract_changed',
          imported_from: 'beads',
        },
        result: {
          _tag: 'contract_changed',
          summary: 'Added the ticket schemas.',
          contracts: ['@fabrica/contracts Ticket'],
          breaking: false,
        },
        mergedCommit: merged,
        closeReason: 'Merged.',
      }
      const ticket = yield* decode(closed)
      expect(ticket.metadata.files).toEqual(
        Option.some(['packages/contracts/src/ticket.ts']),
      )
      expect(ticket.metadata.result_kind).toEqual(
        Option.some('contract_changed'),
      )
      expect(ticket.metadata['imported_from']).toBe('beads')
      expect(
        Option.map(
          ticket.result,
          TicketResult.match({
            summary: () => 'summary',
            contract_changed: ({ contracts }) => contracts.join(),
            migration_added: ({ migration }) => migration,
            decision_recorded: ({ decision }) => decision,
          }),
        ),
      ).toEqual(Option.some('@fabrica/contracts Ticket'))
      expect(yield* encode(ticket)).toEqual(closed)
    }),
  )

  it.effect.each([0, 4])('takes priority %d', priority =>
    Effect.gen(function* () {
      const ticket = yield* decode({ ...task, priority })
      expect(ticket.priority).toBe(priority)
    }),
  )

  it.effect.each<readonly [string, Record<string, unknown>]>([
    ['priority 5', { priority: 5 }],
    ['priority -1', { priority: -1 }],
    ['priority 1.5', { priority: 1.5 }],
    ['an unknown type', { type: 'story' }],
    ['an unknown status', { status: 'blocked' }],
    ['an unknown resolution', { resolution: 'wontfix' }],
    ['a blank title', { title: '  ' }],
    ['a malformed ID', { id: 'Fab-mgi' }],
    ['a short commit', { mergedCommit: 'eda8c7a' }],
    ['a model without its provider', { model: 'claude-opus-5-5' }],
    ['an unknown result kind', { metadata: { result_kind: 'other' } }],
    ['files that are not a list', { metadata: { files: 'a.ts' } }],
    ['a result of no kind', { result: { summary: 'Done.' } }],
    [
      'a result missing its fields',
      { result: { _tag: 'migration_added', summary: 'Done.' } },
    ],
    ['a missing field', { createdAt: undefined }],
  ])('refuses %s', ([_name, change]) => refuses({ ...task, ...change }))
})

describe('Question', () => {
  it.effect.each([2, 3, 4])('decodes a question with %d options', count =>
    Effect.gen(function* () {
      const ticket = yield* decode(
        question({ choices: choices(count, count - 1) }),
      )
      const options = Option.map(
        Option.flatMap(ticket.question, ({ choices }) => choices),
        ({ options, recommended }) => [options.length, recommended],
      )
      expect(options).toEqual(Option.some([count, count - 1]))
    }),
  )

  it.effect(
    'round-trips an answered, consequential, maintainer-only question',
    () =>
      Effect.gen(function* () {
        const answered = {
          ...question({
            consequential: true,
            maintainerOnly: true,
            answer: 'Option 2',
          }),
          status: 'closed',
          resolution: 'answered',
        }
        const ticket = yield* decode(answered)
        expect(Option.map(ticket.question, ({ answer }) => answer)).toEqual(
          Option.some(Option.some('Option 2')),
        )
        expect(yield* encode(ticket)).toEqual(answered)
      }),
  )

  it.effect('decodes a question filed without options', () =>
    Effect.gen(function* () {
      const ticket = yield* decode(question({ choices: null }))
      expect(
        Option.map(ticket.question, ({ choices }) => Option.isNone(choices)),
      ).toEqual(Option.some(true))
    }),
  )

  it.effect.each<readonly [string, Record<string, unknown>]>([
    ['1 option', { choices: choices(1, 0) }],
    ['5 options', { choices: choices(5, 0) }],
    ['two recommended', { choices: choices(3, [0, 1]) }],
    ['no option recommended', { choices: { options: choices(2, 0).options } }],
    ['a recommended index past its options', { choices: choices(3, 3) }],
    ['a negative recommended index', { choices: choices(3, -1) }],
    [
      'an option without its trade-off',
      {
        choices: {
          options: [{ label: 'A' }, { label: 'B', tradeOff: 'b' }],
          recommended: 0,
        },
      },
    ],
    [
      'an option with a blank label',
      {
        choices: {
          options: [
            { label: ' ', tradeOff: 'a' },
            { label: 'B', tradeOff: 'b' },
          ],
          recommended: 0,
        },
      },
    ],
    ['no consequential flag', { consequential: undefined }],
  ])('refuses a question with %s', ([_name, fields]) =>
    refuses(question(fields)),
  )

  it.effect('refuses a question ticket without its question', () =>
    refuses({ ...question({}), question: null }),
  )

  it.effect('refuses a question on a ticket of another type', () =>
    refuses({ ...question({}), type: 'task' }),
  )
})

describe('Label, Edge and Note', () => {
  it.effect('decode and encode', () =>
    Effect.gen(function* () {
      const label = { ticketId: 'fab-mgi.3.1', label: 'solo' }
      const edge = { from: 'fab-mgi.1', to: 'fab-mgi.3.1', kind: 'blocks' }
      const note = {
        id: 'note-1',
        ticketId: 'fab-mgi.3.1',
        author: { _tag: 'worker', session: 'session-1' },
        body: 'Waiting on fab-mgi.1.',
        at: createdAt,
      }
      const decoded = yield* Effect.all([
        Schema.decodeUnknownEffect(Label)(label),
        Schema.decodeUnknownEffect(Edge)(edge),
        Schema.decodeUnknownEffect(Note)(note),
      ])
      expect(decoded[2].id).toBe(NoteId.make('note-1'))
      expect(
        yield* Effect.all([
          Schema.encodeEffect(Label)(decoded[0]),
          Schema.encodeEffect(Edge)(decoded[1]),
          Schema.encodeEffect(Note)(decoded[2]),
        ]),
      ).toEqual([label, edge, note])
    }),
  )

  it.effect.each(['blocks', 'parent', 'discovered_from', 'related'])(
    'takes an edge of kind %s',
    kind =>
      Effect.gen(function* () {
        const edge = yield* Schema.decodeUnknownEffect(Edge)({
          from: 'fab-mgi',
          to: 'fab-mgi.3',
          kind,
        })
        expect(edge.kind).toBe(kind)
      }),
  )

  it.effect.each<readonly [string, Schema.Decoder<unknown>, unknown]>([
    [
      'an edge of an unknown kind',
      Edge,
      { from: 'fab-mgi', to: 'fab-mgi.3', kind: 'depends' },
    ],
    [
      'an edge from a ticket to itself',
      Edge,
      { from: 'fab-mgi', to: 'fab-mgi', kind: 'related' },
    ],
    [
      'a label with a space',
      Label,
      { ticketId: 'fab-mgi', label: 'two words' },
    ],
    [
      'a note with no author',
      Note,
      { id: 'n', ticketId: 'fab-mgi', body: 'b', at: createdAt },
    ],
  ])('refuse %s', ([_name, schema, input]) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(Schema.decodeUnknownEffect(schema)(input))
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})

describe('Actor', () => {
  it.effect.each([
    { _tag: 'maintainer' },
    { _tag: 'worker', session: 'session-1' },
    { _tag: 'talk', session: 'session-2' },
    { _tag: 'organ', organ: 'triage' },
    { _tag: 'engine', engine: 'engine-1' },
  ])('round-trips $_tag', actor =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(Actor)(actor)
      expect(yield* Schema.encodeEffect(Actor)(decoded)).toEqual(actor)
    }),
  )

  it.effect('refuses an unknown organ', () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Schema.decodeUnknownEffect(Actor)({ _tag: 'organ', organ: 'oracle' }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})

describe('TicketEvent', () => {
  const event = (change: unknown) => ({
    seq: 1,
    ticketId: 'fab-mgi.3.1',
    actor: { _tag: 'engine', engine: 'engine-1' },
    change,
    at: createdAt,
  })

  it.effect.each([
    { _tag: 'created' },
    { _tag: 'updated', fields: ['title', 'priority'] },
    { _tag: 'claimed', assignee: { engine: 'engine-1', session: 'session-1' } },
    { _tag: 'closed', resolution: 'done' },
    { _tag: 'deferred', until: null },
    {
      _tag: 'linked',
      edge: { from: 'fab-mgi.1', to: 'fab-mgi.3.1', kind: 'blocks' },
    },
    { _tag: 'labelled', label: 'solo' },
    { _tag: 'noted', note: 'note-1' },
    { _tag: 'answered', answer: 'Option 1' },
    { _tag: 'merge_conflict', field: 'title', ours: 'A', theirs: { v: 2 } },
  ])('round-trips a $_tag event', change =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(TicketEvent)(
        event(change),
      )
      expect(TicketChange.guards[decoded.change._tag](decoded.change)).toBe(
        true,
      )
      expect(yield* Schema.encodeEffect(TicketEvent)(decoded)).toEqual(
        event(change),
      )
    }),
  )

  it.effect.each<readonly [string, unknown]>([
    ['sequence 0', { ...event({ _tag: 'created' }), seq: 0 }],
    ['an unknown change', event({ _tag: 'renamed' })],
    ['an update naming no field', event({ _tag: 'updated', fields: [] })],
  ])('refuses an event with %s', ([_name, input]) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Schema.decodeUnknownEffect(TicketEvent)(input),
      )
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})

describe('result kinds', () => {
  it('name one case of TicketResult each', () => {
    expectTypeOf<ResultKind>().toEqualTypeOf<TicketResult['_tag']>()
    expect([...ResultKind.literals].sort()).toEqual(
      Object.keys(TicketResult.cases).sort(),
    )
  })

  it.effect('decode in metadata on their own', () =>
    Effect.gen(function* () {
      const metadata = yield* Schema.decodeUnknownEffect(TicketMetadata)({
        result_kind: 'migration_added',
      })
      expect(metadata.result_kind).toEqual(Option.some('migration_added'))
    }),
  )
})
