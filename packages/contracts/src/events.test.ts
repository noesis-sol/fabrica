import { DateTime, Effect, Exit, Option, Schema } from 'effect'

import { describe, expect, it } from '@effect/vitest'

import {
  EndKind,
  type EventKind,
  EventLine,
  ExitCode,
  LocalTime,
  RunEvent,
  decodeEventLine,
  encodeEventLine,
  exitCodeOf,
  formatLocalTime,
} from './events'
import { CommitHash, EngineId, RunId, SessionId, TicketId } from './ids'
import {
  type CountsAs,
  Phase,
  type PhaseFacts,
  type PhaseTag,
  PhaseTag as PhaseTagSchema,
  factsOf,
  phaseFacts,
} from './phases'

const run = RunId.make('2026-10-29T10:14:58.120+02:00')
const time = LocalTime.make('2026-10-29T10:15:00.000+02:00')
const ticket = TicketId.make('fa-a1b2')
const other = TicketId.make('fa-c3d4')
const commit = CommitHash.make('eda8c7a0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6')
const session = SessionId.make('s-1')
const at = { time, run }
const tokens = {
  'anthropic/claude-opus-5-5': {
    input: 1834,
    output: 52011,
    cache_write: 210334,
    cache_read: 8120443,
  },
}
const spent = {
  phases: { working: 812.4, verifying: 30, waiting: 41, merging: 133.2 },
  hand_backs: { resolve: 0, fix: 1 },
  carried: true,
  tokens,
  cost_usd: 1.25,
} as const

