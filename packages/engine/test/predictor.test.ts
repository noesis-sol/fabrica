import { Deferred, Effect, Fiber, Option, Schema } from 'effect'
import { type ServerResponse, createServer } from 'node:http'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import { type Ticket, TicketId, TicketMetadata } from '@fabrica/contracts'

import { noSpend } from '../src/cost'
import {
  FootprintSource,
  makeRepository,
  ticketFootprint,
} from '../src/footprints'
import { Git, ticketBranch } from '../src/git'
import {
  OrganOutcome,
  type OrganQuestion,
  type OrganRuntime,
  type PredictorCandidate,
  guessedFiles,
  isTestFile,
  makePredictor,
  mentionsTests,
  predictorPrompt,
} from '../src/organs'
import { runProject } from '../src/run'
import { WorkGraph } from '../src/workgraph'
import {
  commit,
  configOf,
  eventsOf,
  file,
  git,
  ofKind,
  options,
  project,
  services,
  setUpRuns,
  settings,
  withRuns,
} from './run-harness'

// The predictor (spec §16, §13.4): a model's guess at the files a ticket naming none will change, kept
// on the ticket as `predicted_files`, which its footprint reads. The rules on given tickets; the organ
// on real git and the work graph over a stand-in for the organs' runtime, whose own tests are its own;
// then a whole run through the live proxy, with a loopback provider giving the guess.

const repository = makeRepository([
  'README.md',
  'src/loop.ts',
  'src/loop.test.ts',
  'test/loop-suite.ts',
])

const declared = { declares: () => false }

const metadataOf = Schema.decodeUnknownSync(TicketMetadata)

const footprintOf = (ticket: Ticket) =>
  ticketFootprint({ ticket: { ticket, labels: [] }, repository, declared })

/** A stand-in for the runtime: what it was asked, and the answer `reply` gives each question. */
const organsAnswering = (
  reply: (ticket: TicketId) => Effect.Effect<OrganOutcome<unknown>>,
) => {
  const asked: Array<{ ticket: TicketId; prompt: string }> = []
  const organs: Pick<OrganRuntime, 'ask'> = {
    ask: <A>(question: OrganQuestion<A>) =>
      Effect.gen(function* () {
        const ticket = Option.getOrThrow(question.ticket)
        asked.push({ ticket, prompt: yield* question.prompt })
        const outcome = yield* reply(ticket)
        if (!OrganOutcome.$is('Answered')(outcome)) return outcome
        const answer = yield* Schema.decodeUnknownEffect(question.answer)(
          outcome.answer,
        ).pipe(Effect.orDie)
        return OrganOutcome.Answered({ answer, spend: outcome.spend })
      }),
  }
  return { organs, asked }
}

const guess = (files: ReadonlyArray<string>) =>
  Effect.succeed(
    OrganOutcome.Answered<unknown>({ answer: { files }, spend: noSpend }),
  )

const candidate = (ticket: Ticket, solo = false): PredictorCandidate => ({
  ticket,
  footprint: footprintOf(ticket),
  solo,
})

