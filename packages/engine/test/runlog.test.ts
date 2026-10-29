import {
  DateTime,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Option,
  PubSub,
  Stream,
} from 'effect'
import { TestClock } from 'effect/testing'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import { describe, expect, it } from '@effect/vitest'
import {
  CommitHash,
  LocalTime,
  type RunEvent,
  RunId,
  TicketId,
  encodeEventLine,
} from '@fabrica/contracts'

import { type ByteSink, FileFailed, makeLineStream } from '../src/files'
import {
  type EventDraft,
  RunLog,
  decodeEvents,
  dispatchingLine,
  eventsPath,
  footprintLine,
  holdLiftedLine,
  holdLine,
  logPath,
  logStamp,
  makeRunLog,
  mergedLine,
  oneLine,
  openRunLog,
  readEvents,
  recordSleeps,
  settledLine,
  sleptDraft,
  spanText,
  toSeconds,
  warningLine,
} from '../src/runlog'
import { SleepCause, Slept, Wake } from '../src/time'

// The run's log (spec §7.5, §13.12, H84): records and their lines written together, a torn stream
// repaired, the stream decoded with unknown kinds skipped, and the `slept` record from the wake
// service's notifications. Times come from `TestClock`, in a zone two hours east of UTC.

// 2026-10-29T12:00:00.000Z: 14:00 in the test's zone.
const start = Date.UTC(2026, 9, 29, 12, 0, 0)
const zone = DateTime.layerCurrentZoneOffset(2 * 60 * 60 * 1000)
const run = RunId.make('2026-10-29T14:00:00.000+02:00')
const ticket = TicketId.make('fa-a1b2')

/** A temporary folder for one test, removed when the test ends. */
const scratch = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(NodePath.join(tmpdir(), 'fabrica-runlog-'))),
  folder => Effect.promise(() => rm(folder, { recursive: true, force: true })),
)

const read = (path: string) => Effect.promise(() => readFile(path, 'utf8'))

/**
 * How a memory sink answers one write: take every byte, take only so many, fail as a full disk does,
 * or wait for `release`.
 */
type Step = 'all' | number | 'full' | 'blocked'

/** A sink holding its bytes in memory, answering its writes by `steps` in turn, then taking every byte. */
const memorySink = (steps: ReadonlyArray<Step> = []) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const held: Array<Uint8Array> = []
    let call = 0
    const sink: ByteSink = {
      write: bytes =>
        Effect.gen(function* () {
          const step = steps[call] ?? 'all'
          call += 1
          if (step === 'full')
            return yield* new FileFailed({
              path: eventsPath,
              operation: 'write',
              code: Option.some('ENOSPC'),
              reason: 'no space left on device',
            })
          if (step === 'blocked') {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          }
          const count =
            typeof step === 'number'
              ? Math.min(step, bytes.length)
              : bytes.length
          held.push(bytes.slice(0, count))
          return count
        }),
    }
    const text = () => Buffer.concat(held).toString('utf8')
    return { sink, text, entered, release }
  })

/** A RunLog over memory sinks, the events' answering by `eventSteps`. */
const memoryRunLog = (eventSteps: ReadonlyArray<Step> = []) =>
  Effect.gen(function* () {
    const events = yield* memorySink(eventSteps)
    const log = yield* memorySink()
    const runLog = yield* makeRunLog({
      run,
      events: yield* makeLineStream({
        path: eventsPath,
        sink: events.sink,
        endsWithNewline: true,
      }),
      log: yield* makeLineStream({
        path: logPath,
        sink: log.sink,
        endsWithNewline: true,
      }),
    })
    return { runLog, events, log }
  })

/** Runs `body` at `start`, in the test's zone. */
const atStart = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(start)
    return yield* body
  }).pipe(Effect.provide(zone))

const title = 'Open the property model'