// One record of every kind, as full as its fields allow: a kind added without one doesn't compile.
const samples: { readonly [K in EventKind]: Extract<RunEvent, { kind: K }> } = {
  start: RunEvent.cases.start.make({
    ...at,
    version: '0.1.0',
    engine: EngineId.make('laptop'),
    repo: '/Users/me/proj',
    branch: 'main',
    commit,
    scope: ticket,
    feature: 'Add a --json flag',
    spec: '.fabrica/specs/app.md',
    spec_source: 'https://example.com/app.md',
    concurrency: 3,
    limit: 40,
    model: 'anthropic/claude-opus-5-5',
    permissions: 'workspace',
    auto_answer: 0,
    overnight: true,
    offline: true,
  }),
  info: RunEvent.cases.info.make({ ...at, ticket, text: 'worktree ready' }),
  warn: RunEvent.cases.warn.make({
    ...at,
    ticket,
    aside: true,
    reason: 'CHECKS_FAILED',
    detail: 'checks failed',
    text: 'CHECKS_FAILED: fa-a1b2 …',
    ...spent,
  }),
  hold: RunEvent.cases.hold.make({
    ...at,
    hold: 'ENVIRONMENT',
    lifted: true,
    ticket,
    provider: 'anthropic',
    text: 'HOLD lifted: ENVIRONMENT',
  }),
  drain: RunEvent.cases.drain.make({ ...at, text: 'draining' }),
  resume: RunEvent.cases.resume.make({ ...at }),
  probed: RunEvent.cases.probed.make({ ...at, text: 'PROBE_OK' }),
  usage_limit: RunEvent.cases.usage_limit.make({
    ...at,
    provider: 'anthropic',
    ticket,
    detail: "You've hit your session limit",
    reset: LocalTime.make('2026-10-29T19:00:00.000+02:00'),
    text: 'HOLD: USAGE_LIMIT …',
  }),
  usage_limit_lifted: RunEvent.cases.usage_limit_lifted.make({
    ...at,
    provider: 'anthropic',
    text: 'HOLD: USAGE_LIMIT lifted',
  }),
  usage_window: RunEvent.cases.usage_window.make({
    ...at,
    provider: 'anthropic',
    account: 'me@example.com',
    window: 'five_hour',
    utilization: 0.42,
    resets_at: LocalTime.make('2026-10-29T13:00:00.000+02:00'),
  }),
  credentials_hold: RunEvent.cases.credentials_hold.make({
    ...at,
    provider: 'anthropic',
    account: 'me@example.com',
    ticket,
    detail: 'OAuth session expired and could not be refreshed',
    text: 'HOLD: CREDENTIALS: …',
  }),
  credentials_lifted: RunEvent.cases.credentials_lifted.make({
    ...at,
    provider: 'anthropic',
    text: 'HOLD: CREDENTIALS lifted',
  }),
  slept: RunEvent.cases.slept.make({
    ...at,
    from: LocalTime.make('2026-10-29T14:03:00.000+02:00'),
    to: LocalTime.make('2026-10-29T14:37:00.000+02:00'),
    seconds: 2040,
    cause: 'lid closed',
    text: "SLEPT: the host slept 34m (14:03–14:37); limits don't count it",
  }),
  battery: RunEvent.cases.battery.make({
    ...at,
    level: 19,
    threshold: 20,
    text: 'BATTERY: 19%',
  }),
  stop: RunEvent.cases.stop.make({
    ...at,
    detail: 'MERGE_FAILED',
    ticket,
    blocked: 'does not fast-forward onto main',
    text: 'MERGE_FAILED: …',
  }),
  done: RunEvent.cases.done.make({
    ...at,
    detail: 'READY_EMPTY',
    text: 'READY_EMPTY after 12 tickets',
  }),
  check: RunEvent.cases.check.make({
    ...at,
    suite: 'merge',
    ticket,
    command: 'scripts/check-fast.sh',
    commit,
    seconds: 133.2,
    result: 'failed',
    output: '/tmp/check.log',
    train: true,
  }),
  full_check: RunEvent.cases.full_check.make({
    ...at,
    detail: 'failed',
    suite: 'e2e',
    output: '/tmp/check-full.log',
    ticket,
    commit,
    seconds: 611.8,
    result: 'failed',
    text: 'FULL_CHECK_FAILED: …',
  }),
  organ: RunEvent.cases.organ.make({
    ...at,
    organ: 'triage',
    ticket,
    outcome: 'answered',
    model: 'openai/gpt-5',
    tokens,
    cost_usd: 0.02,
    turns: 2,
    session,
    duration_ms: 4100,
  }),
  end: RunEvent.cases.end.make({
    ...at,
    code: 0,
    tokens,
    cost_usd: 12.5,
    organs: { calls: 3, turns: 5, cost_usd: 0.0456 },
  }),
  phase: RunEvent.cases.phase.make({
    ...at,
    ticket,
    from: 'working',
    to: 'verifying',
    cause: 'finished',
  }),
  queue: RunEvent.cases.queue.make({
    ...at,
    queued: 0,
    held: 4,
    held_by: { overlap: 3, merge: 1 },
    unclosed: 31,
    solo: { ticket: other, next: true },
    machine_full: true,
  }),
  dispatch: RunEvent.cases.dispatch.make({
    ...at,
    ticket,
    title: 'Add login',
    n: 1,
    limit: 40,
    model: 'anthropic/claude-opus-5-5',
    text: '[1/40] fa-a1b2 dispatching: Add login',
    queued: 12,
    unclosed: 31,
  }),
  settled: RunEvent.cases.settled.make({
    ...at,
    ticket,
    outcome: 'finish',
    text: 'fa-a1b2 finished',
  }),
  closed: RunEvent.cases.closed.make({
    ...at,
    ticket,
    title: 'Add login',
    commit,
    detail: 'eda8c7a merged into main',
    text: '  fa-a1b2 closed …',
    ...spent,
  }),
  deferred: RunEvent.cases.deferred.make({
    ...at,
    ticket,
    title: 'Add login',
    reason: 'DEFERRED',
    detail: 'by the worker',
    text: '  fa-a1b2 deferred …',
    ...spent,
  }),
  asked: RunEvent.cases.asked.make({
    ...at,
    ticket,
    title: 'Add login',
    question: other,
    detail: 'fa-c3d4 Which provider?',
    text: '  fa-a1b2 asked …',
  }),
  answered: RunEvent.cases.answered.make({
    ...at,
    ticket,
    title: 'Add login',
    question: other,
    detail: 'fa-c3d4 answered',
    text: '  fa-a1b2 answered …',
  }),
  auto_answered: RunEvent.cases.auto_answered.make({
    ...at,
    ticket,
    question: other,
    title: 'Which provider?',
    option: 'GitHub',
    text: 'fa-c3d4 answered by --auto-answer',
  }),
  waits: RunEvent.cases.waits.make({
    ...at,
    ticket,
    title: 'Add login',
    waits_for: [other],
    detail: 'fa-c3d4',
    text: 'WAITS_FOR_MERGE: …',
  }),
  reopened: RunEvent.cases.reopened.make({
    ...at,
    ticket,
    detail: 'the run held for the environment',
    text: '  fa-a1b2 reopened',
  }),
  requeued: RunEvent.cases.requeued.make({
    ...at,
    ticket,
    detail: 'its setup failed',
  }),
  triage: RunEvent.cases.triage.make({
    ...at,
    ticket,
    title: 'Flaky network in tests',
    detail: 'environment · high',
    text: 'TRIAGE: …',
  }),
  merge_conflict: RunEvent.cases.merge_conflict.make({
    ...at,
    ticket,
    files: ['src/a.ts', 'src/b.ts'],
    attempt: 1,
    text: 'MERGE_CONFLICT in src/a.ts, src/b.ts',
  }),
  ticket_end: RunEvent.cases.ticket_end.make({
    ...at,
    ticket,
    outcome: 'set_aside',
    phase: 'set_aside',
    why: 'CHECKS_FAILED',
    seconds: 1500.5,
    turns: 48,
    ...spent,
  }),
  resumed: RunEvent.cases.resumed.make({
    ...at,
    ticket,
    session,
    why: 'answered',
    text: 'resumed with the answer',
  }),
  suspended: RunEvent.cases.suspended.make({
    ...at,
    ticket,
    session,
    why: 'run stopped',
  }),
  turn: RunEvent.cases.turn.make({
    ...at,
    ticket,
    session,
    model: 'anthropic/claude-opus-5-5',
    tokens,
    cost_usd: 0.31,
    turns: 7,
    duration_ms: 64000,
    error: 'overloaded',
  }),
}

