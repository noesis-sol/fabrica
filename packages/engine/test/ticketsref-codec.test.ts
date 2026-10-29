import { DateTime, Effect, Option, Schema } from 'effect'
import * as fc from 'fast-check'

import { describe, expect, it } from '@effect/vitest'
import {
  EngineId,
  LabelName,
  RunId,
  Ticket,
  TicketId,
} from '@fabrica/contracts'

import {
  Hlc,
  HlcFromString,
  HlcOrder,
  LayoutTooNew,
  RecordTooNew,
  RecordUndecodable,
  RunLease,
  TicketFile,
  TicketsMeta,
  Tombstone,
  byClockedField,
  canonicalJson,
  canonicalTicketFile,
  decodeLease,
  decodeMeta,
  decodeTicketFile,
  decodeTombstone,
  encodeLease,
  encodeMeta,
  encodeTicketFile,
  encodeTombstone,
  tick,
  zero,
} from '../src/ticketsref'
import { engineArb, hlcArb, ticketFileArb } from './ticketsref-arbitraries'

// The tickets ref's canonical files and clocks (spec §11.3, §11.7): a file round-trips and encodes
// stably whatever order its lists were in, its text is canonical, a newer record or layout is refused,
// and a clock always moves past what its engine has seen.

const run = Effect.runSync

const engine = EngineId.make('fe-laptop')
const clock = new Hlc({ wall: 1_793_275_200_000, counter: 0, engine })
const at = DateTime.makeUnsafe('2026-10-29T12:00:00.000Z')

const smallFile = new TicketFile({
  ticket: new Ticket({
    id: TicketId.make('fa-a1b2'),
    type: 'task',
    title: 'Add the tickets ref',
    description: Option.none(),
    design: Option.none(),
    acceptance: Option.none(),
    status: 'open',
    resolution: Option.none(),
    priority: 2,
    deferUntil: Option.none(),
    assignee: Option.none(),
    model: Option.none(),
    metadata: {
      files: Option.none(),
      spec: Option.none(),
      predicted_files: Option.none(),
      result_kind: Option.none(),
    },
    result: Option.none(),
    question: Option.none(),
    mergedCommit: Option.none(),
    closeReason: Option.none(),
    createdAt: at,
    updatedAt: at,
  }),
  labels: [LabelName.make('solo'), LabelName.make('area-engine')],
  edges: {
    blocks: [TicketId.make('fa-c3d4'), TicketId.make('fa-b2c3')],
    discovered_from: [],
    parent: [],
    related: [],
  },
  notes: [],
  clocks: { ...byClockedField(() => clock), reopened: Option.none() },
})

/** A file's lists reversed and repeated: the same state, written in another order. */
const shuffled = (file: TicketFile): TicketFile =>
  new TicketFile({
    ...file,
    labels: [...file.labels, ...file.labels].reverse(),
    edges: {
      blocks: [...file.edges.blocks].reverse(),
      discovered_from: [
        ...file.edges.discovered_from,
        ...file.edges.discovered_from,
      ],
      parent: [...file.edges.parent].reverse(),
      related: [...file.edges.related].reverse(),
    },
    notes: [...file.notes].reverse(),
  })

describe('canonical JSON', () => {
  it('sorts keys by code point, indents by two spaces and ends with a newline', () => {
    // UTF-16 puts the astral U+1F600 (a surrogate pair from 0xD83D) before U+FFFD; code points don't.
    expect(
      canonicalJson({
        '\u{1F600}': 1,
        '�': 2,
        b: [],
        a: {},
        '10': 3,
        '9': [true, null],
      }),
    ).toBe(
      [
        '{',
        '  "10": 3,',
        '  "9": [',
        '    true,',
        '    null',
        '  ],',
        '  "a": {},',
        '  "b": [],',
        '  "�": 2,',
        '  "\u{1F600}": 1',
        '}',
        '',
      ].join('\n'),
    )
  })

  it("refuses what JSON can't hold", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(TypeError)
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError)
  })
})

