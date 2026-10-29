import { Effect, Exit, Option, Schema } from 'effect'

import { describe, expect, it } from '@effect/vitest'

import {
  CommitHash,
  EngineId,
  MessageId,
  ProjectId,
  RunId,
  SessionId,
  TicketId,
} from './ids'

const sha1 = 'eda8c7a0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6'
const sha256 = `${sha1}0123456789abcdef01234567`

describe('TicketId', () => {
  it.each(['fa-a1b2', 'fab-mgi', 'fab-mgi.1', 'fab-mgi.1.12', 'my-app-x9'])(
    'is made from %s',
    text => {
      expect(TicketId.make(text)).toBe(text)
    },
  )

  it.each(['', 'fab', 'Fab-mgi', 'fab-mgi.', 'fab-mgi.0', '-mgi', 'fab mgi'])(
    'is not made from %j',
    text => {
      expect(Option.isNone(TicketId.makeOption(text))).toBe(true)
      expect(() => TicketId.make(text)).toThrow()
    },
  )
})

describe('CommitHash', () => {
  it.each([sha1, sha256])('is made from a full hash', text => {
    expect(CommitHash.make(text)).toBe(text)
  })

  it.each(['', 'eda8c7a', sha1.toUpperCase(), `${sha1}0`, `${sha1.slice(1)}g`])(
    'is not made from %j',
    text => {
      expect(Option.isNone(CommitHash.makeOption(text))).toBe(true)
    },
  )
})

// Every opaque ID is made the same way: its schema's constructors, typed by its brand.
const opaqueIds: ReadonlyArray<
  readonly [
    name: string,
    make: (text: string) => string,
    makeOption: (text: string) => Option.Option<string>,
  ]
> = [
  ['SessionId', SessionId.make, SessionId.makeOption],
  ['MessageId', MessageId.make, MessageId.makeOption],
  ['ProjectId', ProjectId.make, ProjectId.makeOption],
  ['RunId', RunId.make, RunId.makeOption],
  ['EngineId', EngineId.make, EngineId.makeOption],
]

describe.each(opaqueIds)('%s', (_name, make, makeOption) => {
  it('is made from text with no whitespace', () => {
    expect(make('0c3e9f2a-7b1d-4e5f-9a8b-1c2d3e4f5a6b')).toBe(
      '0c3e9f2a-7b1d-4e5f-9a8b-1c2d3e4f5a6b',
    )
  })

  it.each(['', ' ', 'a b', 'a\n'])('is not made from %j', text => {
    expect(Option.isNone(makeOption(text))).toBe(true)
  })
})

describe('decoding', () => {
  it.effect('makes an ID where it is read', () =>
    Effect.gen(function* () {
      const id = yield* Schema.decodeUnknownEffect(TicketId)('fab-mgi.1')
      expect(id).toBe('fab-mgi.1')
    }),
  )

  it.effect('fails on text that is not one', () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Schema.decodeUnknownEffect(CommitHash)('not a hash'),
      )
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})

describe('brands', () => {
  it('keeps IDs of different kinds apart', () => {
    const ticket = TicketId.make('fab-mgi.1')
    const run = RunId.make('fab-mgi.1')
    // @ts-expect-error a RunId is not a TicketId
    const asTicket: TicketId = run
    // @ts-expect-error plain text is not a TicketId
    const fromText: TicketId = 'fab-mgi.1'
    expect([ticket, asTicket, fromText]).toEqual([
      'fab-mgi.1',
      'fab-mgi.1',
      'fab-mgi.1',
    ])
  })
})