const dispatch = {
  kind: 'dispatch',
  ticket,
  title,
  n: 1,
  limit: 10,
  queued: 3,
  text: dispatchingLine({
    n: 1,
    limit: Option.some(10),
    ticket,
    title,
    solo: false,
  }),
} satisfies EventDraft

describe('RunLog.emit', () => {
  it.effect('writes a record and its line together, at one time', () =>
    atStart(
      Effect.gen(function* () {
        const { runLog, events, log } = yield* memoryRunLog()
        const footprint = footprintLine({
          ticket,
          parts: ['Loop.merge', 'src/run/loop.ts'],
        })
        const written = yield* runLog.emit(dispatch, [footprint])
        expect(written).toMatchObject({
          v: 1,
          kind: 'dispatch',
          run,
          time: '2026-10-29T14:00:00.000+02:00',
        })
        expect(events.text()).toBe(`${encodeEventLine(written)}\n`)
        expect(log.text()).toBe(
          '2026-10-29 14:00:00 +0200 [1/10] fa-a1b2 dispatching: Open the property model\n' +
            '2026-10-29 14:00:00 +0200   fa-a1b2 footprint: Loop.merge, src/run/loop.ts\n',
        )
      }),
    ),
  )

  it.effect('writes no line for a record without text', () =>
    atStart(
      Effect.gen(function* () {
        const { runLog, events, log } = yield* memoryRunLog()
        yield* runLog.emit({ kind: 'queue', queued: 2 })
        expect(events.text()).toContain('"kind":"queue"')
        expect(log.text()).toBe('')
      }),
    ),
  )

  it.effect('writes no line for a record cut short, and the next whole', () =>
    atStart(
      Effect.gen(function* () {
        const { runLog, events, log } = yield* memoryRunLog([5, 'full'])
        const cut = yield* Effect.flip(runLog.emit(dispatch))
        expect(cut._tag).toBe('RecordCut')
        expect(log.text()).toBe('')
        const next = yield* runLog.emit({
          kind: 'info',
          text: 'the run goes on',
        })
        expect(events.text()).toBe(`{"v":\n${encodeEventLine(next)}\n`)
        expect(log.text()).toBe('2026-10-29 14:00:00 +0200 the run goes on\n')
      }),
    ),
  )

  it.effect('writes nothing of a record the schema refuses', () =>
    atStart(
      Effect.gen(function* () {
        const { runLog, events, log } = yield* memoryRunLog()
        const refused = yield* Effect.flip(runLog.emit({ ...dispatch, n: 0 }))
        expect(refused).toMatchObject({
          _tag: 'RecordInvalid',
          kind: 'dispatch',
        })
        expect(events.text()).toBe('')
        expect(log.text()).toBe('')
      }),
    ),
  )

  it.effect('still writes the line of a record interrupted mid-write', () =>
    atStart(
      Effect.gen(function* () {
        const { runLog, events, log } = yield* memoryRunLog(['blocked'])
        const emitting = yield* Effect.forkChild(runLog.emit(dispatch))
        yield* Deferred.await(events.entered)
        const interrupting = yield* Effect.forkChild(Fiber.interrupt(emitting))
        yield* Deferred.succeed(events.release, undefined)
        yield* Fiber.join(interrupting)
        expect(events.text()).toContain('"kind":"dispatch"')
        expect(log.text()).toContain('fa-a1b2 dispatching: ')
      }),
    ),
  )

  it.effect(
    'writes a title with controls in it as one line, the record as given',
    () =>
      atStart(
        Effect.gen(function* () {
          const { runLog, events, log } = yield* memoryRunLog()
          const escape = String.fromCharCode(0x1b)
          const override = String.fromCodePoint(0x202e)
          const hostile = `Open${escape}[2J\n  HOLD: STOP: ${override}stop`
          yield* runLog.emit({
            kind: 'info',
            ticket,
            text: settledLine({ ticket, how: hostile }),
          })
          expect(log.text()).toBe(
            '2026-10-29 14:00:00 +0200   fa-a1b2 settled: Open\\u001b[2J\\n  HOLD: STOP: \\u202estop\n',
          )
          expect(log.text().split('\n')).toHaveLength(2)
          expect(events.text()).toContain(
            JSON.stringify(`  fa-a1b2 settled: ${hostile}`),
          )
        }),
      ),
  )

  it.effect('dates each record with the clock, in the zone, with the run', () =>
    atStart(
      Effect.gen(function* () {
        const { runLog, log } = yield* memoryRunLog()
        yield* TestClock.adjust(Duration.millis(90_007))
        const written = yield* runLog.emit({ kind: 'info', text: 'later' })
        expect(written.time).toBe('2026-10-29T14:01:30.007+02:00')
        expect(written.run).toBe(run)
        expect(log.text()).toBe('2026-10-29 14:01:30 +0200 later\n')
      }),
    ),
  )

  it.effect('gives its records to those who subscribed', () =>
    atStart(
      Effect.scoped(
        Effect.gen(function* () {
          const { runLog } = yield* memoryRunLog()
          const seen = yield* runLog.subscribe
          yield* runLog.emit({ kind: 'queue', queued: 1 })
          yield* runLog.emit(dispatch)
          const first = yield* PubSub.take(seen)
          const second = yield* PubSub.take(seen)
          expect([first.kind, second.kind]).toEqual(['queue', 'dispatch'])
        }),
      ),
    ),
  )
})