describe("the predictor's rules", () => {
  it.each([
    ['src/loop.test.ts', true],
    ['src/loop.spec.tsx', true],
    ['test/loop-suite.ts', true],
    ['pkg/__snapshots__/a.snap', true],
    ['tests/fixtures/a.json', true],
    ['test_loop.py', true],
    ['loop_test.go', true],
    ['LoopTest.java', true],
    ['src/loop.ts', false],
    ['src/latest.ts', false],
    ['docs/contest.md', false],
    ['README.md', false],
    ['docs/spec/fabrica-spec.md', false],
    ['src/spec/run.ts', false],
    ['spec/run_spec.rb', true],
    ['spec/helper.rb', true],
    ['test/README.md', false],
  ])('tells %s a test: %s', (path, test) => {
    expect(isTestFile(path)).toBe(test)
  })

  it.each([
    ['Add a test for it', true],
    ['The tests pass', true],
    ['Unittests stay', true],
    ['Make it faster', false],
    ['The latest contest', false],
  ])('reads %s as mentioning tests: %s', (text, mentions) => {
    expect(mentionsTests(text)).toBe(mentions)
  })

  const asTicket = (fields: Partial<Ticket>) => ({
    id: TicketId.make('fa-1'),
    title: 'Make it faster',
    description: Option.none<string>(),
    design: Option.none<string>(),
    acceptance: Option.none<string>(),
    ...fields,
  })

  it('leaves tests out of the file list unless the ticket mentions them', () => {
    const left = predictorPrompt(asTicket({}), repository)
    expect(left).toContain('src/loop.ts')
    expect(left).toContain('README.md')
    expect(left).not.toContain('src/loop.test.ts')
    expect(left).not.toContain('test/loop-suite.ts')
    const kept = predictorPrompt(
      asTicket({ acceptance: Option.some('Tests cover it') }),
      repository,
    )
    expect(kept).toContain('src/loop.test.ts')
    expect(kept).toContain('test/loop-suite.ts')
  })

  it('gives the ticket its own words, its notes not among them', () => {
    const prompt = predictorPrompt(
      asTicket({
        description: Option.some('The look is slow'),
        design: Option.some('Cache it'),
        acceptance: Option.some('It is quick'),
      }),
      repository,
    )
    for (const words of [
      'Make it faster',
      'The look is slow',
      'Cache it',
      'It is quick',
    ])
      expect(prompt).toContain(words)
  })

  it('keeps the file list within its budget, saying how many were cut', () => {
    const many = Array.from(
      { length: 40_000 },
      (_, n) => `src/${String(n).padStart(8, '0')}.ts`,
    )
    const prompt = predictorPrompt(asTicket({}), makeRepository(many))
    expect(prompt.length).toBeLessThan(201_000)
    const shown = prompt.match(/^src\//gmu)?.length ?? 0
    expect(shown).toBeGreaterThan(0)
    expect(prompt).toContain(`(${40_000 - shown} more files aren't shown.)`)
  })

  it('takes tracked files and new ones from an answer, each once, no folder or glob', () => {
    expect(
      guessedFiles(
        {
          files: [
            './src/loop.ts',
            'src/loop.ts',
            'src/added.ts',
            'src',
            'src/**',
            '**',
            '../outside.ts',
          ],
        },
        repository,
      ),
    ).toEqual(['src/loop.ts', 'src/added.ts'])
  })
})

beforeAll(setUpRuns)

/** The project's work graph, and a predictor over `reply`, with what wakes the run counted. */
const predictorIn = (
  fixture: ReturnType<typeof project>,
  reply: (ticket: TicketId) => Effect.Effect<OrganOutcome<unknown>>,
  enabled = true,
) =>
  Effect.gen(function* () {
    const stand = organsAnswering(reply)
    const woken = yield* Deferred.make<void>()
    const predictor = yield* makePredictor({
      organs: stand.organs,
      checkout: fixture.checkout,
      base: 'main',
      enabled,
      woken: Deferred.succeed(woken, undefined).pipe(Effect.asVoid),
    })
    return { predictor, woken, asked: stand.asked }
  })

const reread = (id: TicketId) =>
  Effect.flatMap(WorkGraph, graph =>
    Effect.map(graph.show(id), ({ ticket }) => ticket),
  )

describe('the predictor', () => {
  it.effect(
    "keeps its guess as the ticket's predicted_files, which its footprint reads",
    () => {
      const fixture = project(settings, { 'src/loop.ts': 'one\n' })
      return withRuns(
        fixture,
        Effect.gen(function* () {
          const ticket = yield* file('Make it faster', 'finish')
          const answer = yield* Deferred.make<void>()
          const { predictor, woken, asked } = yield* predictorIn(fixture, () =>
            Effect.andThen(
              Deferred.await(answer),
              guess(['src/loop.ts', 'src']),
            ),
          )
          const first = yield* predictor.offer({
            ready: [candidate(ticket)],
            free: 2,
          })
          // It waits for the guess, and its wait keeps the run.
          expect([...first]).toEqual([ticket.id])
          expect(yield* predictor.asking).toBe(true)
          yield* Deferred.succeed(answer, undefined)
          yield* Deferred.await(woken)
          // It waits until the run has read the ready tickets since.
          expect(yield* predictor.asking).toBe(true)
          yield* predictor.reading(Effect.void)
          expect(yield* predictor.asking).toBe(false)
          const after = yield* reread(ticket.id)
          expect(Option.getOrThrow(after.metadata.predicted_files)).toEqual([
            'src/loop.ts',
          ])
          const footprint = footprintOf(after)
          expect(FootprintSource.$is('Predicted')(footprint.source)).toBe(true)
          expect(footprint.places.map(place => place._tag)).toEqual(['File'])
          // Asked once, in the checkout's files.
          expect(asked.map(({ ticket: id }) => id)).toEqual([ticket.id])
          expect(asked[0]?.prompt).toContain('src/loop.ts')
          expect(asked[0]?.prompt).toContain('Make it faster')
          const again = yield* predictor.offer({
            ready: [candidate(after)],
            free: 2,
          })
          expect(again.size).toBe(0)
          expect(asked).toHaveLength(1)
        }),
      )
    },
  )

  it.effect('keeps what else the metadata has beside the guess', () => {
    const fixture = project()
    return withRuns(
      fixture,
      Effect.gen(function* () {
        const ticket = yield* file('Make it faster', 'finish', {
          metadata: metadataOf({ spec: 'docs/spec.md' }),
        })
        const { predictor, woken } = yield* predictorIn(fixture, () =>
          guess(['src/new.ts']),
        )
        yield* predictor.offer({ ready: [candidate(ticket)], free: 3 })
        yield* Deferred.await(woken)
        const after = yield* reread(ticket.id)
        expect(after.metadata.spec).toEqual(Option.some('docs/spec.md'))
        expect(after.metadata.predicted_files).toEqual(
          Option.some(['src/new.ts']),
        )
      }),
    )
  })

  it.effect('an answer of no files is kept, and not asked for again', () => {
    const fixture = project()
    return withRuns(
      fixture,
      Effect.gen(function* () {
        const ticket = yield* file('Make it faster', 'finish')
        const { predictor, woken } = yield* predictorIn(fixture, () =>
          guess([]),
        )
        yield* predictor.offer({ ready: [candidate(ticket)], free: 2 })
        yield* Deferred.await(woken)
        const after = yield* reread(ticket.id)
        expect(after.metadata.predicted_files).toEqual(Option.some([]))
        expect(FootprintSource.$is('Nothing')(footprintOf(after).source)).toBe(
          true,
        )
        // A later run asks nothing either.
        const later = yield* predictorIn(fixture, () => guess(['src/x.ts']))
        const waits = yield* later.predictor.offer({
          ready: [candidate(after)],
          free: 2,
        })
        expect(waits.size).toBe(0)
        expect(later.asked).toHaveLength(0)
      }),
    )
  })

  it.effect(
    'asks about as many tickets at a time as slots are free, the others to wait their turn',
    () => {
      const fixture = project()
      return withRuns(
        fixture,
        Effect.gen(function* () {
          const made = yield* Effect.all([
            file('Make it faster', 'finish'),
            file('Make it smaller', 'finish'),
            file('Make it quieter', 'finish'),
          ])
          const [first, second, third] = made
          let reached = 0
          const both = yield* Deferred.make<void>()
          // The questions never answer: the two asked are all there are until one does.
          const { predictor, asked } = yield* predictorIn(fixture, () =>
            Effect.suspend(() => {
              reached += 1
              return reached === 2
                ? Deferred.succeed(both, undefined)
                : Effect.void
            }).pipe(Effect.andThen(Effect.never)),
          )
          const ready = made.map(ticket => candidate(ticket))
          const waits = yield* predictor.offer({ ready, free: 2 })
          // None of them runs yet, whether asked about or to be.
          expect([...waits].sort()).toEqual(
            [first.id, second.id, third.id].sort(),
          )
          yield* Deferred.await(both)
          expect(asked.map(({ ticket }) => ticket).sort()).toEqual(
            [first.id, second.id].sort(),
          )
          // With no slot more to ask with, the third waits still, unasked.
          const still = yield* predictor.offer({ ready, free: 2 })
          expect(still.has(third.id)).toBe(true)
          expect(asked).toHaveLength(2)
        }),
      )
    },
  )

  it.effect(
    "doesn't let a look weigh a ticket as it was before its question ended",
    () => {
      const fixture = project()
      return withRuns(
        fixture,
        Effect.gen(function* () {
          const ticket = yield* file('Make it faster', 'finish')
          const answer = yield* Deferred.make<void>()
          const { predictor, woken } = yield* predictorIn(fixture, () =>
            Effect.andThen(Deferred.await(answer), guess(['src/x.ts'])),
          )
          const stale = candidate(ticket)
          yield* predictor.offer({ ready: [stale], free: 2 })
          // Its question ends during the read of the ready tickets: that read may not have its guess.
          yield* predictor.reading(
            Effect.andThen(
              Deferred.succeed(answer, undefined),
              Deferred.await(woken),
            ),
          )
          const during = yield* predictor.offer({ ready: [stale], free: 2 })
          expect([...during]).toEqual([ticket.id])
          // A read begun since has it.
          yield* predictor.reading(Effect.void)
          expect(yield* predictor.asking).toBe(false)
          const after = yield* predictor.offer({
            ready: [candidate(yield* reread(ticket.id))],
            free: 2,
          })
          expect(after.size).toBe(0)
        }),
      )
    },
  )

  it.effect(
    'leaves a ticket waiting no more though its question ended during the reads of a later offer',
    () => {
      const fixture = project()
      return withRuns(
        fixture,
        Effect.gen(function* () {
          const first = yield* file('Make it faster', 'finish')
          const second = yield* file('Make it smaller', 'finish')
          const real = yield* Git
          const reached = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const answer = yield* Deferred.make<void>()
          const stand = organsAnswering(id =>
            id === first.id
              ? Effect.andThen(Deferred.await(answer), guess(['src/x.ts']))
              : guess(['src/y.ts']),
          )
          const firstEnded = yield* Deferred.make<void>()
          const allEnded = yield* Deferred.make<void>()
          let wakes = 0
          const predictor = yield* makePredictor({
            organs: stand.organs,
            checkout: fixture.checkout,
            base: 'main',
            enabled: true,
            woken: Effect.suspend(() => {
              wakes += 1
              return Deferred.succeed(
                wakes === 1 ? firstEnded : allEnded,
                undefined,
              ).pipe(Effect.asVoid)
            }),
          }).pipe(
            Effect.provideService(
              Git,
              Git.of({
                ...real,
                commitHash: input =>
                  input.revision === ticketBranch(second.id)
                    ? Deferred.succeed(reached, undefined).pipe(
                        Effect.andThen(Deferred.await(release)),
                        Effect.andThen(real.commitHash(input)),
                      )
                    : real.commitHash(input),
              }),
            ),
          )
          yield* predictor.offer({ ready: [candidate(first)], free: 3 })
          const later = yield* Effect.forkChild(
            predictor.offer({ ready: [candidate(second)], free: 3 }),
          )
          yield* Deferred.await(reached)
          yield* Deferred.succeed(answer, undefined)
          yield* Deferred.await(firstEnded)
          yield* predictor.reading(Effect.void)
          yield* Deferred.succeed(release, undefined)
          const waits = yield* Fiber.join(later)
          expect([...waits]).toEqual([second.id])
          yield* Deferred.await(allEnded)
          yield* predictor.reading(Effect.void)
          expect(yield* predictor.asking).toBe(false)
        }),
      )
    },
  )

  describe('skips', () => {
    /** Offers `ready` with `free` slots: no question asked, and no ticket waiting. */
    const skips = (
      fixture: ReturnType<typeof project>,
      ready: ReadonlyArray<PredictorCandidate>,
      free: number,
      enabled = true,
    ) =>
      Effect.gen(function* () {
        const { predictor, asked } = yield* predictorIn(
          fixture,
          () => guess(['src/x.ts']),
          enabled,
        )
        const waits = yield* predictor.offer({ ready, free })
        expect(waits.size).toBe(0)
        expect(yield* predictor.asking).toBe(false)
        expect(asked).toHaveLength(0)
      })

    it.effect.each([0, 1])('with %d slots free', free => {
      const fixture = project()
      return withRuns(
        fixture,
        Effect.flatMap(file('Make it faster', 'finish'), ticket =>
          skips(fixture, [candidate(ticket)], free),
        ),
      )
    })

    it.effect('a ticket giving its files', () => {
      const fixture = project()
      return withRuns(
        fixture,
        Effect.flatMap(
          file('Make it faster', 'finish', {
            metadata: metadataOf({ files: ['src/loop.ts'] }),
          }),
          ticket => skips(fixture, [candidate(ticket)], 2),
        ),
      )
    })

    it.effect('a ticket whose text names a file', () => {
      const fixture = project()
      return withRuns(
        fixture,
        Effect.flatMap(file('Make src/loop.ts faster', 'finish'), ticket =>
          skips(fixture, [candidate(ticket)], 2),
        ),
      )
    })

    it.effect('a ticket guessed at already', () => {
      const fixture = project()
      return withRuns(
        fixture,
        Effect.flatMap(
          file('Make it faster', 'finish', {
            metadata: metadataOf({ predicted_files: ['src/loop.ts'] }),
          }),
          ticket => skips(fixture, [candidate(ticket)], 2),
        ),
      )
    })

    it.effect('a solo ticket, which runs beside nothing', () => {
      const fixture = project()
      return withRuns(
        fixture,
        Effect.flatMap(file('Make it faster', 'finish'), ticket =>
          skips(fixture, [candidate(ticket, true)], 2),
        ),
      )
    })

    it.effect('every ticket, with the organ turned off', () => {
      const fixture = project()
      return withRuns(
        fixture,
        Effect.flatMap(file('Make it faster', 'finish'), ticket =>
          skips(fixture, [candidate(ticket)], 2, false),
        ),
      )
    })

    it.effect('a ticket with commits on its branch', () => {
      const fixture = project()
      return withRuns(
        fixture,
        Effect.gen(function* () {
          const ticket = yield* file('Make it faster', 'finish')
          git(fixture.checkout, 'checkout', '-b', ticketBranch(ticket.id))
          commit(fixture.checkout, 'its work', { 'src/own.ts': 'one\n' })
          git(fixture.checkout, 'checkout', 'main')
          yield* skips(fixture, [candidate(ticket)], 2)
        }),
      )
    })
  })

  it.effect(
    'asks about a ticket whose branch has no commits of its own',
    () => {
      const fixture = project()
      return withRuns(
        fixture,
        Effect.gen(function* () {
          const ticket = yield* file('Make it faster', 'finish')
          git(fixture.checkout, 'branch', ticketBranch(ticket.id))
          const { predictor, woken, asked } = yield* predictorIn(fixture, () =>
            guess(['src/x.ts']),
          )
          yield* predictor.offer({ ready: [candidate(ticket)], free: 2 })
          yield* Deferred.await(woken)
          expect(asked).toHaveLength(1)
        }),
      )
    },
  )

  it.effect(
    'a guess lost is that ticket alone, not asked for again, and the others go on',
    () => {
      const fixture = project()
      return withRuns(
        fixture,
        Effect.gen(function* () {
          const lost = yield* file('Make it faster', 'finish')
          const broken = yield* file('Make it smaller', 'finish')
          const kept = yield* file('Make it quieter', 'finish')
          const stand = organsAnswering(ticket =>
            ticket === lost.id
              ? Effect.succeed(
                  OrganOutcome.NoResult({ reason: 'lost', spend: noSpend }),
                )
              : ticket === broken.id
                ? Effect.die('a defect')
                : guess(['src/x.ts']),
          )
          let wakes = 0
          const all = yield* Deferred.make<void>()
          const predictor = yield* makePredictor({
            organs: stand.organs,
            checkout: fixture.checkout,
            base: 'main',
            enabled: true,
            woken: Effect.suspend(() => {
              wakes += 1
              return wakes === 3
                ? Effect.asVoid(Deferred.succeed(all, undefined))
                : Effect.void
            }),
          })
          const ready = [lost, broken, kept].map(ticket => candidate(ticket))
          const waits = yield* predictor.offer({ ready, free: 3 })
          expect(waits.size).toBe(3)
          yield* Deferred.await(all)
          yield* predictor.reading(Effect.void)
          expect(yield* predictor.asking).toBe(false)
          const after = yield* reread(kept.id)
          expect(after.metadata.predicted_files).toEqual(
            Option.some(['src/x.ts']),
          )
          expect((yield* reread(lost.id)).metadata.predicted_files).toEqual(
            Option.none(),
          )
          // None of them is asked about again: they go on without a guess.
          const again = yield* predictor.offer({ ready, free: 3 })
          expect(again.size).toBe(0)
          expect(stand.asked).toHaveLength(3)
        }),
      )
    },
  )
})

/** Anthropic's stream of a call to `answer` with `input`. */
const answered = (input: unknown): string =>
  [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_01Guess',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5-20250929',
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
          id: 'toolu_01Guess',
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
          partial_json: JSON.stringify(input),
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
    .join('')

/** A loopback Anthropic that guesses `files`, and takes a worker's every other call. */
const guessingProvider = (files: ReadonlyArray<string>) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly url: string; readonly close: () => void }>(
      resume => {
        const reply = (response: ServerResponse) => {
          response.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
          })
          response.end(answered({ answer: { files } }))
        }
        const server = createServer((request, response) => {
          request.resume()
          request.on('end', () => reply(response))
        })
        server.listen({ host: '127.0.0.1', port: 0 }, () => {
          const address = server.address()
          const port =
            typeof address === 'object' && address !== null ? address.port : 0
          resume(
            Effect.succeed({
              url: `http://127.0.0.1:${port}`,
              close: () => {
                server.close()
                server.closeAllConnections()
              },
            }),
          )
        })
      },
    ),
    provider => Effect.sync(provider.close),
  )

