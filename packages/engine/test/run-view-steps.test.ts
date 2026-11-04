import { DateTime, Option } from 'effect'

import { describe, expect, it, vi } from '@effect/vitest'
import {
  EngineId,
  EngineStep,
  ProjectId,
  RunHeader,
  RunId,
  RunMode,
  type RunView,
} from '@fabrica/contracts'

import { type ViewInputs, projectView } from '../src/view'

// The cost of a long run's steps (spec §8.3): a write reads what each step says once. A read per step and
// earlier step is cubic in the steps over a run's writes, and took a test of 260 writes 8 s alone and past
// its limit on a loaded machine, so this counts the reads: a test's time says little on a loaded machine.

const header = new RunHeader({
  run: RunId.make('2026-10-30T09:00:00+01:00'),
  project: ProjectId.make('work'),
  engine: EngineId.make('engine-1'),
  mode: RunMode.cases.tickets.make({}),
  state: 'running',
  startedAt: DateTime.makeUnsafe(0),
  offline: false,
  autoAnswer: false,
})

/** The inputs of a write whose steps are `count` steps, made afresh as each write makes them. */
const inputsOf = (count: number): ViewInputs => ({
  header,
  now: DateTime.makeUnsafe(1000),
  tickets: [],
  facts: new Map(),
  slots: 2,
  line: { merging: Option.none(), waiting: [] },
  mergesWait: Option.none(),
  battery: Option.none(),
  workers: [],
  steps: Array.from(
    { length: count },
    (_, n) =>
      new EngineStep({
        step: 'install',
        ticket: Option.none(),
        startedAt: DateTime.makeUnsafe(n),
      }),
  ),
  doneToday: 0,
  spent: new Map(),
  tokens: { input: 0, output: 0, cache_write: 0, cache_read: 0 },
  holds: [],
  attention: [],
  load: Option.none(),
})

/** The view of `count` steps over the view of as many, with how many values it read to make it. */
const writeOver = (count: number) => {
  const before: RunView = projectView(inputsOf(count), Option.none())
  const reads = vi.spyOn(JSON, 'stringify')
  const after = projectView(inputsOf(count), Option.some(before))
  const read = reads.mock.calls.length
  reads.mockRestore()
  return { before, after, read }
}

describe("a long run's steps", () => {
  it('are each read a set number of times by a write, however many there are', () => {
    const extra = writeOver(200).read - writeOver(100).read
    // Two reads a step: 200 more for 100 more steps. A read per step and earlier step is 30000 more.
    expect(extra).toBeLessThanOrEqual(200)
  })

  it('keep the steps of the write before, so a write of the same steps changes nothing', () => {
    const { before, after } = writeOver(100)
    expect(after.steps).toBe(before.steps)
  })
})
