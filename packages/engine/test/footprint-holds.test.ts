import { DateTime, Effect, Option, Schema } from 'effect'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  type LabelName,
  Phase,
  type RunEvent,
  Ticket,
  TicketId,
  TicketMetadata,
  factsOf,
} from '@fabrica/contracts'

import {
  type Footprint,
  branchFootprint,
  makeApartFiles,
  makeRepository,
  noMentions,
  ticketFootprint,
} from '../src/footprints'
import {
  type Gated,
  type ReadyTicket,
  type RunTicket,
  gate,
} from '../src/run/footprints-gate'
import {
  binFolder,
  file,
  ofKind,
  project,
  runOf,
  setUpRuns,
  settings,
} from './run-harness'

// The footprints gate (spec §13.4, H70, H81): a ready ticket overlapping one in progress is held
// back with its reason in words, and goes once that one has merged; every ready ticket waits while a
// solo ticket runs or waits first in line; a ticket past its work holds on its branch's files alone,
// and on no slot. First the gate's rule on given footprints, then whole runs.

const repository = makeRepository([
  'src/x.ts',
  'src/y.ts',
  'src/z.ts',
  'CHANGELOG.md',
])
const declared = { declares: () => false }
const apart = makeApartFiles({
  unioned: ['CHANGELOG.md'],
  checks: [],
  shared: [],
})

const id = (n: number) => TicketId.make(`fa-${n}`)

const ticketOf = (n: number, files: ReadonlyArray<string>) =>
  new Ticket({
    id: id(n),
    type: 'task',
    title: `Ticket ${n}`,
    description: Option.none(),
    design: Option.none(),
    acceptance: Option.none(),
    status: 'open',
    resolution: Option.none(),
    priority: 2,
    deferUntil: Option.none(),
    assignee: Option.none(),
    model: Option.none(),
    metadata: Schema.decodeUnknownSync(TicketMetadata)({ files }),
    result: Option.none(),
    question: Option.none(),
    mergedCommit: Option.none(),
    closeReason: Option.none(),
    createdAt: DateTime.makeUnsafe(0),
    updatedAt: DateTime.makeUnsafe(0),
  })

const footprintOf = (
  ticket: Ticket,
  labels: ReadonlyArray<LabelName> = [],
): Footprint =>
  ticketFootprint({ ticket: { ticket, labels }, repository, declared })

const ready = (
  n: number,
  files: ReadonlyArray<string>,
  labels: ReadonlyArray<LabelName> = [],
): ReadyTicket => {
  const ticket = ticketOf(n, files)
  return {
    ticket,
    footprint: footprintOf(ticket, labels),
    solo: labels.includes('solo'),
  }
}

const working = Phase.cases.working.make({})
const waitingToMerge = Phase.cases.waiting_to_merge.make({ place: 1 })
const merging = Phase.cases.merging.make({ step: 'check' })

const inRun = (
  n: number,
  phase: Phase,
  files: ReadonlyArray<string>,
  labels: ReadonlyArray<LabelName> = [],
): RunTicket => ({
  ticket: id(n),
  phase,
  footprint: footprintOf(ticketOf(n, files), labels),
  solo: labels.includes('solo'),
})

const gated = (input: {
  readonly ready: ReadonlyArray<ReadyTicket>
  readonly running?: ReadonlyArray<RunTicket>
  readonly free?: number
  readonly concurrent?: number
}): Gated =>
  gate({
    ready: input.ready,
    running: input.running ?? [],
    free: input.free ?? 4,
    concurrent: input.concurrent ?? 4,
    mentions: noMentions,
    apart,
  })

const takenIds = (result: Gated) => result.take.map(({ ticket }) => ticket.id)

