import {
  DateTime,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  PubSub,
  Queue,
  Ref,
  Schema,
} from 'effect'
import { TestClock } from 'effect/testing'

import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  type Actor,
  MessageId,
  type RunEvent,
  RunId,
  StreamEpoch,
  TicketId,
  ToolCallId,
  TranscriptEntry,
  TranscriptItem,
  exitCodeOf,
} from '@fabrica/contracts'

import { noSpend } from '../src/cost'
import {
  ENV_PROBE,
  EnvironmentProbe,
  ProbeOutcome,
  Settle,
  counted,
  makeHolds,
  noCount,
  tripped,
} from '../src/holds'
import {
  NOTES_KEPT,
  OrganOutcome,
  type OrganRuntime,
  PART_TEXT_KEPT,
  type SetAsideTicket,
  TURNS_KEPT,
  TURNS_TEXT_KEPT,
  type TicketGit,
  keptEnd,
  lastTurns,
  makeTriage,
} from '../src/organs'
import { runProject } from '../src/run'
import { makeEnvironmentHold } from '../src/run/holds'
import { RunLog, makeRunLog } from '../src/runlog'
import {
  WorkGraph,
  type WorkGraphShape,
  makeWorkGraph,
  storeLayer,
} from '../src/workgraph'
import {
  configOf,
  eventsOf,
  file,
  ofKind,
  options,
  project,
  setUpRuns,
  settings,
  withRuns,
} from './run-harness'

// Triage (spec §16, §14.1, §14.6): a ticket set aside is read by the organ, its verdict's note written on
// it; two high-confidence `environment` verdicts start the environment hold; while a refused credential
// holds the run, no ticket is read. The organ's model is a stand-in that answers as a test says, on the
// real work graph and holds; the last tests run whole runs, whose calls reach a loopback provider through
// the real runtime and model proxy.

beforeAll(setUpRuns)

const run = RunId.make('run-triage')
const maintainer: Actor = { _tag: 'maintainer' }

const graphLayer = Layer.effect(
  WorkGraph,
  makeWorkGraph({ prefix: 'fa' }),
).pipe(Layer.provide(storeLayer(':memory:')))

const verdict = (
  cause: string,
  confidence: string,
  note = `${cause} note`,
) => ({
  cause,
  confidence,
  note,
})

const gitOf = (ticket: TicketId): TicketGit => ({
  branch: `tutti/${ticket}`,
  changed: ['src/a.ts'],
  status: Option.some({ uncommitted: ['src/b.ts'], untracked: [] }),
})

/** Triage over the work graph, its model answering as `answers` says, what it was asked kept. */
const triageOver = (
  answers: (ticket: TicketId) => Effect.Effect<OrganOutcome<unknown>>,
  overrides: {
    readonly graph?: (
      graph: WorkGraphShape,
    ) => Pick<WorkGraphShape, 'show' | 'note'>
    readonly transcript?: ReadonlyArray<TranscriptEntry>
  } = {},
) =>
  Effect.gen(function* () {
    const graph = yield* WorkGraph
    const log = yield* makeRunLog({
      run,
      events: { path: 'events.jsonl', append: () => Effect.void },
      log: { path: 'run.log', append: () => Effect.void },
    })
    const written = yield* log.subscribe
    const holds = yield* makeHolds({ log, running: Effect.succeed(0) })
    const reopened = yield* Ref.make<ReadonlyArray<TicketId>>([])
    const environment = yield* makeEnvironmentHold({
      holds,
      log,
      sleep: Effect.sleep,
      agent: Effect.die('the minimal agent is the probe override'),
      reopen: tickets => Ref.update(reopened, kept => [...kept, ...tickets]),
      probed: Effect.void,
    }).pipe(
      Effect.provideService(EnvironmentProbe, {
        probe: () => Effect.succeed(ProbeOutcome.Passed()),
      }),
    )
    const asked = yield* Ref.make<ReadonlyArray<TicketId>>([])
    const prompts = yield* Ref.make<ReadonlyArray<string>>([])
    const organs: Pick<OrganRuntime, 'ask'> = {
      ask: question =>
        Effect.gen(function* () {
          const ticket = Option.getOrThrow(question.ticket)
          yield* Ref.update(asked, kept => [...kept, ticket])
          const prompt = yield* question.prompt
          yield* Ref.update(prompts, kept => [...kept, prompt])
          return yield* OrganOutcome.$match(yield* answers(ticket), {
            Answered: ({ answer, spend }) =>
              Schema.decodeUnknownEffect(question.answer)(answer).pipe(
                Effect.orDie,
                Effect.map(decoded =>
                  OrganOutcome.Answered({ answer: decoded, spend }),
                ),
              ),
            Disabled: () => Effect.succeed(OrganOutcome.Disabled()),
            NoResult: ({ reason, spend }) =>
              Effect.succeed(OrganOutcome.NoResult({ reason, spend })),
          })
        }),
    }
    const answered = yield* Queue.unbounded<TicketId>()
    const triage = yield* makeTriage({
      organs,
      graph: overrides.graph === undefined ? graph : overrides.graph(graph),
      log,
      holds,
      environment,
      transcript: () =>
        Effect.succeed(
          Option.fromUndefinedOr(overrides.transcript).pipe(
            Option.map(entries =>
              TranscriptItem.cases.snapshot.make({
                epoch: StreamEpoch.make('e-1'),
                seq: 0,
                value: entries,
              }),
            ),
          ),
        ),
      git: ticket => Effect.succeed(gitOf(ticket)),
      answered: ticket => Queue.offer(answered, ticket).pipe(Effect.asVoid),
    })
    return {
      graph,
      holds,
      environment,
      triage,
      reopened,
      asked,
      prompts,
      came: Queue.take(answered),
      records: Effect.map(
        PubSub.takeUpTo(written, 1_000),
        (taken): ReadonlyArray<RunEvent> => taken,
      ),
    }
  }).pipe(Effect.provide(DateTime.layerCurrentZoneOffset(0)))