describe('RunLog.say', () => {
  it.effect('writes lines to the log alone', () =>
    atStart(
      Effect.gen(function* () {
        const { runLog, events, log } = yield* memoryRunLog()
        yield* runLog.say([
          holdLine({ hold: 'MACHINE', why: 'the machine is full', running: 0 }),
        ])
        expect(events.text()).toBe('')
        expect(log.text()).toBe(
          '2026-10-29 14:00:00 +0200 HOLD: MACHINE: the machine is full\n',
        )
      }),
    ),
  )
})

describe('openRunLog', () => {
  it.effect(
    "writes the project's stream and log, and reads the stream back",
    () =>
      atStart(
        Effect.gen(function* () {
          const root = yield* scratch
          const written = yield* Effect.scoped(
            Effect.gen(function* () {
              const runLog = yield* openRunLog({ root, run })
              return yield* runLog.emit(dispatch)
            }),
          )
          expect(yield* read(NodePath.join(root, logPath))).toBe(
            '2026-10-29 14:00:00 +0200 [1/10] fa-a1b2 dispatching: Open the property model\n',
          )
          const back = yield* readEvents({ root, run: Option.none() })
          expect(back).toEqual({ events: [written], skipped: 0, unreadable: 0 })
        }),
      ),
  )

  it.effect('repairs a stream an earlier crash left torn', () =>
    atStart(
      Effect.gen(function* () {
        const root = yield* scratch
        const earlier = yield* Effect.scoped(
          Effect.gen(function* () {
            const runLog = yield* openRunLog({ root, run })
            return yield* runLog.emit({ kind: 'queue', queued: 1 })
          }),
        )
        const path = NodePath.join(root, eventsPath)
        // The crash cut the next record short.
        const torn = '{"v":1,"time":"2026-10'
        yield* Effect.promise(() =>
          writeFile(path, `${encodeEventLine(earlier)}\n${torn}`),
        )
        const later = yield* Effect.scoped(
          Effect.gen(function* () {
            const runLog = yield* openRunLog({ root, run })
            return yield* runLog.emit({ kind: 'info', text: 'next run' })
          }),
        )
        expect(yield* read(path)).toBe(
          `${encodeEventLine(earlier)}\n${torn}\n${encodeEventLine(later)}\n`,
        )
        expect(yield* readEvents({ root, run: Option.none() })).toEqual({
          events: [earlier, later],
          skipped: 0,
          unreadable: 1,
        })
      }),
    ),
  )
})