const decodeKnown = (line: string) =>
  decodeEventLine(line).pipe(
    Effect.map(
      EventLine.$match({
        Known: ({ event }) => Option.some(event),
        Skipped: () => Option.none(),
      }),
    ),
  )

describe('the event stream', () => {
  it('has a sample of every kind', () => {
    expect(Object.keys(samples).toSorted()).toEqual(
      [...RunEvent.discriminants].toSorted(),
    )
  })

  it.effect.each(Object.values(samples))('round-trips a $kind record', event =>
    Effect.gen(function* () {
      const line = encodeEventLine(event)
      expect(line).not.toContain('\n')
      expect(JSON.parse(line)).toMatchObject({ v: 1, kind: event.kind })
      expect(yield* decodeKnown(line)).toEqual(Option.some(event))
    }),
  )

  it.effect('leaves out a field without a value, never null', () =>
    Effect.gen(function* () {
      const event = RunEvent.cases.end.make({ ...at, code: 0 })
      const line = encodeEventLine(event)
      expect(JSON.parse(line)).toEqual({
        v: 1,
        time,
        run,
        kind: 'end',
        code: 0,
      })
      expect(yield* decodeKnown(line)).toEqual(Option.some(event))
    }),
  )

  it.effect('skips a kind it does not know', () =>
    Effect.gen(function* () {
      const line = JSON.stringify({
        v: 1,
        time,
        run,
        kind: 'shared_machine',
        shared: 2,
      })
      expect(yield* decodeEventLine(line)).toEqual(
        EventLine.Skipped({ kind: 'shared_machine', v: 1 }),
      )
    }),
  )

  it.effect('skips a record of another format version', () =>
    Effect.gen(function* () {
      const line = JSON.stringify({
        ...JSON.parse(encodeEventLine(samples.end)),
        v: 2,
      })
      expect(yield* decodeEventLine(line)).toEqual(
        EventLine.Skipped({ kind: 'end', v: 2 }),
      )
    }),
  )

  it.effect(
    'reads a known kind with fields added since, leaving them out',
    () =>
      Effect.gen(function* () {
        const line = JSON.stringify({
          ...JSON.parse(encodeEventLine(samples.done)),
          added_later: true,
        })
        expect(yield* decodeKnown(line)).toEqual(Option.some(samples.done))
      }),
  )

  const malformed: ReadonlyArray<readonly [what: string, line: string]> = [
    [
      'a known kind missing a field',
      JSON.stringify({ v: 1, time, run, kind: 'end' }),
    ],
    [
      'a negative duration',
      JSON.stringify({
        ...JSON.parse(encodeEventLine(samples.check)),
        seconds: -1,
      }),
    ],
    [
      'a time without its offset',
      JSON.stringify({
        v: 1,
        time: '2026-10-29T08:15:00.000Z',
        run,
        kind: 'end',
        code: 0,
      }),
    ],
    [
      'an exit code orchestra has no meaning for',
      JSON.stringify({ v: 1, time, run, kind: 'end', code: 1 }),
    ],
    [
      'a null for a field left out',
      JSON.stringify({ v: 1, time, run, kind: 'end', code: 0, tokens: null }),
    ],
    ['a line cut short', encodeEventLine(samples.start).slice(0, 40)],
    ['a line with no kind', JSON.stringify({ v: 1, time, run })],
  ]

  it.effect.each(malformed)('fails on %s', ([_, line]) =>
    Effect.gen(function* () {
      expect(Exit.isFailure(yield* Effect.exit(decodeEventLine(line)))).toBe(
        true,
      )
    }),
  )
})