const answering = (answer: unknown) =>
  Effect.succeed(OrganOutcome.Answered({ answer, spend: noSpend }))

const filed = (title: string, description = `What ${title} asks.`) =>
  Effect.flatMap(WorkGraph, graph =>
    Effect.map(
      graph.create({
        ticket: { type: 'task', title, description },
        actor: maintainer,
      }),
      ({ id }) => id,
    ),
  )

const notesOf = (ticket: TicketId) =>
  Effect.flatMap(WorkGraph, graph =>
    Effect.map(graph.show(ticket), ({ notes }) => notes),
  )

const setAside = (ticket: TicketId): SetAsideTicket => ({
  ticket,
  reason: 'DEFERRED',
  detail: 'it needs a decision first',
})

const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(graphLayer))

describe('a verdict', () => {
  it.effect(
    "goes on the ticket as a note, with the organ's record, and holds nothing",
    () =>
      scoped(
        Effect.gen(function* () {
          const { triage, came, holds, records } = yield* triageOver(() =>
            answering(
              verdict(
                'ticket',
                'high',
                'It asks for two things at once.\nSplit it.',
              ),
            ),
          )
          const ticket = yield* filed('Build one')
          yield* triage.setAside(setAside(ticket))
          expect(yield* came).toBe(ticket)
          const notes = yield* notesOf(ticket)
          expect(notes.map(({ body, author }) => ({ body, author }))).toEqual([
            {
              body: 'ticket · high: It asks for two things at once.\nSplit it.',
              author: { _tag: 'organ', organ: 'triage' },
            },
          ])
          expect(ofKind(yield* records, 'triage')).toMatchObject([
            {
              ticket,
              title: 'It asks for two things at once.',
              detail: 'ticket · high',
            },
          ])
          expect((yield* holds.current).on).toEqual([])
          expect(yield* triage.awaited).toBe(false)
        }),
      ),
  )

  it.effect(
    "is asked with the ticket, its notes' end, the session's last turns and git",
    () =>
      scoped(
        Effect.gen(function* () {
          const transcript = [
            TranscriptEntry.cases.message.make({
              id: MessageId.make('m-1'),
              role: 'assistant',
              text: 'npm ',
              at: DateTime.makeUnsafe(0),
            }),
            TranscriptEntry.cases.text.make({
              message: MessageId.make('m-1'),
              delta: 'install failed',
            }),
          ]
          const { triage, came, prompts } = yield* triageOver(
            () => answering(verdict('code', 'low')),
            { transcript },
          )
          const ticket = yield* filed('Build one', 'Add the widget.')
          const graph = yield* WorkGraph
          yield* graph.note({
            id: ticket,
            body: `first said ${'x'.repeat(NOTES_KEPT)}`,
            actor: maintainer,
          })
          // Notes read oldest first, by when they were written.
          yield* TestClock.adjust('1 second')
          yield* graph.note({
            id: ticket,
            body: 'the last note',
            actor: maintainer,
          })
          yield* triage.setAside(setAside(ticket))
          yield* came
          const [prompt] = yield* Ref.get(prompts)
          expect(prompt).toContain(`Ticket ${ticket}: Build one`)
          expect(prompt).toContain('Add the widget.')
          expect(prompt).toContain(
            'set aside as DEFERRED: it needs a decision first',
          )
          expect(prompt).toContain('characters cut)')
          expect(prompt).not.toContain('first said')
          expect(prompt).toContain('maintainer: the last note')
          expect(prompt).toContain('assistant: npm install failed')
          expect(prompt).toContain(`Branch tutti/${ticket}, changing src/a.ts`)
          expect(prompt).toContain('uncommitted: src/b.ts')
        }),
      ),
  )

  it.effect.each([
    ['turned off', OrganOutcome.Disabled()],
    ['lost', OrganOutcome.NoResult({ reason: 'gone', spend: noSpend })],
  ] as const)('writes nothing where the organ is %s', ([, outcome]) =>
    scoped(
      Effect.gen(function* () {
        const { triage, came, records } = yield* triageOver(() =>
          Effect.succeed(outcome),
        )
        const ticket = yield* filed('Build one')
        yield* triage.setAside(setAside(ticket))
        yield* came
        expect(yield* notesOf(ticket)).toEqual([])
        expect(ofKind(yield* records, 'triage')).toEqual([])
      }),
    ),
  )
})