describe('the predictor in a run', () => {
  it.effect(
    "dispatches a ticket naming nothing with its guess as its footprint, after one it doesn't wait for",
    () => {
      const fixture = project(
        {
          ...settings,
          organs: { predictor: { model: 'anthropic/claude-sonnet-4-5' } },
        },
        { 'src/x.ts': 'one\n' },
      )
      return Effect.gen(function* () {
        const provider = yield* guessingProvider(['src/x.ts'])
        return yield* Effect.gen(function* () {
          const named = yield* file('Change the one', 'finish', {
            metadata: metadataOf({ files: ['src/x.ts'] }),
          })
          const nothing = yield* file('Make it faster', 'finish')
          const end = yield* runProject(configOf(fixture, options()))
          const events = yield* eventsOf(fixture)
          expect(end.kind).toBe('READY_EMPTY')
          // The ticket with a footprint went first; the other had its guess before it was weighed.
          expect(
            ofKind(events, 'dispatch').map(({ ticket }) => ticket),
          ).toEqual([named.id, nothing.id])
          expect(
            ofKind(events, 'organ').map(({ organ, ticket, outcome }) => ({
              organ,
              ticket,
              outcome,
            })),
          ).toEqual([
            { organ: 'predictor', ticket: nothing.id, outcome: 'answered' },
          ])
          expect(ofKind(events, 'info').map(({ text }) => text)).toContain(
            `  ${nothing.id} footprint: src/x.ts, (predicted)`,
          )
          const after = yield* reread(nothing.id)
          expect(after.metadata.predicted_files).toEqual(
            Option.some(['src/x.ts']),
          )
        }).pipe(Effect.provide(services(fixture, provider.url)))
      }).pipe(Effect.scoped)
    },
  )

  it.effect('guesses at every ticket naming nothing in turn', () => {
    const fixture = project(
      {
        ...settings,
        organs: { predictor: { model: 'anthropic/claude-sonnet-4-5' } },
      },
      { 'src/x.ts': 'one\n' },
    )
    return Effect.gen(function* () {
      const provider = yield* guessingProvider(['src/x.ts'])
      return yield* Effect.gen(function* () {
        const made = yield* Effect.all([
          file('Make it faster', 'finish'),
          file('Make it smaller', 'finish'),
          file('Make it quieter', 'finish'),
        ])
        const end = yield* runProject(configOf(fixture, options()))
        const events = yield* eventsOf(fixture)
        expect(end.kind).toBe('READY_EMPTY')
        const ids = made.map(({ id }) => id).sort()
        expect(
          ofKind(events, 'dispatch')
            .map(({ ticket }) => ticket)
            .sort(),
        ).toEqual(ids)
        expect(
          ofKind(events, 'organ')
            .map(({ ticket }) => ticket)
            .sort(),
        ).toEqual(ids)
      }).pipe(Effect.provide(services(fixture, provider.url)))
    }).pipe(Effect.scoped)
  })

  it.effect(
    'holds two tickets apart on the file both are guessed to change',
    () => {
      const fixture = project(
        {
          ...settings,
          organs: { predictor: { model: 'anthropic/claude-sonnet-4-5' } },
        },
        { 'src/x.ts': 'one\n' },
      )
      return Effect.gen(function* () {
        // Each worker does change it, a file no ticket's text can name yet: past its work, a ticket
        // holds on what its branch changed.
        const provider = yield* guessingProvider(['new.txt'])
        return yield* Effect.gen(function* () {
          yield* file('Make it faster', 'finish new.txt')
          yield* file('Make it smaller', 'finish new.txt')
          const end = yield* runProject(configOf(fixture, options()))
          const events = yield* eventsOf(fixture)
          expect(end.kind).toBe('READY_EMPTY')
          const [one, other] = ofKind(events, 'dispatch')
          if (one === undefined || other === undefined)
            throw new Error('two dispatches')
          const closed = events.findIndex(
            event => event.kind === 'closed' && event.ticket === one.ticket,
          )
          expect(closed).toBeGreaterThan(-1)
          expect(closed).toBeLessThan(events.indexOf(other))
          expect(ofKind(events, 'info').map(({ text }) => text)).toContain(
            `  ${one.ticket} footprint: new.txt, (predicted)`,
          )
          expect(ofKind(events, 'organ').map(({ outcome }) => outcome)).toEqual(
            ['answered', 'answered'],
          )
        }).pipe(Effect.provide(services(fixture, provider.url)))
      }).pipe(Effect.scoped)
    },
  )

  it.effect(
    'goes on without a guess where the organ loses it, and the run ends with nothing left waiting',
    () => {
      // The default settings' model is in no catalog: the organ's question is lost.
      const fixture = project()
      return withRuns(
        fixture,
        Effect.gen(function* () {
          const nothing = yield* file('Make it faster', 'finish')
          const end = yield* runProject(configOf(fixture, options()))
          const events = yield* eventsOf(fixture)
          expect(end.kind).toBe('READY_EMPTY')
          expect(
            ofKind(events, 'dispatch').map(({ ticket }) => ticket),
          ).toEqual([nothing.id])
          expect(ofKind(events, 'organ').map(({ outcome }) => outcome)).toEqual(
            ['no_result'],
          )
          expect(ofKind(events, 'info').map(({ text }) => text)).toContain(
            `  ${nothing.id} footprint: nothing named`,
          )
        }),
      )
    },
  )
})