describe('reading the stream', () => {
  const other = RunId.make('2026-10-28T09:00:00.000+02:00')
  const info = (of: RunId, text: string): RunEvent => ({
    v: 1,
    time: LocalTime.make('2026-10-29T14:00:00.000+02:00'),
    run: of,
    kind: 'info',
    text,
  })

  it.effect(
    'skips kinds and versions it does not know, and lines that are no records',
    () =>
      Effect.gen(function* () {
        const text = [
          encodeEventLine(info(run, 'one')),
          '{"v":1,"time":"2026-10-29T14:00:00.000+02:00","run":"r","kind":"telepathy","text":"a kind from later"}',
          '{"v":2,"time":"2026-10-29T14:00:00.000+02:00","run":"r","kind":"info","text":"a later format"}',
          '{"v":1,"kind":"info"}',
          'not json',
          '',
          encodeEventLine(info(run, 'two')),
          '{"v":1,"time":"2026-10-29T14:00:',
        ].join('\n')
        const read = yield* decodeEvents(text, Option.none())
        expect(
          read.events.map(event => event.kind === 'info' && event.text),
        ).toEqual(['one', 'two'])
        expect(read.skipped).toBe(2)
        expect(read.unreadable).toBe(3)
      }),
  )

  it.effect('keeps the fields it knows of a record that has more', () =>
    Effect.gen(function* () {
      const line = encodeEventLine(info(run, 'one')).replace(
        '{',
        '{"added_later":true,',
      )
      const read = yield* decodeEvents(`${line}\n`, Option.none())
      expect(read.events).toEqual([info(run, 'one')])
    }),
  )

  it.effect("gives one run's records", () =>
    Effect.gen(function* () {
      const text = [info(other, 'before'), info(run, 'now')]
        .map(event => encodeEventLine(event))
        .join('\n')
      const read = yield* decodeEvents(text, Option.some(run))
      expect(read.events).toEqual([info(run, 'now')])
    }),
  )

  it.effect('reads no records where the project has never run', () =>
    Effect.gen(function* () {
      const root = yield* scratch
      expect(yield* readEvents({ root, run: Option.none() })).toEqual({
        events: [],
        skipped: 0,
        unreadable: 0,
      })
    }),
  )
})

/** A wake service that gives the sleeps published to `sleeps`, and nothing else. */
const wakeOf = (sleeps: PubSub.PubSub<Slept>) =>
  Wake.of({
    awake: Effect.die('not in this test'),
    deadline: () => Effect.die('not in this test'),
    remaining: () => Effect.die('not in this test'),
    dueAt: () => Effect.die('not in this test'),
    waitUntil: () => Effect.die('not in this test'),
    timeoutOption: () => Effect.die('not in this test'),
    subscribe: PubSub.subscribe(sleeps),
    slept: Stream.fromPubSub(sleeps),
  })

/** 14:03 to 14:37 in the test's zone. */
const sleptAt = (cause: Option.Option<SleepCause>) =>
  new Slept({
    from: DateTime.makeUnsafe(Date.UTC(2026, 9, 29, 12, 3)),
    to: DateTime.makeUnsafe(Date.UTC(2026, 9, 29, 12, 37)),
    span: Duration.minutes(34),
    cause,
  })