describe('environment verdicts', () => {
  it.effect(
    'two with high confidence raise the hold and put their tickets back, whatever came between',
    () =>
      scoped(
        Effect.gen(function* () {
          const { triage, came, holds, environment, reopened } =
            yield* triageOver(() =>
              answering(verdict('environment', 'high', 'The disk is full.')),
            )
          const one = yield* filed('One')
          const two = yield* filed('Two')
          yield* triage.setAside(setAside(one))
          yield* came
          expect((yield* holds.current).on).toEqual([])
          // A ticket's turn that worked ends the idle series, not this one.
          yield* environment.settled(Settle.Worked())
          yield* triage.setAside(setAside(two))
          yield* came
          const [hold] = (yield* holds.current).on
          expect(hold?.hold).toBe('ENVIRONMENT')
          expect(hold?.why).toContain('The disk is full.')
          expect(yield* Ref.get(reopened)).toEqual([one, two])
        }),
      ),
  )

  it.effect(
    'count for nothing below high confidence, nor do other causes',
    () =>
      scoped(
        Effect.gen(function* () {
          const answers = [
            verdict('environment', 'medium'),
            verdict('environment', 'low'),
            verdict('ticket', 'high'),
            verdict('environment', 'high'),
          ]
          const taken = yield* Ref.make(0)
          const { triage, came, holds } = yield* triageOver(() =>
            Effect.flatMap(
              Ref.getAndUpdate(taken, count => count + 1),
              at => answering(answers[at]),
            ),
          )
          yield* Effect.forEach(
            answers,
            (_, at) =>
              Effect.gen(function* () {
                yield* triage.setAside(setAside(yield* filed(`Ticket ${at}`)))
                yield* came
              }),
            { discard: true },
          )
          expect((yield* holds.current).on).toEqual([])
        }),
      ),
  )

  it.effect(
    'while the hold is on, put a ticket back to wait for the probe',
    () =>
      scoped(
        Effect.gen(function* () {
          const { triage, came, holds, reopened } = yield* triageOver(() =>
            answering(verdict('environment', 'high')),
          )
          yield* holds.raise({ hold: 'ENVIRONMENT', why: 'already on' })
          const one = yield* filed('One')
          yield* triage.setAside(setAside(one))
          yield* came
          expect(yield* Ref.get(reopened)).toEqual([one])
        }),
      ),
  )

  it('are a series idle turns and setups keep apart', () => {
    const one = TicketId.make('fa-one')
    const two = TicketId.make('fa-two')
    const heard = [
      Settle.Verdict({ ticket: one, why: 'a' }),
      Settle.Idle({ ticket: two, why: 'b' }),
      Settle.Worked(),
    ].reduce(counted, noCount)
    expect(heard.idle).toEqual([])
    expect(heard.verdicts).toEqual([{ ticket: one, why: 'a' }])
    expect(Option.isNone(tripped(heard))).toBe(true)
    expect(
      Option.map(
        tripped(counted(heard, Settle.Verdict({ ticket: two, why: 'c' }))),
        ({ tickets }) => tickets,
      ),
    ).toEqual(Option.some([one, two]))
  })
})

