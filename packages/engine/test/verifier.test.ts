import { Effect, Option, Schema } from 'effect'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import { ModelChoice } from '@fabrica/contracts'

import { verifierModel, verifierTools } from '../src/run/verify'
import {
  git,
  ofKind,
  phasesOf,
  project,
  promptsOf,
  runOne,
  setUpFixtures,
  settings,
  wholeRun,
} from './verifier-harness'

// The verifier after `finish` (spec §13.6, H19, H89) in whole runs, over `verifier-harness`'s
// scripted Pi.

beforeAll(setUpFixtures)

describe('the verifier', () => {
  it.effect(
    'passes a finished change to the merge queue, reusing its check_own pass on the same tree',
    () =>
      Effect.gen(function* () {
        const fixture = project()
        const { id, end, events, detail, entries } = yield* runOne(
          fixture,
          'PASS',
        )
        expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
        expect(detail.ticket.status).toBe('closed')
        const phases = phasesOf(events, id)
        expect(phases.slice(0, 4)).toEqual([
          'queued (ready)',
          'working (dispatched)',
          'verifying (finished)',
          'waiting_to_merge (verified)',
        ])
        expect(phases.at(-1)).toBe('merged (merged into main)')
        const verifiers = promptsOf(entries, 'verifier')
        expect(verifiers).toHaveLength(1)
        const [verifier] = verifiers
        // Read-only: Pi's readers and bash, and its verdict.
        expect(verifier?.tools).toBe(verifierTools.join(','))
        expect(verifier?.tools).toBe('read,grep,find,ls,bash,verdict')
        expect(promptsOf(entries, 'worker')[0]?.tools).toBeNull()
        const prompt = verifier?.message ?? ''
        expect(prompt).toContain(`made for the ticket ${id}`)
        expect(prompt).toContain('round 1 of at most 3')
        expect(prompt).toContain(`The ticket, ${id}: Add the widget`)
        expect(prompt).toContain('Acceptance criteria:\nThe widget is there.')
        expect(prompt).toContain(`+++ b/${id}.txt`)
        expect(prompt).not.toContain("The earlier rounds' findings")
        // The worker's pass on the finished tree stands: the verifier is told so, its environment
        // names the tree, and check_own ran once, the worker's.
        const merged = Option.getOrThrow(detail.ticket.mergedCommit)
        const tree = git(fixture.checkout, 'rev-parse', `${merged}^{tree}`)
        expect(prompt).toContain(
          `The project's check_own passed on this tree, ${tree}`,
        )
        expect(prompt).toContain('Its results stand')
        expect(verifier?.passedAt).toBe(tree)
        expect(
          ofKind(events, 'check').filter(check => check.suite === 'own'),
        ).toHaveLength(1)
        // A worker's tool is refused to the verifier, a disagreement with no earlier round too, and
        // the verifier's tool to a worker.
        const exits = (role: string, tag: string) =>
          entries
            .filter(entry => entry.role === role && entry.tag === tag)
            .map(entry => entry.exit)
        expect(exits('verifier', 'add_note')).toEqual(['Failure'])
        expect(exits('verifier', 'verdict')).toEqual(['Failure', 'Success'])
        expect(exits('worker', 'verdict')).toEqual(['Failure'])
        expect(
          ofKind(events, 'info').some(event =>
            event.text.includes(`${id} verified in round 1 on ${tree}`),
          ),
        ).toBe(true)
      }),
    wholeRun,
  )

  it.effect(
    "hands a FAIL back to its worker's session with its findings, and passes the fix",
    () =>
      Effect.gen(function* () {
        const fixture = project()
        const { id, end, events, detail, entries } = yield* runOne(
          fixture,
          'FAIL,PASS',
        )
        expect(end.kind).toBe('READY_EMPTY')
        expect(detail.ticket.status).toBe('closed')
        expect(phasesOf(events, id).slice(1, 6)).toEqual([
          'working (dispatched)',
          'verifying (finished)',
          'working (verifier round 1: FAIL)',
          'verifying (finished again)',
          'waiting_to_merge (verified)',
        ])
        const workers = promptsOf(entries, 'worker')
        expect(workers).toHaveLength(2)
        const handBack = workers[1]?.message ?? ''
        expect(handBack).toContain(
          `The verifier's round 1 of at most 3 found your change of ${id} not done`,
        )
        expect(handBack).toContain('Round 1: FAIL. A gap in round 1.')
        expect(handBack).toContain(
          '- [blocking] src/x.ts:1 has no test, round 1',
        )
        expect(handBack).toContain('finish again')
        // The hand-back resumed the worker's own session.
        expect(
          entries.filter(
            entry => entry.role === 'worker' && entry.event === 'switch',
          ),
        ).toEqual([expect.objectContaining({ path: workers[0]?.sessionFile })])
        // The second round weighs the first's findings.
        const verifiers = promptsOf(entries, 'verifier')
        expect(verifiers).toHaveLength(2)
        expect(verifiers[1]?.message).toContain('round 2 of at most 3')
        expect(verifiers[1]?.message).toContain("The earlier rounds' findings")
        expect(verifiers[1]?.message).toContain(
          '- [blocking] src/x.ts:1 has no test, round 1',
        )
        // The second round's pass is the fix's: its own tree, named to the verifier.
        const merged = Option.getOrThrow(detail.ticket.mergedCommit)
        const tree = git(fixture.checkout, 'rev-parse', `${merged}^{tree}`)
        expect(verifiers[1]?.passedAt).toBe(tree)
        expect(verifiers[0]?.passedAt).not.toBe(tree)
        expect(existsSync(join(fixture.checkout, `${id}-fix-1.txt`))).toBe(true)
        expect(detail.notes.map(note => note.body)).toContain(
          'Verifier Round 1: FAIL. A gap in round 1.\n- [blocking] src/x.ts:1 has no test, round 1',
        )
        expect(
          ofKind(events, 'warn').map(event => event.text.trim()),
        ).toContain(
          `VERIFIER_FAIL: ${id} verifier round 1: FAIL: A gap in round 1.`,
        )
        expect(ofKind(events, 'settled').map(({ outcome }) => outcome)).toEqual(
          ['finish', 'finish'],
        )
      }),
    wholeRun,
  )

  it.effect(
    'stops at verifier.rounds: the last FAIL goes back, and the finish after it merges unverified',
    () =>
      Effect.gen(function* () {
        const fixture = project({ ...settings, verifier: { rounds: 2 } })
        const { id, end, events, detail, entries } = yield* runOne(
          fixture,
          'FAIL',
        )
        expect(end.kind).toBe('READY_EMPTY')
        expect(promptsOf(entries, 'verifier')).toHaveLength(2)
        const workers = promptsOf(entries, 'worker')
        expect(workers).toHaveLength(3)
        expect(workers[1]?.message).toContain('finish again')
        const last = workers[2]?.message ?? ''
        expect(last).toContain("The verifier's round 2 of at most 2")
        expect(last).toContain('That was the last round')
        expect(last).toContain("The earlier rounds' findings")
        expect(last).toContain('src/x.ts:1 has no test, round 1')
        expect(phasesOf(events, id)).toContain(
          "waiting_to_merge (finished past the verifier's last round, 2)",
        )
        expect(detail.ticket.status).toBe('closed')
        expect(
          detail.notes.filter(note => note.body.startsWith('Verifier Round')),
        ).toHaveLength(2)
      }),
    wholeRun,
  )

  it.effect(
    'hands a round that disagrees with an earlier one back for the worker to ask the maintainer',
    () =>
      Effect.gen(function* () {
        const fixture = project()
        const { id, events, detail, entries } = yield* runOne(
          fixture,
          'FAIL,DISAGREE',
        )
        // No third round: the worker asked instead.
        expect(promptsOf(entries, 'verifier')).toHaveLength(2)
        const workers = promptsOf(entries, 'worker')
        expect(workers).toHaveLength(3)
        const asking = workers[2]?.message ?? ''
        expect(asking).toContain(
          `The verifier's round 2 on ${id} disagrees with round 1:`,
        )
        expect(asking).toContain(
          '- [blocking] DISAGREES WITH ROUND 1: the ticket asks for no such test',
        )
        expect(asking).toContain('src/x.ts:1 has no test, round 1')
        expect(asking).toContain('ask the maintainer which holds')
        expect(phasesOf(events, id)).toContain(
          'working (verifier round 2 disagrees with round 1)',
        )
        expect(ofKind(events, 'asked')).toEqual([
          expect.objectContaining({ ticket: id }),
        ])
        expect(detail.ticket.status).not.toBe('closed')
      }),
    wholeRun,
  )

  it.effect(
    'sets aside a change its verifier gave no verdict on',
    () =>
      Effect.gen(function* () {
        const fixture = project()
        const { id, events, detail } = yield* runOne(fixture, 'none')
        expect(phasesOf(events, id)).toContain(
          'set_aside (its verifier settled with no verdict in round 1)',
        )
        expect(detail.ticket.status).toBe('deferred')
      }),
    wholeRun,
  )

  it.effect(
    'is skipped where verifier.enabled is false: a finish goes to the merge queue',
    () =>
      Effect.gen(function* () {
        const fixture = project({ ...settings, verifier: { enabled: false } })
        const { id, end, events, detail, entries } = yield* runOne(
          fixture,
          'FAIL',
        )
        expect(end.kind).toBe('READY_EMPTY')
        expect(detail.ticket.status).toBe('closed')
        expect(promptsOf(entries, 'verifier')).toEqual([])
        expect(phasesOf(events, id)).toContain('waiting_to_merge (finished)')
        expect(
          phasesOf(events, id).some(phase => phase.startsWith('verifying')),
        ).toBe(false)
      }),
    wholeRun,
  )
})

describe("the verifier's model", () => {
  const choice = (written: string) =>
    Schema.decodeUnknownSync(ModelChoice)(written)
  const worker = Option.some({ provider: 'anthropic', modelId: 'claude-x' })

  it('is verifier.model where it is set', () => {
    expect(
      verifierModel({
        verifier: Option.some(choice('anthropic/claude-y')),
        configured: [choice('openai/gpt-z')],
        worker,
      }),
    ).toEqual(Option.some({ provider: 'anthropic', modelId: 'claude-y' }))
  })

  it("is else a configured model of another provider than the worker's", () => {
    expect(
      verifierModel({
        verifier: Option.none(),
        configured: [
          choice('anthropic/claude-x'),
          choice('openai/gpt-z'),
          choice('google/gemini-w'),
        ],
        worker,
      }),
    ).toEqual(Option.some({ provider: 'openai', modelId: 'gpt-z' }))
  })

  it("is else the worker's own", () => {
    expect(
      verifierModel({
        verifier: Option.none(),
        configured: [choice('anthropic/claude-x')],
        worker,
      }),
    ).toEqual(worker)
  })
})