describe('the footprints gate', () => {
  it('holds a ready ticket overlapping a running one, and lets it go once that one has merged', () => {
    const held = ready(2, ['src/x.ts'])
    const running = [inRun(1, working, ['src/x.ts'])]
    const first = gated({ ready: [held, ready(3, ['src/y.ts'])], running })
    expect(takenIds(first)).toEqual([id(3)])
    expect(first.held).toEqual([
      {
        ticket: id(2),
        reason: 'overlap',
        detail: 'touches src/x.ts, like running fa-1',
      },
    ])
    // fa-1 merged: the run has it no more.
    const after = gated({ ready: [held], running: [] })
    expect(takenIds(after)).toEqual([id(2)])
    expect(after.held).toEqual([])
  })

  it.each([
    ['running', working, 'touches src/x.ts, like running fa-1'],
    ['merging', merging, 'touches src/x.ts, like merging fa-1'],
    [
      'waiting to merge',
      waitingToMerge,
      'touches src/x.ts, like fa-1 waiting to merge',
    ],
  ] as const)(
    'says a ticket held by one %s in words, as the log says it',
    (_, phase, detail) => {
      // A ticket past its work holds on its branch's files: here, the one it named.
      const footprint = factsOf(phase).pastWork
        ? branchFootprint({ labels: [], changed: ['src/x.ts'], repository })
        : footprintOf(ticketOf(1, ['src/x.ts']))
      const result = gated({
        ready: [ready(2, ['src/x.ts'])],
        running: [{ ticket: id(1), phase, footprint, solo: false }],
      })
      expect(result.held.map(entry => entry.detail)).toEqual([detail])
    },
  )

  it('names an area, and a ticket dispatched before it in the same look', () => {
    const area = gated({
      ready: [ready(2, ['src/y.ts'], ['area:ui'])],
      running: [inRun(1, working, ['src/z.ts'], ['area:ui'])],
    })
    expect(area.held.map(entry => entry.detail)).toEqual([
      'touches the area area:ui, like running fa-1',
    ])
    const same = gated({
      ready: [ready(2, ['src/x.ts']), ready(3, ['src/x.ts'])],
    })
    expect(takenIds(same)).toEqual([id(2)])
    expect(same.held.map(entry => entry.detail)).toEqual([
      'touches src/x.ts, like running fa-2',
    ])
  })

  it('lets a ticket sharing only a file git merges by union go, its likely conflict noted', () => {
    const result = gated({
      ready: [ready(2, ['CHANGELOG.md'])],
      running: [inRun(1, working, ['CHANGELOG.md'])],
    })
    expect(takenIds(result)).toEqual([id(2)])
    expect(result.take[0]?.likely).toEqual([
      { with: id(1), files: ['CHANGELOG.md'] },
    ])
  })

  it('holds every ready ticket while a solo ticket runs', () => {
    const result = gated({
      ready: [ready(2, ['src/y.ts']), ready(3, ['src/z.ts'])],
      running: [inRun(9, working, ['src/x.ts'], ['solo'])],
    })
    expect(takenIds(result)).toEqual([])
    expect(result.held).toEqual([
      {
        ticket: id(2),
        reason: 'solo',
        detail: 'waits for the solo ticket fa-9',
      },
      {
        ticket: id(3),
        reason: 'solo',
        detail: 'waits for the solo ticket fa-9',
      },
    ])
    expect(result.solo).toEqual(Option.some({ ticket: id(9), next: false }))
  })

  it('starts a solo ticket first in line alone, and holds the rest behind it', () => {
    const queue = [ready(9, ['src/x.ts'], ['solo']), ready(2, ['src/y.ts'])]
    const alone = gated({ ready: queue })
    expect(takenIds(alone)).toEqual([id(9)])
    expect(alone.held).toEqual([
      {
        ticket: id(2),
        reason: 'solo',
        detail: 'waits for the solo ticket fa-9',
      },
    ])
    // Another ticket still in progress: the solo ticket waits for it, and the rest wait for the solo ticket.
    const waits = gated({
      ready: queue,
      running: [inRun(1, waitingToMerge, ['src/z.ts'])],
    })
    expect(takenIds(waits)).toEqual([])
    expect(waits.held).toEqual([
      {
        ticket: id(9),
        reason: 'solo',
        detail: 'waits to run alone, after fa-1',
      },
      {
        ticket: id(2),
        reason: 'solo',
        detail: 'waits for the solo ticket fa-9',
      },
    ])
    expect(waits.solo).toEqual(Option.some({ ticket: id(9), next: true }))
  })

  it('lets the tickets ahead of a solo ticket go, the solo ticket next', () => {
    const result = gated({
      ready: [
        ready(2, ['src/y.ts']),
        ready(9, ['src/x.ts'], ['solo']),
        ready(3, ['src/z.ts']),
      ],
    })
    expect(takenIds(result)).toEqual([id(2)])
    expect(result.held).toEqual([
      {
        ticket: id(9),
        reason: 'solo',
        detail: 'waits to run alone, after fa-2',
      },
      {
        ticket: id(3),
        reason: 'solo',
        detail: 'waits for the solo ticket fa-9',
      },
    ])
  })

  it('holds on the files a ticket past its work changed, not those it named', () => {
    // fa-1 named src/x.ts and src/y.ts, and its branch changed src/y.ts alone.
    const past: RunTicket = {
      ticket: id(1),
      phase: waitingToMerge,
      footprint: branchFootprint({
        labels: [],
        changed: ['src/y.ts'],
        repository,
      }),
      solo: false,
    }
    const result = gated({
      ready: [ready(2, ['src/x.ts']), ready(3, ['src/y.ts'])],
      running: [past],
    })
    expect(takenIds(result)).toEqual([id(2)])
    expect(result.held.map(entry => entry.detail)).toEqual([
      'touches src/y.ts, like fa-1 waiting to merge',
    ])
  })

  it('takes no slot for a ticket past its work, but no more than concurrent such at once', () => {
    const past = [
      inRun(1, waitingToMerge, ['src/x.ts']),
      inRun(4, merging, ['src/x.ts']),
    ]
    const one = gated({
      ready: [ready(2, ['src/y.ts'])],
      running: past.slice(0, 1),
      free: 2,
      concurrent: 2,
    })
    expect(takenIds(one)).toEqual([id(2)])
    const two = gated({
      ready: [ready(2, ['src/y.ts'])],
      running: past,
      free: 2,
      concurrent: 2,
    })
    expect(takenIds(two)).toEqual([])
    expect(two.held).toEqual([])
  })

  it('takes no more than the free slots, holding by overlap all the same', () => {
    const result = gated({
      ready: [
        ready(2, ['src/y.ts']),
        ready(3, ['src/z.ts']),
        ready(5, ['src/x.ts']),
      ],
      running: [inRun(1, working, ['src/x.ts'])],
      free: 1,
    })
    expect(takenIds(result)).toEqual([id(2)])
    expect(result.held.map(entry => entry.ticket)).toEqual([id(5)])
  })
})