describe('LocalTime', () => {
  const moment = Date.UTC(2026, 9, 29, 8, 15, 0, 7)
  const zoned = (offsetMinutes: number) =>
    DateTime.makeZonedUnsafe(moment, {
      timeZone: DateTime.zoneMakeOffset(offsetMinutes * 60_000),
    })

  it.each([
    [120, '2026-10-29T10:15:00.007+02:00'],
    [0, '2026-10-29T08:15:00.007+00:00'],
    [-210, '2026-10-29T04:45:00.007-03:30'],
    [345, '2026-10-29T14:00:00.007+05:45'],
  ])('formats a moment at offset %i minutes as %s', (offset, expected) => {
    expect(formatLocalTime(zoned(offset))).toBe(expected)
  })

  it('formats a named zone at its offset on that day', () => {
    const athens = DateTime.makeZonedUnsafe(moment, {
      timeZone: 'Europe/Athens',
    })
    expect(formatLocalTime(athens)).toBe('2026-10-29T10:15:00.007+02:00')
  })

  it.each([
    '2026-10-29T10:15:00+02:00',
    '2026-10-29T10:15:00.000Z',
    '2026-10-29T10:15:00.000',
    '2026-10-29 10:15:00.000+02:00',
  ])('is not made from %s', text => {
    expect(Option.isNone(LocalTime.makeOption(text))).toBe(true)
  })
})

describe('exit codes', () => {
  // §13.11, kind by kind.
  const expected: ReadonlyArray<readonly [EndKind, ExitCode]> = [
    ['READY_EMPTY', 0],
    ['LIMIT_REACHED', 0],
    ['DRAINED', 0],
    ['SETUP', 2],
    ['PREFLIGHT_FAILED', 2],
    ['REQUIREMENTS_MISSING', 2],
    ['PROJECT_LEASED', 2],
    ['REMOTE_UNREACHABLE', 2],
    ['CREDENTIALS', 2],
    ['GIT_FAILED', 4],
    ['TRACKER_FAILED', 4],
    ['PANIC', 4],
    ['OFF_BRANCH', 5],
    ['MERGE_FAILED', 6],
    ['ENVIRONMENT', 7],
    ['USAGE_LIMIT', 8],
    ['INTERRUPTED', 130],
  ]

  it.each(expected)('%s exits with %i', (kind, code) => {
    expect(exitCodeOf(kind)).toBe(code)
  })

  it('names every end, and none exits with the reserved 3', () => {
    const kinds = EndKind.members.flatMap(member => member.literals)
    expect(expected.map(([kind]) => kind).toSorted()).toEqual(kinds.toSorted())
    expect(kinds.map(exitCodeOf)).not.toContain(3)
    expect(Schema.is(ExitCode)(3)).toBe(true)
  })
})