describe('ticket files', () => {
  it('writes every field, lists sorted and each once, times in UTC with milliseconds', () => {
    const text = run(encodeTicketFile(shuffled(smallFile)))
    expect(text).toBe(run(encodeTicketFile(smallFile)))
    const json = JSON.parse(text)
    expect(Object.keys(json)).toEqual([
      'acceptance',
      'assignee',
      'clocks',
      'closeReason',
      'createdAt',
      'deferUntil',
      'description',
      'design',
      'edges',
      'id',
      'labels',
      'mergedCommit',
      'metadata',
      'model',
      'notes',
      'priority',
      'question',
      'resolution',
      'result',
      'status',
      'title',
      'type',
      'updatedAt',
      'v',
    ])
    expect(json.labels).toEqual(['area-engine', 'solo'])
    expect(json.edges).toEqual({
      blocks: ['fa-b2c3', 'fa-c3d4'],
      discovered_from: [],
      parent: [],
      related: [],
    })
    expect(json.createdAt).toBe('2026-10-29T12:00:00.000Z')
    expect(json.clocks.title).toBe('1793275200000:0:fe-laptop')
    expect(json.clocks.reopened).toBeNull()
    expect(json.v).toBe(1)
    expect(text).toContain(
      '\n  "edges": {\n    "blocks": [\n      "fa-b2c3",\n      "fa-c3d4"\n    ],\n',
    )
    expect(text.endsWith('}\n')).toBe(true)
    expect(text).not.toContain('\r')
  })

  it('round-trips: a file decodes to its canonical form (property)', () => {
    fc.assert(
      fc.property(ticketFileArb, file => {
        const decoded = run(decodeTicketFile(run(encodeTicketFile(file))))
        expect(decoded).toEqual(canonicalTicketFile(file))
      }),
    )
  })

  it("encodes stably: the same state is the same bytes, whatever its lists' order (property)", () => {
    fc.assert(
      fc.property(ticketFileArb, file => {
        const text = run(encodeTicketFile(file))
        expect(run(encodeTicketFile(shuffled(file)))).toBe(text)
        expect(run(encodeTicketFile(run(decodeTicketFile(text))))).toBe(text)
        expect(run(decodeTicketFile(new TextEncoder().encode(text)))).toEqual(
          run(decodeTicketFile(text)),
        )
      }),
    )
  })

  it.effect('refuses a record newer than the engine reads', () =>
    Effect.gen(function* () {
      const json = JSON.parse(yield* encodeTicketFile(smallFile))
      const error = yield* Effect.flip(
        decodeTicketFile(canonicalJson({ ...json, v: 2 })),
      )
      expect(error).toEqual(
        new RecordTooNew({ kind: 'ticket', version: 2, newest: 1 }),
      )
    }),
  )

  it.effect('refuses a file that is not UTF-8, not JSON, or not a ticket', () =>
    Effect.gen(function* () {
      const notUtf8 = yield* Effect.flip(
        decodeTicketFile(new Uint8Array([0x7b, 0xff, 0x7d])),
      )
      expect(notUtf8).toEqual(
        new RecordUndecodable({ kind: 'ticket', issue: 'not UTF-8' }),
      )
      const notJson = yield* Effect.flip(decodeTicketFile('{'))
      expect(notJson._tag).toBe('RecordUndecodable')
      const json = JSON.parse(yield* encodeTicketFile(smallFile))
      const blankTitle = yield* Effect.flip(
        decodeTicketFile(canonicalJson({ ...json, title: ' ' })),
      )
      expect(blankTitle._tag).toBe('RecordUndecodable')
      const noMillis = yield* Effect.flip(
        decodeTicketFile(
          canonicalJson({ ...json, createdAt: '2026-10-29T12:00:00Z' }),
        ),
      )
      expect(noMillis._tag).toBe('RecordUndecodable')
      const { model: _model, ...withoutModel } = json
      const missingField = yield* Effect.flip(
        decodeTicketFile(canonicalJson(withoutModel)),
      )
      expect(missingField._tag).toBe('RecordUndecodable')
      const linkedToItself = yield* Effect.flip(
        decodeTicketFile(
          canonicalJson({
            ...json,
            edges: { ...json.edges, related: ['fa-a1b2'] },
          }),
        ),
      )
      expect(linkedToItself._tag).toBe('RecordUndecodable')
      const questionlessQuestion = yield* Effect.flip(
        decodeTicketFile(canonicalJson({ ...json, type: 'question' })),
      )
      expect(questionlessQuestion._tag).toBe('RecordUndecodable')
    }),
  )
})

