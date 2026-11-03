import { Effect, Option, Ref } from 'effect'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import { ProjectId, RunId, TicketId } from '@fabrica/contracts'

import { handBackFields, makeHandBackTally } from '../src/run/hand-backs'
import { Telemetry, TelemetryRow } from '../src/telemetry'
import {
  binFolder,
  file,
  ofKind,
  project,
  runOf,
  setUpRuns,
  settings,
} from './run-harness'

// A ticket's hand-backs counted on the records that end its part in the run (spec §13.7, §13.12, H65):
// `closed`, `deferred` and `ticket_end` carry `hand_backs`, each kind as the merge queue's book counted
// it, and each hand-back is a telemetry row tied to its project, run and ticket.

beforeAll(setUpRuns)

const project1 = ProjectId.make('p1')
const run1 = RunId.make('run-1')
const ticket = TicketId.make('fa-1')
const other = TicketId.make('fa-2')

describe('the hand-back tally', () => {
  it.effect(
    'counts each kind as its attempts give it, and records a row for each hand-back',
    () =>
      Effect.gen(function* () {
        const rows = yield* Ref.make<ReadonlyArray<TelemetryRow>>([])
        const tally = yield* makeHandBackTally({
          project: project1,
          run: run1,
        }).pipe(
          Effect.provideService(
            Telemetry,
            Telemetry.of({
              record: row => Ref.update(rows, all => [...all, row]),
              flush: Effect.void,
            }),
          ),
        )
        expect(yield* tally.of(ticket)).toEqual(Option.none())
        yield* tally.given({ ticket, kind: 'resolve', attempt: 1 })
        yield* tally.given({ ticket, kind: 'fix', attempt: 1 })
        yield* tally.given({ ticket, kind: 'fix', attempt: 2 })
        expect(yield* tally.of(ticket)).toEqual(
          Option.some({ resolve: 1, fix: 2 }),
        )
        expect(yield* tally.of(other)).toEqual(Option.none())
        expect(yield* Ref.get(rows)).toEqual([
          TelemetryRow.HandBack({
            project: project1,
            run: run1,
            ticket,
            kind: 'resolve',
          }),
          TelemetryRow.HandBack({
            project: project1,
            run: run1,
            ticket,
            kind: 'fix',
          }),
          TelemetryRow.HandBack({
            project: project1,
            run: run1,
            ticket,
            kind: 'fix',
          }),
        ])
      }),
  )

  it('leaves hand_backs out of a record where the ticket had none', () => {
    expect(handBackFields(Option.none())).toEqual({})
    expect(handBackFields(Option.some({ resolve: 0, fix: 1 }))).toEqual({
      hand_backs: { resolve: 0, fix: 1 },
    })
  })
})

describe("a run's hand-back counts", () => {
  it.effect(
    "puts a ticket's hand-backs on its closed and ticket_end records, and none on a ticket never handed back",
    () =>
      Effect.gen(function* () {
        // The merge check fails while broken.txt has one line: the worker's first go writes one, its
        // resumed session a second; the other ticket writes a file the check doesn't read.
        const check = join(binFolder(), 'check-broken-counts')
        writeFileSync(
          check,
          '#!/bin/sh\nif [ -f broken.txt ] && [ "$(wc -l < broken.txt)" -lt 2 ]; then echo "error: broken.txt has one line"; exit 1; fi\necho passing\n',
        )
        chmodSync(check, 0o755)
        const fixture = project({ ...settings, check_fast: check })
        const { end, events, made } = yield* runOf(
          fixture,
          Effect.all([
            file('Mend it', 'finish broken.txt'),
            file('Leave it', 'finish fine.txt'),
          ]),
        )
        const [mended, left] = made
        expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
        const closed = ofKind(events, 'closed')
        expect(closed.find(record => record.ticket === mended.id)).toEqual(
          expect.objectContaining({ hand_backs: { resolve: 0, fix: 1 } }),
        )
        expect(
          closed.find(record => record.ticket === left.id),
        ).not.toHaveProperty('hand_backs')
        const ends = ofKind(events, 'ticket_end')
        expect(ends.find(record => record.ticket === mended.id)).toEqual(
          expect.objectContaining({
            outcome: 'merged',
            hand_backs: { resolve: 0, fix: 1 },
          }),
        )
        expect(
          ends.find(record => record.ticket === left.id),
        ).not.toHaveProperty('hand_backs')
      }),
  )
})