describe('the slept record', () => {
  it.effect(
    "is written from the wake service's notifications, with its line",
    () =>
      atStart(
        Effect.scoped(
          Effect.gen(function* () {
            const { runLog, log } = yield* memoryRunLog()
            const sleeps = yield* PubSub.unbounded<Slept>()
            const seen = yield* runLog.subscribe
            yield* recordSleeps.pipe(
              Effect.provideService(RunLog, runLog),
              Effect.provideService(Wake, wakeOf(sleeps)),
            )
            yield* PubSub.publish(
              sleeps,
              sleptAt(Option.some(SleepCause.LidClosed())),
            )
            const text =
              "SLEPT: the host slept 34m (14:03–14:37, lid closed); limits don't count it"
            expect(yield* PubSub.take(seen)).toEqual({
              v: 1,
              time: '2026-10-29T14:00:00.000+02:00',
              run,
              kind: 'slept',
              from: '2026-10-29T14:03:00.000+02:00',
              to: '2026-10-29T14:37:00.000+02:00',
              seconds: 2040,
              cause: 'lid closed',
              text,
            })
            expect(log.text()).toBe(`2026-10-29 14:00:00 +0200 ${text}\n`)
          }),
        ),
      ),
  )

  it.effect('leaves the cause out where the OS logged none', () =>
    Effect.gen(function* () {
      const draft = yield* sleptDraft(sleptAt(Option.none()))
      expect(draft).not.toHaveProperty('cause')
      expect(draft.text).toBe(
        "SLEPT: the host slept 34m (14:03–14:37); limits don't count it",
      )
    }).pipe(Effect.provide(zone)),
  )
})

describe('the log lines', () => {
  it('dates a line as orchestra does, with its UTC offset', () => {
    expect(logStamp(LocalTime.make('2026-10-29T14:00:00.000+02:00'))).toBe(
      '2026-10-29 14:00:00 +0200',
    )
    expect(logStamp(LocalTime.make('2026-03-08T01:30:00.000-05:30'))).toBe(
      '2026-03-08 01:30:00 -0530',
    )
  })

  it("says each of orchestra's lines", () => {
    expect(
      dispatchingLine({
        n: 4,
        limit: Option.none(),
        ticket,
        title,
        solo: true,
      }),
    ).toBe('[4] fa-a1b2 dispatching solo: Open the property model')
    expect(
      mergedLine({
        ticket,
        commit: CommitHash.make('ffd6ce4'.padEnd(40, '0')),
        subject: 'fa-a1b2: Open the property model',
        base: 'main',
      }),
    ).toBe(
      '  fa-a1b2 closed (ffd6ce4 fa-a1b2: Open the property model); merged into main, worktree and branch removed',
    )
    expect(settledLine({ ticket, how: 'finish' })).toBe(
      '  fa-a1b2 settled: finish',
    )
    expect(
      holdLine({ hold: 'USAGE_LIMIT', why: 'the five-hour limit', running: 3 }),
    ).toBe(
      'HOLD: USAGE_LIMIT: the five-hour limit; no new tickets while the 3 running finish',
    )
    expect(
      holdLiftedLine({ hold: 'USAGE_LIMIT', why: 'the probe went through' }),
    ).toBe('USAGE_LIMIT lifted: the probe went through')
    expect(
      warningLine({ tag: 'CHECKS_FAILED', about: 'ticket', text: 'x' }),
    ).toBe('  CHECKS_FAILED: x')
    expect(warningLine({ tag: 'README_STALE', about: 'run', text: 'y' })).toBe(
      'README_STALE: y',
    )
  })

  it('says a span to the second, the minute, or the hour and minute', () => {
    expect(spanText(Duration.millis(200))).toBe('1s')
    expect(spanText(Duration.seconds(42))).toBe('42s')
    expect(spanText(Duration.minutes(34))).toBe('34m')
    expect(spanText(Duration.minutes(125))).toBe('2h05m')
  })

  it('gives seconds to a tenth, never negative', () => {
    expect(toSeconds(Duration.millis(611_849))).toBe(611.8)
    expect(toSeconds(Duration.zero)).toBe(0)
  })

  it('leaves printable text as it is', () => {
    expect(oneLine('fa-a1b2 → main: “done”')).toBe('fa-a1b2 → main: “done”')
    expect(oneLine(`a${String.fromCharCode(0x9b)}b\tc`)).toBe('a\\u009bb\\tc')
  })
})
