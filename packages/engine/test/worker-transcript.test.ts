import {
  DateTime,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Scope,
  Stream,
} from 'effect'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from '@effect/vitest'
import {
  Phase,
  RunId,
  SessionId,
  TicketId,
  type TranscriptEntry,
  type TranscriptItem,
} from '@fabrica/contracts'

import { makeTranscriptReader } from '../src/agent'
import { noSpend } from '../src/cost'
import { makeRunState } from '../src/run'
import { RunLog, layerRunLog } from '../src/runlog'
import { makeWorkerDesk } from '../src/view'

// A worker's transcript (spec §8.3, §18.4, §18.5): a tool call's input streamed as the model writes it
// is read as `tool_input`, naming the call and its tool; a worker's transcript is watched while its
// part in the run goes, its watches ending as its ticket reaches a phase its part can end in and as the
// run ends, and taken up again by a later dispatch.

const ticket = TicketId.make('wk-a1')
const interval = Duration.millis(50)

/** Pi's streamed event of a tool call's input: `delta` more of the message's part at index 1. */
const toolcallDelta = (delta: string, call: unknown) => ({
  type: 'message_update' as const,
  assistantMessageEvent: {
    type: 'toolcall_delta',
    contentIndex: 1,
    delta,
    partial: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Running the tests' }, call],
    },
  },
})

const bashCall = {
  type: 'toolCall',
  id: 'call-1',
  name: 'bash',
  arguments: { command: 'pnpm' },
}

describe("a tool call's streamed input", () => {
  it.effect('is read as tool_input, naming the call and its tool', () =>
    Effect.gen(function* () {
      const reader = yield* makeTranscriptReader()
      expect(
        yield* reader.read(toolcallDelta('{"command":', bashCall)),
      ).toEqual([
        {
          _tag: 'tool_input',
          id: 'call-1',
          tool: 'bash',
          delta: '{"command":',
        },
      ])
    }),
  )

  it.effect('is not read where the part is no tool call, or names none', () =>
    Effect.gen(function* () {
      const reader = yield* makeTranscriptReader()
      const unread = [
        toolcallDelta('{"command":', { type: 'text', text: 'Running' }),
        toolcallDelta('{"command":', { ...bashCall, id: '' }),
        toolcallDelta('{"command":', { ...bashCall, name: ' ' }),
        toolcallDelta('', bashCall),
      ]
      for (const event of unread) expect(yield* reader.read(event)).toEqual([])
    }),
  )
})

/** The desk's transcript of the ticket's worker, its items collected as they come, until it ends. */
const watched = (desk: Effect.Success<ReturnType<typeof makeWorkerDesk>>) =>
  Effect.gen(function* () {
    const stream = yield* desk.watchTranscript(ticket, Option.none())
    return yield* Option.getOrThrow(stream).pipe(
      Stream.runCollect,
      Effect.forkChild,
    )
  })

/** The users' messages a transcript's items hold. */
const said = (items: ReadonlyArray<TranscriptItem>) =>
  items.flatMap(item =>
    item.value.flatMap((entry: TranscriptEntry) =>
      entry._tag === 'message' ? [entry.text] : [],
    ),
  )

const enter = (desk: Effect.Success<ReturnType<typeof makeWorkerDesk>>) =>
  desk.enter({
    ticket,
    session: SessionId.make('worker-1'),
    model: 'anthropic/claude-opus-5-5',
  })

const message = (
  desk: Effect.Success<ReturnType<typeof makeWorkerDesk>>,
  text: string,
) => desk.message({ ticket, text, merging: true })

describe("a worker's transcript watched", () => {
  it.effect(
    'ends as its part in the run ends, and is taken up again by a later dispatch',
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const desk = yield* makeWorkerDesk({ flush: interval, scope })
        yield* enter(desk)

        const before = yield* watched(desk)
        yield* Effect.yieldNow
        yield* message(desk, 'Look here')
        yield* desk.leave(ticket)
        expect(said(yield* Fiber.join(before))).toEqual(['Look here'])

        // A watch begun once its part has ended gets the transcript so far, and ends.
        const after = yield* watched(desk)
        expect(said(yield* Fiber.join(after))).toEqual(['Look here'])

        // Dispatched again, it is watched again, its transcript kept.
        yield* enter(desk)
        const again = yield* watched(desk)
        yield* Effect.yieldNow
        yield* message(desk, 'And here')
        yield* desk.leave(ticket)
        expect(said(yield* Fiber.join(again))).toEqual([
          'Look here',
          'And here',
        ])
      }),
  )

  it.effect('ends as the run ends', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const desk = yield* makeWorkerDesk({ flush: interval, scope })
      yield* enter(desk)
      const watch = yield* watched(desk)
      yield* Effect.yieldNow
      yield* message(desk, 'Look here')
      yield* Scope.close(scope, Exit.void)
      expect(said(yield* Fiber.join(watch))).toEqual(['Look here'])
    }),
  )
})

describe("a ticket's part in the run", () => {
  it.effect(
    'is told ended as its ticket goes from in progress to a phase it can end in',
    () =>
      Effect.gen(function* () {
        const root = realpathSync(mkdtempSync(join(tmpdir(), 'fab-left-')))
        const run = RunId.make('run-left')
        const left = yield* Ref.make<ReadonlyArray<TicketId>>([])
        yield* Effect.gen(function* () {
          const state = yield* makeRunState(
            yield* RunLog,
            () => Effect.succeed(noSpend),
            done => Ref.update(left, all => [...all, done]),
          )
          yield* state.enter({ ticket, title: 'Build the page' })
          yield* state.dispatch({
            ticket,
            title: 'Build the page',
            limit: Option.none(),
          })
          const move = (to: Phase) => state.move({ ticket, to, cause: 'test' })
          yield* move(Phase.cases.verifying.make({ round: 1 }))
          yield* move(Phase.cases.waiting_to_merge.make({ place: 1 }))
          expect(yield* Ref.get(left)).toEqual([])
          yield* move(Phase.cases.stopped.make({}))
          expect(yield* Ref.get(left)).toEqual([ticket])
          yield* move(Phase.cases.queued.make({}))
          expect(yield* Ref.get(left)).toEqual([ticket])
        }).pipe(
          Effect.provide(
            layerRunLog({ root, run }).pipe(
              Layer.provide(DateTime.layerCurrentZoneOffset(0)),
            ),
          ),
        )
      }),
  )
})