describe('the phase table', () => {
  it('gives the facts of every phase', () => {
    expect(Object.keys(phaseFacts).toSorted()).toEqual(
      [...PhaseTagSchema.literals].toSorted(),
    )
  })

  it('is exhaustive by type', () => {
    const { working: _working, ...withoutWorking } = phaseFacts
    // @ts-expect-error: a phase without its facts doesn't compile.
    const _missingPhase: { readonly [T in PhaseTag]: PhaseFacts } =
      withoutWorking
    const { ends: _ends, ...withoutEnds } = phaseFacts.working
    // @ts-expect-error: a phase without one of its facts doesn't compile.
    const _missingFact: PhaseFacts = withoutEnds
    expect(withoutWorking).not.toHaveProperty('working')
  })

  const phases: ReadonlyArray<readonly [Phase, CountsAs]> = [
    [Phase.cases.queued.make({}), 'in_queue'],
    [
      Phase.cases.held_back.make({
        reason: 'overlap',
        detail: 'touches src/a.ts, like running fa-7',
      }),
      'in_queue',
    ],
    [
      Phase.cases.waiting.make({ for: { _tag: 'merge', tickets: [other] } }),
      'in_queue',
    ],
    [Phase.cases.working.make({}), 'working'],
    [Phase.cases.verifying.make({ round: 1 }), 'working'],
    [Phase.cases.waiting_to_merge.make({ place: 1 }), 'waiting_to_merge'],
    [Phase.cases.merging.make({ step: 'check' }), 'waiting_to_merge'],
    [Phase.cases.resolving.make({ attempt: 1 }), 'working'],
    [Phase.cases.fixing.make({ attempt: 2 }), 'working'],
    [Phase.cases.asked.make({ question: other }), 'needs_you'],
    [Phase.cases.set_aside.make({ reason: 'CLOSED_UNCOMMITTED' }), 'set_aside'],
    [Phase.cases.stopped.make({}), 'carried_over'],
    [Phase.cases.merged.make({ commit }), 'done'],
    [Phase.cases.no_change.make({}), 'done'],
  ]

  it.each(phases)('counts %j as %s', (phase, counts) => {
    expect(factsOf(phase).counts).toBe(counts)
  })

  it.each(phases)('round-trips %j', phase => {
    const json = Schema.encodeSync(Schema.fromJsonString(Phase))(phase)
    expect(
      Schema.decodeUnknownSync(Schema.fromJsonString(Phase))(json),
    ).toEqual(phase)
  })

  it('puts the phases in progress on the phase bar, a hand-back on merging', () => {
    const onBar = PhaseTagSchema.literals.flatMap(tag =>
      Option.match(phaseFacts[tag].bar, {
        onNone: () => [],
        onSome: segment => [[tag, segment, phaseFacts[tag].handBack] as const],
      }),
    )
    expect(onBar).toEqual([
      ['working', 'working', false],
      ['verifying', 'verifying', false],
      ['waiting_to_merge', 'waiting_to_merge', false],
      ['merging', 'merging', false],
      ['resolving', 'merging', true],
      ['fixing', 'merging', true],
    ])
  })

  it('ends a ticket only in a phase it can be left in, as ticket_end says', () => {
    const ends = PhaseTagSchema.literals.flatMap(tag =>
      Option.match(phaseFacts[tag].ends, {
        onNone: () => [],
        onSome: outcome => [[tag, outcome] as const],
      }),
    )
    expect(ends).toEqual([
      ['queued', 'queued'],
      ['held_back', 'queued'],
      ['waiting', 'queued'],
      ['asked', 'needs_you'],
      ['set_aside', 'set_aside'],
      ['stopped', 'stopped'],
      ['merged', 'merged'],
      ['no_change', 'no_change'],
    ])
  })

  it('takes a slot only while a worker or the verifier is at it', () => {
    const slots = PhaseTagSchema.literals.filter(
      tag => phaseFacts[tag].takesSlot,
    )
    expect(slots).toEqual(['working', 'verifying', 'resolving', 'fixing'])
  })
})