describe('a credentials hold', () => {
  it.effect('keeps the organ from a ticket set aside during it', () =>
    scoped(
      Effect.gen(function* () {
        const { triage, came, holds, asked, records } = yield* triageOver(() =>
          answering(verdict('environment', 'high')),
        )
        const during = yield* filed('During')
        yield* holds.raise({
          hold: 'CREDENTIALS',
          provider: 'anthropic',
          why: "anthropic's sign-in was refused",
        })
        yield* triage.setAside(setAside(during))
        expect(yield* triage.awaited).toBe(false)
        expect(yield* Ref.get(asked)).toEqual([])
        expect(yield* notesOf(during)).toEqual([])
        expect(ofKind(yield* records, 'info')).toMatchObject([
          { ticket: during, text: expect.stringContaining("isn't read") },
        ])
        // A ticket set aside once it lifted is read as any other.
        yield* holds.lift({
          hold: 'CREDENTIALS',
          provider: 'anthropic',
          why: 'signed in',
        })
        const after = yield* filed('After')
        yield* triage.setAside(setAside(after))
        expect(yield* came).toBe(after)
        expect(yield* Ref.get(asked)).toEqual([after])
      }),
    ),
  )
})

describe("the organ's queue", () => {
  it.effect("loses one ticket's verdict alone, said so", () =>
    scoped(
      Effect.gen(function* () {
        const one = yield* filed('One')
        const two = yield* filed('Two')
        const { triage, came, records } = yield* triageOver(
          () => answering(verdict('code', 'medium')),
          {
            graph: graph => ({
              show: graph.show,
              note: options =>
                options.id === one
                  ? Effect.die('the store fell over')
                  : graph.note(options),
            }),
          },
        )
        yield* triage.setAside(setAside(one))
        yield* triage.setAside(setAside(two))
        expect(yield* came).toBe(one)
        expect(yield* came).toBe(two)
        expect(yield* notesOf(one)).toEqual([])
        expect(yield* notesOf(two)).toHaveLength(1)
        expect(ofKind(yield* records, 'warn')).toMatchObject([
          {
            ticket: one,
            detail: 'TRIAGE',
            text: expect.stringContaining('the store fell over'),
          },
        ])
      }),
    ),
  )

  it.effect('reads tickets one at a time, and owes each until it is read', () =>
    scoped(
      Effect.gen(function* () {
        const reached = yield* Deferred.make<void>()
        const go = yield* Deferred.make<void>()
        const { triage, came, asked } = yield* triageOver(() =>
          Effect.andThen(
            Deferred.succeed(reached, undefined),
            Effect.andThen(
              Deferred.await(go),
              answering(verdict('code', 'medium')),
            ),
          ),
        )
        const one = yield* filed('One')
        const two = yield* filed('Two')
        yield* triage.setAside(setAside(one))
        yield* triage.setAside(setAside(two))
        expect(yield* triage.awaited).toBe(true)
        yield* Deferred.await(reached)
        expect(yield* Ref.get(asked)).toEqual([one])
        yield* Deferred.succeed(go, undefined)
        yield* came
        yield* came
        expect(yield* triage.awaited).toBe(false)
      }),
    ),
  )

  it.effect('stopped, says what it leaves unread', () =>
    scoped(
      Effect.gen(function* () {
        const reached = yield* Deferred.make<void>()
        const { triage, records } = yield* triageOver(() =>
          Effect.andThen(Deferred.succeed(reached, undefined), Effect.never),
        )
        yield* triage.setAside(setAside(yield* filed('One')))
        yield* triage.setAside(setAside(yield* filed('Two')))
        yield* Deferred.await(reached)
        yield* triage.stop
        expect(ofKind(yield* records, 'info')).toMatchObject([
          { text: expect.stringContaining('2 tickets set aside went unread') },
        ])
      }),
    ),
  )
})

