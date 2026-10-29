import { DateTime, Effect, Layer, Option } from 'effect'
import { SqlClient } from 'effect/sql'

import { describe, expect, it } from '@effect/vitest'
import { type Actor, Edge, TicketId } from '@fabrica/contracts'

import {
  BeadsRefused,
  WorkGraph,
  importBeads,
  makeWorkGraph,
  readBeads,
  storeLayer,
} from '../src/workgraph'

// The Beads import (spec §11.6): a `bd export` file, built from the Beads spike's sample records
// (fab-mgi.2.9: tutti's export at bd 1.3.1), imported into an in-memory work graph.

const graphLayer = Layer.effect(
  WorkGraph,
  makeWorkGraph({ prefix: 'fa' }),
).pipe(Layer.provideMerge(storeLayer(':memory:')))

const maintainer: Actor = { _tag: 'maintainer' }

const id = (text: string) => TicketId.make(text)

const at = (iso: string) => DateTime.makeUnsafe(iso)

const dependency = (
  issue: string,
  dependsOn: string,
  type: string,
): Record<string, unknown> => ({
  issue_id: issue,
  depends_on_id: dependsOn,
  type,
  created_at: '2026-10-21T12:10:51Z',
  created_by: 'Michael Michailidis',
  metadata: '{}',
})

/** The spike's answered question, as `bd export` wrote it. */
const question = {
  _type: 'issue',
  id: 'tutti-t6dv',
  title: "Does a spec run's START note print? (verifier rounds differ)",
  description:
    "tutti-kkb.28's verifier rounds disagree on one minor point. Round 1 (at 8f6a824)…",
  status: 'closed',
  priority: 2,
  issue_type: 'task',
  owner: 'michael@noesis.solutions',
  created_at: '2026-10-26T14:50:02Z',
  created_by: 'Michael Michailidis',
  updated_at: '2026-10-26T18:33:15Z',
  closed_at: '2026-10-26T18:33:15Z',
  close_reason: 'Responded',
  metadata: {
    options: [
      {
        label: 'Round 2 holds: the note prints',
        description:
          'Close tutti-kkb.28 as it is; the START note is shown in real spec runs, as both live runs showed.',
      },
      {
        label: 'Round 1 holds: fix the note',
        description:
          'Change startBlock or main.ts so the note can’t depend on config.ticket, then verify again; more work for a line that already prints.',
      },
    ],
    recommended: 0,
    maintainer_only: true,
  },
  labels: ['human'],
  comments: [
    {
      id: 'c97c2738-713a-5a2f-aa5b-ac2d53db5173',
      issue_id: 'tutti-t6dv',
      author: 'Michael Michailidis',
      text: 'Response: Round 2 holds: the note prints. Close tutti-kkb.28 as it is.',
      created_at: '2026-10-26T18:33:15Z',
    },
  ],
  dependency_count: 0,
  dependent_count: 1,
  comment_count: 1,
}

/** The spike's feature, with design, notes and every common edge kind, and the links the spike cut. */
const feature = {
  _type: 'issue',
  id: 'tutti-kkb.46',
  title:
    '--overnight: a pre-flight checklist with its fixes, keeping the run awake and answering its questions',
  description: 'A run left going overnight can stop at 1am on some…',
  design: 'Rewritten 2026-10-25, when the maintainer asked fo…',
  acceptance_criteria: 'tutti --overnight runs the pre-flight checklist (e…',
  notes: 'Plan (worker, 2026-10-25): flags overnight/force-o…',
  status: 'closed',
  priority: 2,
  issue_type: 'feature',
  assignee: 'Michael Michailidis',
  owner: 'michael@noesis.solutions',
  created_at: '2026-10-21T12:10:51Z',
  created_by: 'Michael Michailidis',
  updated_at: '2026-10-25T20:52:18Z',
  started_at: '2026-10-25T20:09:14Z',
  closed_at: '2026-10-25T20:52:18Z',
  close_reason: '--overnight: flags, pre-flight checklist (pass/war…',
  labels: ['engine'],
  metadata: { files: ['src/overnight.ts'], spec: 'docs/spec.md' },
  dependencies: [
    dependency('tutti-kkb.46', 'tutti-kkb', 'parent-child'),
    dependency('tutti-kkb.46', 'tutti-kkb.15', 'blocks'),
    dependency('tutti-kkb.46', 'tutti-kkb.33', 'discovered-from'),
    dependency('tutti-kkb.46', 'tutti-t6dv', 'blocks'),
    dependency('tutti-kkb.46', 'tutti-kkb.15', 'waits-for'),
    dependency('tutti-kkb.46', 'orchestra-tnei.1', 'related'),
  ],
  dependency_count: 4,
  dependent_count: 3,
  comment_count: 0,
}