// ---- Whole runs ---------------------------------------------------------------------------------

/**
 * A merge check that passes once another ticket's worktree stands beside its own (or one did): a
 * ticket's merge waits until the run dispatched another, so a dispatch while it is past its work is
 * seen before its merge. It gives up after 30 seconds and passes, so a run that never dispatched one
 * shows as a dispatch after the merge.
 */
const CHECK_AFTER_ANOTHER = `#!/bin/sh
dir=$(dirname "$PWD")
seen="$(dirname "$dir")/another-seen"
i=0
while [ $i -lt 300 ] && [ ! -e "$seen" ]; do
  for d in "$dir"/*/; do
    if [ -d "$d" ] && [ "\${d%/}" != "$PWD" ]; then touch "$seen"; break; fi
  done
  [ -e "$seen" ] && break
  sleep 0.1
  i=$((i + 1))
done
echo passing
`

beforeAll(() => {
  setUpRuns()
  const check = join(binFolder(), 'check-after-another')
  writeFileSync(check, CHECK_AFTER_ANOTHER)
  chmodSync(check, 0o755)
})

const metadataOf = (files: ReadonlyArray<string>) =>
  Schema.decodeUnknownSync(TicketMetadata)({ files })

/** Each ticket's phase records, in order: where it went, and why. */
const phasesOf = (events: ReadonlyArray<RunEvent>, ticket: TicketId) =>
  ofKind(events, 'phase')
    .filter(event => event.ticket === ticket)
    .map(({ to, cause }) => ({ to, cause }))

const indexOf = (
  events: ReadonlyArray<RunEvent>,
  kind: 'dispatch' | 'closed',
  ticket: TicketId,
) =>
  events.findIndex(
    event =>
      event.kind === kind && 'ticket' in event && event.ticket === ticket,
  )

const textsOf = (events: ReadonlyArray<RunEvent>) =>
  events.flatMap(event =>
    'text' in event && typeof event.text === 'string' ? [event.text] : [],
  )