describe('what the organ is given', () => {
  const message = (id: string, text: string) =>
    TranscriptEntry.cases.message.make({
      id: MessageId.make(id),
      role: 'assistant',
      text,
      at: DateTime.makeUnsafe(0),
    })
  const turnEnd = TranscriptEntry.cases.turn_end.make({
    at: DateTime.makeUnsafe(0),
    tokens: Option.none(),
  })

  it('keeps the last turns, with their tool calls, their output and their failures', () => {
    const entries = [
      ...Array.from({ length: TURNS_KEPT }, (_, at) => [
        message(`m-${at}`, `turn ${at}`),
        turnEnd,
      ]).flat(),
      message('m-last', 'running the tests'),
      TranscriptEntry.cases.thinking.make({
        message: MessageId.make('m-last'),
        delta: 'never given',
      }),
      TranscriptEntry.cases.tool_call.make({
        id: ToolCallId.make('t-1'),
        tool: 'bash',
        input: { command: 'pnpm test' },
        at: DateTime.makeUnsafe(0),
      }),
      TranscriptEntry.cases.tool_output.make({
        id: ToolCallId.make('t-1'),
        chunk: 'ENOSPC',
      }),
      TranscriptEntry.cases.tool_end.make({
        id: ToolCallId.make('t-1'),
        ok: false,
        at: DateTime.makeUnsafe(0),
      }),
    ]
    const text = lastTurns(entries)
    expect(text).not.toContain('turn 0')
    expect(text).toContain(`turn ${TURNS_KEPT - 1}`)
    expect(text).not.toContain('never given')
    expect(text).toContain('assistant: running the tests')
    expect(text).toContain('tool bash {"command":"pnpm test"}:\nENOSPC')
    expect(text).toContain('(the tool failed)')
  })

  it("keeps a part's end whole however it streamed, what it is and how much was cut", () => {
    const chunk = 'y'.repeat(100)
    const text = lastTurns([
      TranscriptEntry.cases.tool_call.make({
        id: ToolCallId.make('t-1'),
        tool: 'bash',
        input: { command: 'pnpm test' },
        at: DateTime.makeUnsafe(0),
      }),
      ...Array.from({ length: 50 }, () =>
        TranscriptEntry.cases.tool_output.make({
          id: ToolCallId.make('t-1'),
          chunk,
        }),
      ),
      TranscriptEntry.cases.tool_end.make({
        id: ToolCallId.make('t-1'),
        ok: false,
        at: DateTime.makeUnsafe(0),
      }),
      message('m-1', 'npm '),
      ...Array.from({ length: 20 }, () =>
        TranscriptEntry.cases.text.make({
          message: MessageId.make('m-1'),
          delta: chunk,
        }),
      ),
    ])
    const output = 5_000 + '\n(the tool failed)'.length
    expect(text).toContain(
      `tool bash {"command":"pnpm test"}:\n(${output - PART_TEXT_KEPT} characters cut)\n`,
    )
    expect(text).toContain('(the tool failed)\nassistant: (')
    expect(text).toContain(`(${2_004 - PART_TEXT_KEPT} characters cut)`)
  })

  it("keeps the end of a session's long turns", () => {
    const text = lastTurns([
      ...Array.from({ length: 20 }, (_, at) =>
        message(`m-${at}`, `${at}: ${'x'.repeat(PART_TEXT_KEPT - 10)}`),
      ),
      message('m-last', 'the end'),
    ])
    expect(text.startsWith('(')).toBe(true)
    expect(text).toContain('characters cut)\n')
    expect(text.endsWith('the end')).toBe(true)
    expect(text.length).toBeLessThan(TURNS_TEXT_KEPT + 40)
  })

  it('cuts text to its end, saying how much, on a whole character', () => {
    expect(keptEnd('short', 10)).toBe('short')
    expect(keptEnd('0123456789', 4)).toBe('(6 characters cut)\n6789')
    expect(keptEnd(`a${String.fromCodePoint(0x1f600)}b`, 2)).toBe(
      `(2 characters cut)\n${String.fromCodePoint(0xfffd)}b`,
    )
  })
})

/** Anthropic's stream of a call to `answer` with `answer`, as its API sends it. */
const answerStream = (answer: unknown) => ({
  contentType: 'text/event-stream; charset=utf-8',
  body: [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_01Triage',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 25, output_tokens: 1 },
        },
      },
    ],
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'toolu_01Answer',
          name: 'answer',
          input: {},
        },
      },
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify({ answer }),
        },
      },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 50 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ]
    .map(
      ([event, data]) =>
        `event: ${String(event)}\ndata: ${JSON.stringify(data)}\n\n`,
    )
    .join(''),
})