/** A plain record: the fields every record has, and `fields` over them. */
const record = (
  ticket: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> => ({
  _type: 'issue',
  id: ticket,
  title: `Ticket ${ticket}`,
  status: 'open',
  priority: 2,
  issue_type: 'task',
  created_at: '2026-10-20T09:00:00Z',
  updated_at: '2026-10-20T10:00:00Z',
  dependency_count: 0,
  dependent_count: 0,
  comment_count: 0,
  ...fields,
})

/** The file: one record a line, and a memory line the import skips. */
const jsonl = (records: ReadonlyArray<unknown>) =>
  `${records.map(each => JSON.stringify(each)).join('\n')}\n`

const sample = jsonl([
  record('tutti-kkb', { issue_type: 'epic', title: 'Overnight runs' }),
  record('tutti-kkb.15', {
    status: 'closed',
    close_reason: 'Done',
    dependencies: [dependency('tutti-kkb.15', 'tutti-kkb', 'parent-child')],
  }),
  record('tutti-kkb.33', {
    issue_type: 'spike',
    status: 'blocked',
    dependencies: [
      dependency('tutti-kkb.33', 'tutti-kkb', 'parent-child'),
      dependency('tutti-kkb.33', 'tutti-kkb.15', 'relates-to'),
    ],
  }),
  feature,
  question,
  { _type: 'memory', key: 'build', value: 'pnpm build' },
  record('tutti-h1', {
    labels: ['human'],
    status: 'closed',
    close_reason: 'Dismissed',
    metadata: {
      options: [
        { label: 'A', description: 'one' },
        { label: 'B', description: 'two' },
      ],
      recommended: 1,
    },
  }),
  record('tutti-h2', { labels: ['human'], status: 'hooked' }),
  record('tutti-d1', {
    defer_until: '2026-11-01T08:00:00Z',
    status: 'review',
    comments: [
      {
        id: 7,
        issue_id: 'tutti-d1',
        author: 'Michael Michailidis',
        text: 'An old comment.',
        created_at: '2026-10-20T09:30:00Z',
      },
    ],
  }),
])

const importSample = (text: string = sample) =>
  Effect.flatMap(WorkGraph, graph =>
    importBeads({ graph, text, actor: maintainer }),
  )

const show = (ticket: string) =>
  Effect.flatMap(WorkGraph, graph => graph.show(id(ticket)))

const edge = (from: string, to: string, kind: Edge['kind']) =>
  Edge.make({ from: id(from), to: id(to), kind })

const countRows = (table: string) =>
  Effect.flatMap(SqlClient.SqlClient, sql =>
    Effect.map(
      sql<{ readonly n: number }>`SELECT count(*) AS n FROM ${sql(table)}`,
      rows => rows[0]?.n ?? 0,
    ),
  )

describe('importBeads', () => {
  it.effect('maps every field of a feature, its IDs kept', () =>
    Effect.gen(function* () {
      const imported = yield* importSample()
      expect(imported.created).toBe(8)
      expect(imported.merged).toBe(0)
      const { ticket, labels, edges, notes } = yield* show('tutti-kkb.46')
      expect(ticket.type).toBe('feature')
      expect(ticket.title).toBe(feature.title)
      expect(ticket.description).toStrictEqual(Option.some(feature.description))
      expect(ticket.design).toStrictEqual(Option.some(feature.design))
      expect(ticket.acceptance).toStrictEqual(
        Option.some(feature.acceptance_criteria),
      )
      expect(ticket.status).toBe('closed')
      expect(ticket.resolution).toStrictEqual(Option.some('done'))
      expect(ticket.closeReason).toStrictEqual(
        Option.some(feature.close_reason),
      )
      expect(ticket.priority).toBe(2)
      expect(ticket.assignee).toStrictEqual(Option.none())
      expect(ticket.metadata.files).toStrictEqual(
        Option.some(['src/overnight.ts']),
      )
      expect(ticket.metadata.spec).toStrictEqual(Option.some('docs/spec.md'))
      expect(ticket.createdAt).toStrictEqual(at(feature.created_at))
      expect(ticket.updatedAt).toStrictEqual(at(feature.updated_at))
      expect(labels).toStrictEqual(['engine'])
      expect(
        notes.map(note => [note.id, note.body, note.author]),
      ).toStrictEqual([['tutti-kkb.46.notes', feature.notes, maintainer]])
      expect(notes[0]?.at).toStrictEqual(at(feature.updated_at))
      expect(edges).toStrictEqual(
        expect.arrayContaining([
          edge('tutti-kkb.15', 'tutti-kkb.46', 'blocks'),
          edge('tutti-t6dv', 'tutti-kkb.46', 'blocks'),
          edge('tutti-kkb.46', 'tutti-kkb.33', 'discovered_from'),
          edge('tutti-kkb', 'tutti-kkb.46', 'parent'),
        ]),
      )
      expect(edges).toHaveLength(4)
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect(
    'makes a human ticket with options a question, answered as Beads answered it',
    () =>
      Effect.gen(function* () {
        yield* importSample()
        const { ticket, labels, notes } = yield* show('tutti-t6dv')
        expect(ticket.type).toBe('question')
        expect(ticket.status).toBe('closed')
        expect(ticket.resolution).toStrictEqual(Option.some('answered'))
        const asked = Option.getOrThrow(ticket.question)
        const choices = Option.getOrThrow(asked.choices)
        expect(
          choices.options.map(({ label, tradeOff }) => [label, tradeOff]),
        ).toStrictEqual(
          question.metadata.options.map(({ label, description }) => [
            label,
            description,
          ]),
        )
        expect(choices.recommended).toBe(0)
        expect(asked.maintainerOnly).toBe(true)
        expect(asked.answer).toStrictEqual(
          Option.some(
            'Round 2 holds: the note prints. Close tutti-kkb.28 as it is.',
          ),
        )
        // The options are the question's now, not its metadata's.
        expect(Object.keys(ticket.metadata)).not.toContain('options')
        expect(labels).toStrictEqual(['human'])
        expect(notes.map(note => note.id)).toStrictEqual([
          'c97c2738-713a-5a2f-aa5b-ac2d53db5173',
        ])

        const dismissed = yield* show('tutti-h1')
        expect(dismissed.ticket.type).toBe('question')
        expect(dismissed.ticket.resolution).toStrictEqual(
          Option.some('cancelled'),
        )
        expect(
          Option.flatMap(dismissed.ticket.question, ({ answer }) => answer),
        ).toStrictEqual(Option.none())

        // A human ticket without options stays its own type.
        const plain = yield* show('tutti-h2')
        expect(plain.ticket.type).toBe('task')
        expect(plain.labels).toStrictEqual(['human'])
      }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('maps statuses and types the work graph lacks', () =>
    Effect.gen(function* () {
      yield* importSample()
      const spike = yield* show('tutti-kkb.33')
      expect(spike.ticket.type).toBe('task')
      expect(spike.labels).toStrictEqual(['spike'])
      expect(spike.ticket.status).toBe('open')
      expect(spike.edges).toContainEqual(
        edge('tutti-kkb.33', 'tutti-kkb.15', 'related'),
      )
      expect((yield* show('tutti-kkb')).ticket.type).toBe('epic')
      expect((yield* show('tutti-h2')).ticket.status).toBe('in_progress')
      const deferred = yield* show('tutti-d1')
      expect(deferred.ticket.status).toBe('deferred')
      expect(deferred.ticket.deferUntil).toStrictEqual(
        Option.some(at('2026-11-01T08:00:00Z')),
      )
      expect(deferred.ticket.metadata['beads_status']).toBe('review')
      expect(deferred.notes.map(note => [note.id, note.body])).toStrictEqual([
        ['tutti-d1.comment-7', 'An old comment.'],
      ])
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('says what it left out', () =>
    Effect.gen(function* () {
      const imported = yield* importSample()
      expect(imported.dropped).toStrictEqual([
        "tutti-kkb.46's waits-for link to tutti-kkb.15: the work graph has no such link",
        'tutti-kkb.46 is related to orchestra-tnei.1: neither the file nor the project has orchestra-tnei.1',
      ])
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('changes nothing when the same file is imported again', () =>
    Effect.gen(function* () {
      yield* importSample()
      const tables = ['tickets', 'labels', 'edges', 'notes', 'events']
      const before = yield* Effect.forEach(tables, countRows)
      const graph = yield* WorkGraph
      const tickets = yield* graph.list()
      const again = yield* importSample()
      expect(again.created).toBe(0)
      expect(again.merged).toBe(8)
      expect(again.changed).toStrictEqual([])
      expect(yield* Effect.forEach(tables, countRows)).toStrictEqual(before)
      expect(yield* graph.list()).toStrictEqual(tickets)
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect(
    'merges into a project with tickets: the file’s fields, the later status, the union of labels',
    () =>
      Effect.gen(function* () {
        const graph = yield* WorkGraph
        yield* importSample()
        yield* graph.update({
          id: id('tutti-kkb'),
          changes: { title: 'Renamed here', priority: 0 },
          actor: maintainer,
        })
        yield* graph.label({
          id: id('tutti-kkb'),
          label: 'local',
          actor: maintainer,
        })
        yield* graph.close({
          id: id('tutti-kkb.33'),
          resolution: 'done',
          actor: maintainer,
        })
        const changed = jsonl([
          record('tutti-kkb', {
            issue_type: 'epic',
            title: 'Overnight runs',
            labels: ['beads'],
          }),
          record('tutti-kkb.33', {
            issue_type: 'spike',
            status: 'open',
            description: 'Now described.',
          }),
          record('tutti-new', {
            dependencies: [dependency('tutti-new', 'tutti-kkb', 'blocks')],
          }),
        ])
        const imported = yield* importSample(changed)
        expect(imported.created).toBe(1)
        expect(imported.merged).toBe(2)
        expect(
          imported.changed.map(({ ticket, fields }) => [ticket, fields]),
        ).toStrictEqual([
          ['tutti-kkb', ['title', 'priority', 'labels']],
          ['tutti-kkb.33', ['description']],
        ])
        const epic = yield* show('tutti-kkb')
        expect(epic.ticket.title).toBe('Overnight runs')
        expect(epic.ticket.priority).toBe(2)
        expect(epic.labels).toStrictEqual(['beads', 'local'])
        // Closed here and open in the file: the close is later by §11.4's precedence.
        const spike = yield* show('tutti-kkb.33')
        expect(spike.ticket.status).toBe('closed')
        expect(spike.ticket.description).toStrictEqual(
          Option.some('Now described.'),
        )
        expect((yield* show('tutti-new')).edges).toStrictEqual([
          edge('tutti-kkb', 'tutti-new', 'blocks'),
        ])
        const history = yield* graph.history(id('tutti-kkb'))
        expect(history.slice(-2).map(({ change }) => change)).toStrictEqual([
          { _tag: 'updated', fields: ['title', 'priority', 'labels'] },
          {
            _tag: 'linked',
            edge: edge('tutti-kkb', 'tutti-new', 'blocks'),
          },
        ])
      }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('leaves a ticket the project deleted deleted', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      yield* importSample()
      yield* graph.delete({ id: id('tutti-h2'), actor: maintainer })
      const imported = yield* importSample()
      expect(imported.created).toBe(0)
      expect(imported.dropped).toContain(
        'tutti-h2: the project deleted it, so it stays deleted',
      )
      expect(
        yield* Effect.flip(graph.show(id('tutti-h2'))).pipe(
          Effect.map(error => error._tag),
        ),
      ).toBe('TicketNotFound')
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('drops a blocks edge that would close a cycle', () =>
    Effect.gen(function* () {
      const imported = yield* importSample(
        jsonl([
          record('bd-a', {
            dependencies: [dependency('bd-a', 'bd-b', 'blocks')],
          }),
          record('bd-b', {
            dependencies: [dependency('bd-b', 'bd-a', 'blocks')],
          }),
        ]),
      )
      expect(imported.dropped).toStrictEqual([
        'bd-a blocks bd-b: it would close a cycle',
      ])
      expect((yield* show('bd-a')).edges).toStrictEqual([
        edge('bd-b', 'bd-a', 'blocks'),
      ])
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('imports a long file in batches', () =>
    Effect.gen(function* () {
      const many = Array.from({ length: 450 }, (_, n) =>
        record(`bd-${n}`, {
          dependencies:
            n === 0 ? [] : [dependency(`bd-${n}`, `bd-${n - 1}`, 'blocks')],
        }),
      )
      const imported = yield* importSample(jsonl(many))
      expect(imported.created).toBe(450)
      expect(yield* countRows('edges')).toBe(449)
    }).pipe(Effect.provide(graphLayer)),
  )
})

describe('readBeads', () => {
  it.effect('refuses a file with every problem, by line, writing nothing', () =>
    Effect.gen(function* () {
      const text = [
        JSON.stringify(record('bd-1')),
        '{not json',
        JSON.stringify(record('BD_2')),
        JSON.stringify(record('bd-1')),
        JSON.stringify(record('bd-3', { priority: 7 })),
        JSON.stringify(record('bd-4', { title: '   ' })),
        JSON.stringify({ _type: 'issue', id: 'bd-5' }),
        '[1]',
      ].join('\n')
      const refused = yield* Effect.flip(readBeads(text))
      expect(refused).toBeInstanceOf(BeadsRefused)
      expect(
        refused.problems.map(problem => problem.split(':')[0]),
      ).toStrictEqual([
        'line 2',
        'line 3',
        'line 4',
        'line 5',
        'line 6',
        'line 7',
        'line 8',
      ])
      expect(refused.problems[0]).toBe('line 2: not JSON')
      expect(refused.problems[2]).toBe('line 4: bd-1 is on line 1 too')
      expect(refused.problems[6]).toBe('line 8: not a JSON object')

      const failed = yield* Effect.flip(importSample(text))
      expect(failed._tag).toBe('BeadsRefused')
      expect(yield* countRows('tickets')).toBe(0)
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect(
    'keeps a human ticket whose options don’t make a question as it is, and says so',
    () =>
      Effect.gen(function* () {
        const { tickets, dropped } = yield* readBeads(
          jsonl([
            record('bd-q', {
              labels: ['human'],
              metadata: {
                options: [{ label: 'Only one', description: 'too few' }],
                recommended: 0,
              },
            }),
          ]),
        )
        expect(tickets[0]?.ticket.type).toBe('task')
        expect(tickets[0]?.ticket.metadata['options']).toStrictEqual([
          { label: 'Only one', description: 'too few' },
        ])
        expect(dropped).toHaveLength(1)
        expect(dropped[0]).toMatch(
          /^bd-q: labelled human, but its options don't make a question \(.*\); kept as a task$/su,
        )
      }),
  )
})