describe('tombstones, meta.json and lease.json', () => {
  it.effect('round-trip', () =>
    Effect.gen(function* () {
      const tombstone = new Tombstone({ id: TicketId.make('fa-a1b2'), clock })
      const tombstoneText = yield* encodeTombstone(tombstone)
      expect(tombstoneText).toBe(
        '{\n  "clock": "1793275200000:0:fe-laptop",\n  "id": "fa-a1b2",\n  "v": 1\n}\n',
      )
      expect(yield* decodeTombstone(tombstoneText)).toEqual(tombstone)

      const meta = new TicketsMeta({ layout: 1, prefix: 'fa' })
      const metaText = yield* encodeMeta(meta)
      expect(metaText).toBe(
        '{\n  "layout": 1,\n  "prefix": "fa",\n  "v": 1\n}\n',
      )
      expect(yield* decodeMeta(metaText)).toEqual(meta)

      const lease = new RunLease({
        engine,
        name: 'laptop',
        host: 'mm-mbp.local',
        run: RunId.make('run-1'),
        startedAt: at,
        renewedAt: at,
        expiresAt: DateTime.add(at, { minutes: 5 }),
      })
      const leaseText = yield* encodeLease(lease)
      expect(JSON.parse(leaseText)).toEqual({
        engine: 'fe-laptop',
        expiresAt: '2026-10-29T12:05:00.000Z',
        host: 'mm-mbp.local',
        name: 'laptop',
        renewedAt: '2026-10-29T12:00:00.000Z',
        run: 'run-1',
        startedAt: '2026-10-29T12:00:00.000Z',
        v: 1,
      })
      expect(yield* decodeLease(leaseText)).toEqual(lease)
    }),
  )

  it.effect(
    'refuse a layout newer than the engine knows, and a prefix no ticket ID starts with',
    () =>
      Effect.gen(function* () {
        const newer = yield* Effect.flip(
          decodeMeta(canonicalJson({ layout: 2, prefix: 'fa', v: 1 })),
        )
        expect(newer).toEqual(new LayoutTooNew({ layout: 2 }))
        const badPrefix = yield* Effect.flip(
          decodeMeta(canonicalJson({ layout: 1, prefix: 'Fa', v: 1 })),
        )
        expect(badPrefix._tag).toBe('RecordUndecodable')
      }),
  )
})

describe('hybrid logical clocks', () => {
  const decodeHlc = Schema.decodeUnknownSync(HlcFromString)
  const encodeHlc = Schema.encodeSync(HlcFromString)

  it('are written <wall>:<counter>:<engine> and read back (property)', () => {
    fc.assert(
      fc.property(hlcArb, hlc => {
        expect(decodeHlc(encodeHlc(hlc))).toEqual(hlc)
      }),
    )
    expect(decodeHlc('5:2:fe:with:colons')).toEqual(
      new Hlc({ wall: 5, counter: 2, engine: EngineId.make('fe:with:colons') }),
    )
    expect(() => decodeHlc('05:0:fe-a')).toThrow()
    expect(() => decodeHlc('5:0:')).toThrow()
  })

  it('order by wall time, then counter, then engine ID', () => {
    const at = (wall: number, counter: number, id: string) =>
      new Hlc({ wall, counter, engine: EngineId.make(id) })
    expect(HlcOrder(at(2, 0, 'a'), at(1, 9, 'z'))).toBe(1)
    expect(HlcOrder(at(1, 1, 'a'), at(1, 0, 'z'))).toBe(1)
    expect(HlcOrder(at(1, 1, 'b'), at(1, 1, 'a'))).toBe(1)
    expect(HlcOrder(at(1, 1, 'a'), at(1, 1, 'a'))).toBe(0)
  })

  it('issue a clock past the last one seen, even with the wall clock behind (property)', () => {
    fc.assert(
      fc.property(
        hlcArb,
        engineArb,
        fc.integer({ min: 0, max: 2_000_000_000_000 }),
        (last, engine, now) => {
          const next = tick({ engine, last, now })
          expect(HlcOrder(next, last)).toBe(1)
          expect(next.engine).toBe(engine)
          expect(next.wall).toBe(Math.max(now, last.wall))
        },
      ),
    )
    const seen = new Hlc({
      wall: 1000,
      counter: 4,
      engine: EngineId.make('fe-z'),
    })
    expect(tick({ engine, last: seen, now: 10 })).toEqual(
      new Hlc({ wall: 1000, counter: 5, engine }),
    )
    expect(tick({ engine, last: seen, now: 2000 })).toEqual(
      new Hlc({ wall: 2000, counter: 0, engine }),
    )
    expect(
      HlcOrder(tick({ engine, last: zero(engine), now: 0 }), zero(engine)),
    ).toBe(1)
  })
})