const anthropicModel = () => {
  const found = getBuiltinModels('anthropic').find(
    model => model.api === 'anthropic-messages',
  )
  if (found === undefined) throw new Error('no anthropic-messages model')
  return `anthropic/${found.id}`
}

const triaging = (extra: object = {}) => ({
  ...settings,
  organs: { triage: { model: anthropicModel(), ...extra } },
})

describe('a whole run', () => {
  it.effect(
    "waits for a deferred ticket's verdict, its note on the ticket, before it ends",
    () => {
      const fixture = project(triaging())
      return withRuns(
        fixture,
        Effect.gen(function* () {
          const { id } = yield* file('Build one', 'defer')
          const end = yield* runProject(configOf(fixture, options()))
          expect(end.kind).toBe('READY_EMPTY')
          const events = yield* eventsOf(fixture)
          expect(ofKind(events, 'triage')).toMatchObject([
            { ticket: id, detail: 'ticket · high' },
          ])
          expect(ofKind(events, 'organ')).toMatchObject([
            { organ: 'triage', ticket: id, outcome: 'answered' },
          ])
          const notes = yield* notesOf(id)
          expect(
            notes.flatMap(({ author, body }) =>
              author._tag === 'organ' ? [body] : [],
            ),
          ).toEqual(['ticket · high: Split it.'])
        }),
        answerStream(verdict('ticket', 'high', 'Split it.')),
      )
    },
  )

  it.effect('calls no model with triage turned off', () => {
    const fixture = project(triaging({ enabled: false }))
    return withRuns(
      fixture,
      Effect.gen(function* () {
        const { id } = yield* file('Build one', 'defer')
        const end = yield* runProject(configOf(fixture, options()))
        expect(end.kind).toBe('READY_EMPTY')
        const events = yield* eventsOf(fixture)
        expect(ofKind(events, 'organ')).toEqual([])
        expect(ofKind(events, 'triage')).toEqual([])
        expect(
          (yield* notesOf(id)).map(({ author }) => author),
        ).not.toContainEqual({ _tag: 'organ', organ: 'triage' })
      }),
      answerStream(verdict('ticket', 'high', 'Split it.')),
    )
  })

  it.effect(
    'holds for two high-confidence environment verdicts, and its probe decides',
    () => {
      const fixture = project(triaging())
      return withRuns(
        fixture,
        Effect.gen(function* () {
          const records = yield* (yield* RunLog).subscribe
          const one = yield* file('One', 'defer')
          const two = yield* file('Two', 'defer')
          const running = yield* Effect.forkChild(
            runProject(configOf(fixture, options())).pipe(
              Effect.provideService(EnvironmentProbe, {
                probe: () =>
                  Effect.succeed(ProbeOutcome.Failed({ reason: 'no disk' })),
              }),
            ),
          )
          yield* Effect.raceFirst(
            Effect.gen(function* () {
              while (true) {
                const event = yield* PubSub.take(records)
                if (event.kind === 'hold' && event.hold === 'ENVIRONMENT')
                  return
              }
            }),
            Fiber.await(running),
          )
          // The probe's wait begins as the hold's tickets are put back: the clock moves on until it probes.
          while (running.pollUnsafe() === undefined) {
            yield* TestClock.adjust(ENV_PROBE)
            yield* TestClock.withLive(Effect.sleep(Duration.millis(50)))
          }
          const end = yield* Fiber.join(running)
          expect(end.kind).toBe('ENVIRONMENT')
          expect(end.code).toBe(exitCodeOf('ENVIRONMENT'))
          const events = yield* eventsOf(fixture)
          expect(ofKind(events, 'triage').map(({ ticket }) => ticket)).toEqual(
            expect.arrayContaining([one.id, two.id]),
          )
          expect(
            ofKind(events, 'hold').find(({ hold }) => hold === 'ENVIRONMENT')
              ?.text,
          ).toContain('The disk is full.')
          expect(
            ofKind(events, 'reopened').map(({ ticket }) => ticket),
          ).toEqual(expect.arrayContaining([one.id, two.id]))
        }),
        answerStream(verdict('environment', 'high', 'The disk is full.')),
      )
    },
  )
})