describe('a run with footprints', () => {
  it.effect(
    'holds a ticket overlapping a running one, in words, and dispatches it once that one merged',
    () =>
      Effect.gen(function* () {
        const fixture = project(settings, { 'src/x.ts': 'x\n' })
        const {
          end,
          events,
          ticketOf: shownOf,
          made,
        } = yield* runOf(
          fixture,
          Effect.all([
            file('Change x first', 'finish src/x.ts', {
              metadata: metadataOf(['src/x.ts']),
            }),
            file('Change x next', 'finish src/x.ts', {
              metadata: metadataOf(['src/x.ts']),
            }),
          ]),
        )
        expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
        const dispatches = ofKind(events, 'dispatch')
        expect(dispatches).toHaveLength(2)
        const [first, second] = dispatches.map(({ ticket }) => ticket)
        if (first === undefined || second === undefined)
          throw new Error('two dispatches')
        const words = `touches src/x.ts, like running ${first}`
        const phases = phasesOf(events, second)
        const dispatchedAt = phases.findIndex(({ to }) => to === 'working')
        expect(phases.slice(0, 2)).toEqual([
          { to: 'queued', cause: 'ready' },
          { to: 'held_back', cause: words },
        ])
        // Held until it went, its reason following the first as it moved on (`fa-1 waiting to merge`).
        expect(phases[dispatchedAt]).toEqual({
          to: 'working',
          cause: 'dispatched',
        })
        expect(
          phases
            .slice(1, dispatchedAt)
            .every(
              ({ to, cause }) =>
                to === 'held_back' &&
                cause.startsWith('touches src/x.ts, like '),
            ),
        ).toBe(true)
        expect(textsOf(events)).toContain(`  ${second} held back: ${words}`)
        expect(textsOf(events)).toContain(`  ${first} footprint: src/x.ts`)
        // Held until the first merged: dispatched after its `closed`, from the Base it merged into.
        expect(indexOf(events, 'closed', first)).toBeLessThan(
          indexOf(events, 'dispatch', second),
        )
        expect(dispatches[0]).toEqual(
          expect.objectContaining({
            held: 1,
            held_by: { overlap: 1 },
          }),
        )
        for (const ticket of made)
          expect(Option.isSome(shownOf(ticket.id).mergedCommit)).toBe(true)
        expect(readFileSync(join(fixture.checkout, 'src/x.ts'), 'utf8')).toBe(
          `x\n${made.find(t => t.id === first)?.title}\n${made.find(t => t.id === second)?.title}\n`,
        )
      }),
  )

  it.effect('runs a solo ticket alone, the others waiting for it', () =>
    Effect.gen(function* () {
      const fixture = project()
      const { end, events, made } = yield* runOf(
        fixture,
        Effect.all([
          file('Set up the environment', 'finish', {
            labels: ['solo'],
            priority: 0,
          }),
          file('Add one', 'finish'),
          file('Add two', 'finish'),
        ]),
      )
      expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
      const [solo, ...others] = made.map(ticket => ticket.id)
      if (solo === undefined) throw new Error('a solo ticket')
      const dispatches = ofKind(events, 'dispatch')
      expect(dispatches[0]).toEqual(
        expect.objectContaining({
          ticket: solo,
          solo: { ticket: solo },
          held: 2,
          held_by: { solo: 2 },
        }),
      )
      expect(dispatches[0]?.text).toContain(`${solo} dispatching solo:`)
      for (const other of others) {
        expect(phasesOf(events, other)).toContainEqual({
          to: 'held_back',
          cause: `waits for the solo ticket ${solo}`,
        })
        expect(indexOf(events, 'closed', solo)).toBeLessThan(
          indexOf(events, 'dispatch', other),
        )
      }
    }),
  )

  it.effect(
    'releases a ticket once the one holding it is past its work and its branch left the file alone',
    () =>
      Effect.gen(function* () {
        const fixture = project(
          { ...settings, check_fast: 'check-after-another' },
          { 'src/x.ts': 'x\n', 'src/y.ts': 'y\n' },
        )
        const { end, events, made } = yield* runOf(
          fixture,
          Effect.all([
            // It names src/y.ts, but its branch changes src/x.ts alone.
            file('Change x, maybe y', 'finish src/x.ts', {
              metadata: metadataOf(['src/x.ts', 'src/y.ts']),
              priority: 0,
            }),
            file('Change y', 'finish src/y.ts', {
              metadata: metadataOf(['src/y.ts']),
            }),
          ]),
        )
        expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
        const [first, second] = made.map(ticket => ticket.id)
        if (first === undefined || second === undefined)
          throw new Error('two tickets')
        expect(phasesOf(events, second)).toContainEqual({
          to: 'held_back',
          cause: `touches src/y.ts, like running ${first}`,
        })
        // Dispatched while the first waited to merge: before its `closed`.
        expect(indexOf(events, 'dispatch', second)).toBeGreaterThan(-1)
        expect(indexOf(events, 'dispatch', second)).toBeLessThan(
          indexOf(events, 'closed', first),
        )
        expect(ofKind(events, 'closed').map(({ ticket }) => ticket)).toEqual([
          first,
          second,
        ])
      }),
  )
})
